# 批量上线：把一批已生成好的站点目录并发推上大厅。
#
# 为什么要并发：单站上线 = 建记录(1 次 POST) + 逐文件 PUT，网络往返占了绝大部分时间，
# CPU 几乎不动。串行推 5 个站是纯粹的等待叠加；并发之后总耗时≈最慢的那一个。
#
# 走的是 yiju-publish，也就是桌面端「推上线」按钮同一条 mica::publish 链路
# （姓名闸 → 建记录 → R2 上传 → 失败自动隐藏回滚），不是另写的一套 HTTP 脚本——
# 脚本跑通但按钮跑不通，那种"绿灯"没有意义。
#
# 用法：
#   pwsh -File publish-all.ps1 -Root 'C:\Users\mi\Desktop\一句话生成_压测产物'
#   pwsh -File publish-all.ps1 -Root ... -BaseUrl https://make.llmwiki.cloud -Only cafe,wedding
#
# 令牌来源（按优先级）：-Token 参数 > 环境变量 MICA_PUBLISH_TOKEN > r2-sites/.dev.vars
# 源码里不留任何凭据。

param(
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$BaseUrl = 'https://make.llmwiki.cloud',
  [string]$Token = '',
  [string[]]$Only = @(),
  [string]$Exe = 'D:\polaris\个人网站创作平台\youxi\target\release\yiju-publish.exe',
  [string]$DevVars = 'D:\polaris\个人网站创作平台\r2-sites\.dev.vars',
  [int]$TimeoutSec = 600
)
$ErrorActionPreference = 'Stop'

# ── 凭据 ──────────────────────────────────────────────────────────
if (-not $Token) { $Token = $env:MICA_PUBLISH_TOKEN }
if (-not $Token -and (Test-Path $DevVars)) {
  $Token = (((Get-Content $DevVars -Raw) -split "`n" |
             Where-Object { $_ -match '^PUBLISH_TOKEN=' }) -replace '^PUBLISH_TOKEN=', '').Trim()
}
if (-not $Token) { throw "没有发布令牌：给 -Token，或设 MICA_PUBLISH_TOKEN，或让 $DevVars 里有 PUBLISH_TOKEN" }
if (-not (Test-Path $Exe)) { throw "找不到 $Exe —— 先 cargo build -p yiju-desktop --bin yiju-publish --release" }

# ── 预检：大厅活着再动手 ──────────────────────────────────────────
# 5 个站各自跑到一半才发现大厅是 502，比一开始就停下来糟得多
try {
  $h = Invoke-RestMethod "$BaseUrl/api/health" -TimeoutSec 20
  if (-not $h.ok) { throw "健康检查返回 ok=false" }
} catch { throw "大厅不可用（$BaseUrl）：$($_.Exception.Message)" }
Write-Host "大厅就绪 $BaseUrl" -ForegroundColor Green

# ── 挑目录 ────────────────────────────────────────────────────────
# 只认直接含 index.html 的子目录；_reqs、_v1_* 这种辅助目录自动排除
$dirs = Get-ChildItem $Root -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName 'index.html') } |
        Where-Object { $_.Name -notmatch '^_' }
if (-not $dirs) { throw "在 $Root 下没找到任何含 index.html 的站点目录" }

# 用 `pwsh -File` 调的时候，`-Only a,b,c` 会整串塞进一个元素里（-File 只传字符串，
# 不做数组绑定）。不摊平的话 -contains 永远不命中，而报错信息会误导成"没找到目录"。
$only = @($Only) | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($only.Count) {
  $picked = $dirs | Where-Object { $only -contains $_.Name }
  if (-not $picked) {
    throw "-Only 指定的 [$($only -join ', ')] 在 $Root 下一个都没匹配上；现有的是：$((($dirs).Name) -join '、')"
  }
  $dirs = $picked
}
Write-Host "待上线 $($dirs.Count) 个：$(($dirs.Name) -join '、')`n"

# ── 并发上线 ──────────────────────────────────────────────────────
$sw = [Diagnostics.Stopwatch]::StartNew()
$jobs = foreach ($d in $dirs) {
  # 标题优先取生成结果里的真实标题（模型可能在骨架阶段改过），回落目录名
  $rj = Join-Path $Root "$($d.Name).result.json"
  $title = $d.Name; $tagline = ''
  if (Test-Path $rj) {
    try {
      $r = Get-Content $rj -Raw | ConvertFrom-Json
      if ($r.title)   { $title   = $r.title }
      if ($r.tagline) { $tagline = $r.tagline }
    } catch { }
  }
  Start-Job -Name $d.Name -ScriptBlock {
    param($exe, $dir, $title, $tagline, $base, $token, $out)
    $env:MICA_PUBLISH_BASE_URL = $base
    $env:MICA_PUBLISH_TOKEN    = $token
    $a = @('--dir', $dir, '--title', $title, '--json-out', $out)
    if ($tagline) { $a += @('--tagline', $tagline) }
    & $exe @a 2>&1 | Out-String
  } -ArgumentList $Exe, $d.FullName, $title, $tagline, $BaseUrl, $Token, (Join-Path $Root "$($d.Name).publish.json")
}

$null = Wait-Job $jobs -Timeout $TimeoutSec
$sw.Stop()

# ── 汇总 ──────────────────────────────────────────────────────────
$rows = foreach ($j in $jobs) {
  $pj = Join-Path $Root "$($j.Name).publish.json"
  if (Test-Path $pj) {
    $r = Get-Content $pj -Raw | ConvertFrom-Json
    [pscustomobject]@{
      站点 = $j.Name; 结果 = $(if ($r.ok) { 'OK' } else { '失败' })
      秒 = [math]::Round($r.elapsedMs / 1000, 1); 文件数 = $r.uploadedFiles
      通道 = $r.uploadMode; 网址 = $(if ($r.ok) { $r.siteUrl } else { $r.error })
    }
  } else {
    [pscustomobject]@{ 站点 = $j.Name; 结果 = "没产出结果（state=$($j.State)）"; 网址 = (Receive-Job $j -ErrorAction SilentlyContinue | Out-String).Trim() }
  }
}
Get-Job | Remove-Job -Force

$rows | Format-Table -AutoSize -Wrap
$ok = @($rows | Where-Object { $_.结果 -eq 'OK' }).Count
Write-Host "`n上线 $ok/$($rows.Count) 成功，总耗时 $([math]::Round($sw.Elapsed.TotalSeconds,1))s（并发，非累加）" -ForegroundColor $(if ($ok -eq $rows.Count) { 'Green' } else { 'Yellow' })
Write-Host "大厅 $BaseUrl/"
if ($ok -lt $rows.Count) { exit 1 }
