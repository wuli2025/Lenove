<#
.SYNOPSIS
  作品大厅现场运维脚本 —— 公共库（不单独执行，用点源方式引入）。

.DESCRIPTION
  被 seed-hall.ps1 / hall-ops.ps1 / smoke-live.ps1 共同引用，集中处理三件容易出错的事：

  1. 发布令牌一律从项目根目录的 .dev.vars 读（PUBLISH_TOKEN=xxx），脚本里不硬编码。
  2. 本机走 Clash，到 Cloudflare 可能需要代理。默认自动探测：先直连，不通再试 127.0.0.1:7897。
  3. wrangler 4.90 的 r2 object put/get 和 d1 execute 默认操作【本地 miniflare 模拟存储】，
     不加 --remote 就是"看起来成功、线上什么都没有"。本库封装的所有 wrangler 调用强制带 --remote。

  另外统一了 HTTP 调用：每次请求都返回状态码、耗时(ms)、Content-Type 和响应体，
  现场网络慢的时候耗时数字最能说明问题。

.NOTES
  用法： . "$PSScriptRoot\_hall-lib.ps1"
#>

$ErrorActionPreference = 'Stop'
# PowerShell 7.4 起原生命令非零退出码可能直接抛异常，这里关掉，由脚本自己判断退出码
$PSNativeCommandUseErrorActionPreference = $false
$env:WRANGLER_SEND_METRICS = 'false'

# 当前生效的代理（$null = 直连），由 Initialize-HallProxy 设置
$script:HallProxy = $null

# curl 常见退出码 → 中文说明，避免现场看到一串英文
$script:CurlErrMap = @{
  5  = '代理服务器地址无法解析'
  6  = 'DNS 解析失败（本机 Clash fake-ip 时常见，可试 -Proxy http://127.0.0.1:7897）'
  7  = '连不上服务器（代理没开？端口不对？）'
  28 = '请求超时'
  35 = 'TLS 握手失败'
  52 = '服务端没有返回任何内容'
  56 = '连接被对端重置'
  60 = '证书校验失败'
}

# ───────────────────────── 输出小工具 ─────────────────────────

function Head([string]$t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }
function Info([string]$t) { Write-Host "   $t" -ForegroundColor Gray }
function Good([string]$t) { Write-Host "   $t" -ForegroundColor Green }
function Warn([string]$t) { Write-Host "   $t" -ForegroundColor Yellow }
function Bad ([string]$t) { Write-Host "   $t" -ForegroundColor Red }

# UTF-8 无 BOM 写文件（临时 JSON / HTML 都用它，避免 BOM 把 JSON 解析搞挂）
function Write-Utf8NoBom([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

# 中日韩字符在终端里占两格，直接用 -f 的 {0,-20} 补空格会歪。这两个函数按显示宽度对齐。
function Get-DisplayWidth([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return 0 }
  $w = 0
  foreach ($ch in $s.ToCharArray()) {
    $c = [int]$ch
    if (($c -ge 0x1100 -and $c -le 0x115F) -or ($c -ge 0x2E80 -and $c -le 0xA4CF) -or
        ($c -ge 0xAC00 -and $c -le 0xD7A3) -or ($c -ge 0xF900 -and $c -le 0xFAFF) -or
        ($c -ge 0xFE30 -and $c -le 0xFE6F) -or ($c -ge 0xFF00 -and $c -le 0xFF60) -or
        ($c -ge 0xFFE0 -and $c -le 0xFFE6)) { $w += 2 } else { $w += 1 }
  }
  return $w
}

function PadDisp([string]$s, [int]$Width) {
  $pad = $Width - (Get-DisplayWidth $s)
  if ($pad -gt 0) { return $s + (' ' * $pad) }
  return $s
}

function Esc([string]$s) {
  if ($null -eq $s) { return '' }
  $s.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;')
}

# ───────────────────────── 令牌 ─────────────────────────

<#
  从 <项目根>/.dev.vars 读发布令牌。找不到就给出明确的中文指引，不要让现场的人去猜。
#>
function Get-PublishToken([string]$Root) {
  $f = Join-Path $Root '.dev.vars'
  if (-not (Test-Path -LiteralPath $f)) {
    throw "找不到令牌文件：$f`n   发布令牌必须写在 .dev.vars 里（一行 PUBLISH_TOKEN=xxx），脚本不硬编码。"
  }
  foreach ($line in (Get-Content -LiteralPath $f)) {
    if ($line -match '^\s*PUBLISH_TOKEN\s*=\s*(.+?)\s*$') {
      return $Matches[1].Trim().Trim('"').Trim("'")
    }
  }
  throw "$f 里没有 PUBLISH_TOKEN=... 这一行，无法调用发布接口。"
}

# ───────────────────────── HTTP ─────────────────────────

<#
  统一的 HTTP 调用。返回对象：
    Ok          curl 本身是否成功（不代表 HTTP 200）
    Status      HTTP 状态码
    Ms          总耗时（毫秒）
    ContentType 响应 Content-Type
    Body        响应体文本
    Error       失败原因（中文）
#>
function Invoke-Hall {
  param(
    [Parameter(Mandatory)][string]$Url,
    [string]$Method = 'GET',
    [string[]]$Header = @(),
    [string]$BodyFile,
    [int]$TimeoutSec = 25
  )
  $tmp = [IO.Path]::GetTempFileName()
  try {
    # 用 -s（全静默）而不是 -sS：让 stdout 只剩 -w 那一行，解析不会被 stderr 污染
    $ca = @('-s', '--max-time', "$TimeoutSec", '-o', $tmp, '-w', '%{http_code}|%{time_total}|%{content_type}')
    if ($Method -ne 'GET') { $ca += @('-X', $Method) }
    foreach ($h in $Header) { $ca += @('-H', $h) }
    if ($BodyFile) { $ca += @('--data-binary', "@$BodyFile") }
    if ($script:HallProxy) { $ca += @('-x', $script:HallProxy) }
    $ca += $Url

    $line = (& curl.exe @ca) -join ''
    $rc = $LASTEXITCODE
    $body = ''
    if (Test-Path -LiteralPath $tmp) { $body = [IO.File]::ReadAllText($tmp, [Text.Encoding]::UTF8) }

    if ($rc -ne 0 -or $line -notmatch '^(\d{3})\|([\d.]+)\|(.*)$') {
      $why = $script:CurlErrMap[$rc]
      if (-not $why) { $why = "curl 退出码 $rc" }
      return [pscustomobject]@{ Ok = $false; Status = 0; Ms = 0; ContentType = ''; Body = $body; Error = $why }
    }
    return [pscustomobject]@{
      Ok          = $true
      Status      = [int]$Matches[1]
      Ms          = [int][math]::Round([double]$Matches[2] * 1000)
      ContentType = $Matches[3]
      Body        = $body
      Error       = $null
    }
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

<#
  代理策略：
    -Proxy auto （默认）先直连探 /api/health，通就直连；不通再试 http://127.0.0.1:7897
    -Proxy none 强制直连
    -Proxy http://host:port 强制指定
  返回实际使用的代理字符串，直连返回 $null，两条路都不通返回 'FAILED'。
#>
function Initialize-HallProxy {
  param([Parameter(Mandatory)][string]$Base, [string]$Proxy = 'auto')

  if ($Proxy -eq 'none' -or [string]::IsNullOrWhiteSpace($Proxy)) { $script:HallProxy = $null; return $null }
  if ($Proxy -ne 'auto') { $script:HallProxy = $Proxy; return $Proxy }

  $script:HallProxy = $null
  $r = Invoke-Hall -Url "$Base/api/health" -TimeoutSec 8
  if ($r.Ok -and $r.Status -eq 200) { return $null }

  $script:HallProxy = 'http://127.0.0.1:7897'
  $r2 = Invoke-Hall -Url "$Base/api/health" -TimeoutSec 12
  if ($r2.Ok -and $r2.Status -eq 200) { return $script:HallProxy }

  $script:HallProxy = $null
  return 'FAILED'
}

function Get-HallProxy { return $script:HallProxy }

# ───────────────────────── 原生命令 / wrangler ─────────────────────────

<#
  调用外部命令并把 stdout / stderr / 退出码分开拿回来。
  stderr 走临时文件而不是 2>&1，避免 PowerShell 把 stderr 当成异常抛出来。
#>
function Invoke-Native {
  param([Parameter(Mandatory)][string]$Exe, [string[]]$Arguments = @())
  $errFile = [IO.Path]::GetTempFileName()
  try {
    $out = (& $Exe @Arguments 2>$errFile) | Out-String
    $rc = $LASTEXITCODE
    $err = ''
    if (Test-Path -LiteralPath $errFile) { $err = [IO.File]::ReadAllText($errFile, [Text.Encoding]::UTF8) }
    return [pscustomobject]@{ Code = $rc; Out = $out; Err = $err }
  } finally {
    Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
  }
}

<#
  在【云端】D1 上执行 SQL。--remote 是硬性要求，漏了就是在改本地模拟库。
  返回 wrangler --json 解析后的结果数组（元素含 results / success / meta）。
#>
function Invoke-D1 {
  param([Parameter(Mandatory)][string]$Sql, [string]$Database = 'hall')

  $r = Invoke-Native -Exe 'wrangler' -Arguments @('d1', 'execute', $Database, '--remote', '--json', '--command', $Sql)
  $raw = ($r.Out + "`n" + $r.Err)
  if ($r.Code -ne 0) {
    throw "D1 执行失败（退出码 $($r.Code)）。SQL 片段：$($Sql.Substring(0, [Math]::Min(120, $Sql.Length)))`n$($raw.Trim())"
  }
  $s = $raw.IndexOf('[')
  $e = $raw.LastIndexOf(']')
  if ($s -lt 0 -or $e -le $s) {
    throw "D1 没有返回可解析的 JSON。原始输出：`n$($raw.Trim())"
  }
  try {
    return ($raw.Substring($s, $e - $s + 1) | ConvertFrom-Json)
  } catch {
    throw "D1 返回的 JSON 解析失败：$($_.Exception.Message)`n原始输出：`n$($raw.Trim())"
  }
}

<# 便捷：只要第一条语句的 results 行数组 #>
function Get-D1Rows {
  param([Parameter(Mandatory)][string]$Sql, [string]$Database = 'hall')
  $res = Invoke-D1 -Sql $Sql -Database $Database
  if (-not $res -or -not $res[0].results) { return @() }
  return @($res[0].results)
}

<#
  上传对象到【云端】R2。--remote 同样是硬性要求。
#>
function Invoke-R2Put {
  param(
    [Parameter(Mandatory)][string]$Bucket,
    [Parameter(Mandatory)][string]$Key,
    [Parameter(Mandatory)][string]$File,
    [string]$ContentType = 'text/html; charset=utf-8'
  )
  $r = Invoke-Native -Exe 'wrangler' -Arguments @(
    'r2', 'object', 'put', "$Bucket/$Key", '--file', $File, '--content-type', $ContentType, '--remote'
  )
  if ($r.Code -ne 0) {
    throw "R2 上传失败：$Key（退出码 $($r.Code)）`n$(($r.Err + $r.Out).Trim())"
  }
}

# ───────────────────────── 业务小工具 ─────────────────────────

<# 热度 = 点击 / (小时数+2)^1.2，与 src/api.js 的 heat() 保持一致 #>
function Get-Heat {
  param([int]$Hits, [long]$CreatedAt, [long]$Now = 0)
  if ($Now -eq 0) { $Now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  # 注意：不能写 [Math]::Max(0, $hours) —— PowerShell 会挑 Max(int,int) 重载
  # 把小时数截断成整数，算出来的热度会明显偏高，和线上排序对不上。
  [double]$hours = ($Now - $CreatedAt) / 3600000.0
  if ($hours -lt 0) { $hours = 0.0 }
  return $Hits / [Math]::Pow($hours + 2, 1.2)
}

<# 毫秒时间戳 → 本地可读时间 #>
function Format-Ts([long]$Ms) {
  if ($Ms -le 0) { return '' }
  return [DateTimeOffset]::FromUnixTimeMilliseconds($Ms).ToLocalTime().ToString('MM-dd HH:mm:ss')
}

function Now-Ms { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
