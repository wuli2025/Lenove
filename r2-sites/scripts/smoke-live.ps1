<#
.SYNOPSIS
  开场前的 60 秒线上体检：把观众会走到的每条路径都真跑一遍，并打印耗时。

.DESCRIPTION
  依次验证 8 项，每项打印 PASS/FAIL + 毫秒耗时：

    1  /api/health                健康检查通
    2  /                          大厅页 200，且真的渲染出了作品卡（不是"大厅还空着"）
    3  /api/works                 列表接口 200 且有数据，顺手随机抽一个作品做后续用例
    4  /u/<slug>/                 随机作品的站点页打得开
    5  /p/<id>                    海报页打得开
    6  /p/<id>.svg                返回 image/svg+xml
    7  /qr?d=...                  二维码返回 SVG
    8  POST /api/works（错令牌）  必须返回 401

  耗时是这套脚本的重点：现场网络一慢，光看 PASS/FAIL 看不出问题，看毫秒数一眼就知道
  是网络慢、Worker 冷启动慢、还是 D1 慢。

  任何一项 FAIL 都会以 exit 1 结束，方便挂在开场前的检查流程里。

.PARAMETER Base
  线上地址，默认 https://r2t-9f3x.llmwiki.cloud

.PARAMETER Proxy
  auto（默认，先直连不通再试 127.0.0.1:7897）/ none / 具体的 http://host:port

.PARAMETER Repeat
  整套体检重复跑几遍，默认 1。想看耗时抖动就 -Repeat 3。

.EXAMPLE
  pwsh -File scripts\smoke-live.ps1
.EXAMPLE
  pwsh -File scripts\smoke-live.ps1 -Proxy http://127.0.0.1:7897 -Repeat 3
#>

param(
  [string]$Base  = 'https://r2t-9f3x.llmwiki.cloud',
  [string]$Proxy = 'auto',
  [int]$Repeat   = 1
)

. "$PSScriptRoot\_hall-lib.ps1"
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Base = $Base.TrimEnd('/')

# 出错只给一句能看懂的中文，不吐 PowerShell 调用栈
trap {
  Write-Host ''
  Bad "体检中断：$($_.Exception.Message)"
  Write-Host ''
  exit 1
}

$script:Checks = @()

<# 记录并即时打印一项检查结果 #>
function Add-Check {
  param([string]$Name, [bool]$Pass, [int]$Ms, [string]$Note = '')
  $script:Checks += [pscustomobject]@{ 项目 = $Name; 通过 = $Pass; 耗时ms = $Ms; 说明 = $Note }
  $badge = if ($Pass) { 'PASS' } else { 'FAIL' }
  $color = if ($Pass) { 'Green' } else { 'Red' }
  Write-Host ("   {0}  {1,6} ms  {2}  {3}" -f $badge, $Ms, (PadDisp $Name 24), $Note) -ForegroundColor $color
}

Head "线上体检 · $Base"

$token = $null
try { $token = Get-PublishToken $Root } catch { Warn $_.Exception.Message }

$usedProxy = Initialize-HallProxy -Base $Base -Proxy $Proxy
if ($usedProxy -eq 'FAILED') {
  Bad "直连和代理 127.0.0.1:7897 都连不上 $Base。"
  Bad '先确认：代理节点是否正常、Worker 是否还在线（wrangler deployments list）。'
  exit 1
}
if ($usedProxy) { Info "通路：代理 $usedProxy" } else { Info '通路：直连' }

for ($round = 1; $round -le $Repeat; $round++) {
  if ($Repeat -gt 1) { Head "第 $round / $Repeat 轮" } else { Write-Host '' }

  # ── 1 健康检查 ──
  $r = Invoke-Hall -Url "$Base/api/health" -TimeoutSec 15
  $pass = $r.Ok -and $r.Status -eq 200 -and $r.Body -match '"ok"\s*:\s*true'
  Add-Check '1 /api/health' $pass $r.Ms $(if ($pass) { 'ok:true' } else { "HTTP $($r.Status) $($r.Error)" })

  # ── 2 大厅页 ──
  $r = Invoke-Hall -Url "$Base/" -TimeoutSec 20
  $cards = 0
  if ($r.Body) { $cards = ([regex]::Matches($r.Body, 'class="c(?: big)?"')).Count }
  $empty = $r.Body -match 'class="empty"'
  $pass = $r.Ok -and $r.Status -eq 200 -and $cards -gt 0 -and -not $empty
  $note = if ($empty) { '大厅是空的！开场前先跑 seed-hall.ps1' }
          elseif ($pass) { "HTTP 200，$cards 张作品卡，$([Math]::Round($r.Body.Length/1024,1)) KB" }
          else { "HTTP $($r.Status)，作品卡 $cards 张 $($r.Error)" }
  Add-Check '2 大厅页 /' $pass $r.Ms $note

  # ── 3 列表接口（顺手抽样） ──
  $r = Invoke-Hall -Url "$Base/api/works?limit=60" -TimeoutSec 20
  $sample = $null
  $total = 0
  if ($r.Ok -and $r.Status -eq 200) {
    try {
      $data = $r.Body | ConvertFrom-Json
      $total = [int]$data.total
      if ($data.works -and $data.works.Count) { $sample = $data.works | Get-Random }
    } catch { }
  }
  $pass = $null -ne $sample
  Add-Check '3 /api/works' $pass $r.Ms $(if ($pass) { "total=$total，抽中 $($sample.creator) · $($sample.title)" } else { "HTTP $($r.Status)，没拿到任何作品 $($r.Error)" })

  if (-not $sample) {
    Bad '没有可用作品，后面 4-7 项无法进行。先跑 seed-hall.ps1 种入样例。'
    break
  }

  # ── 4 用户站点 ──
  $r = Invoke-Hall -Url "$Base/u/$($sample.slug)/" -TimeoutSec 20
  $pass = $r.Ok -and $r.Status -eq 200 -and $r.ContentType -match 'text/html'
  Add-Check '4 /u/<slug>/' $pass $r.Ms $(if ($pass) { "$($sample.slug)  $([Math]::Round($r.Body.Length/1024,1)) KB" } else { "HTTP $($r.Status)，站点页面可能没传到 R2（记得 --remote） $($r.Error)" })

  # ── 5 海报页 ──
  $r = Invoke-Hall -Url "$Base/p/$($sample.id)" -TimeoutSec 20
  $pass = $r.Ok -and $r.Status -eq 200 -and $r.ContentType -match 'text/html'
  Add-Check '5 /p/<id> 海报页' $pass $r.Ms $(if ($pass) { "$($sample.id)" } else { "HTTP $($r.Status) $($r.Error)" })

  # ── 6 海报 SVG ──
  $r = Invoke-Hall -Url "$Base/p/$($sample.id).svg" -TimeoutSec 25
  $pass = $r.Ok -and $r.Status -eq 200 -and $r.ContentType -match 'image/svg\+xml' -and $r.Body -match '<svg'
  Add-Check '6 /p/<id>.svg' $pass $r.Ms $(if ($pass) { "$($r.ContentType)，$([Math]::Round($r.Body.Length/1024,1)) KB" } else { "HTTP $($r.Status)，Content-Type=$($r.ContentType) $($r.Error)" })

  # ── 7 二维码 ──
  $qrTarget = [uri]::EscapeDataString("$Base/u/$($sample.slug)/")
  $r = Invoke-Hall -Url "$Base/qr?d=$qrTarget&s=240" -TimeoutSec 20
  $pass = $r.Ok -and $r.Status -eq 200 -and $r.ContentType -match 'image/svg\+xml' -and $r.Body -match '<svg'
  Add-Check '7 /qr 二维码' $pass $r.Ms $(if ($pass) { "$([Math]::Round($r.Body.Length/1024,1)) KB" } else { "HTTP $($r.Status)，Content-Type=$($r.ContentType) $($r.Error)" })

  # ── 8 错误令牌必须 401 ──
  $tmp = [IO.Path]::GetTempFileName()
  try {
    Write-Utf8NoBom $tmp (@{ creator = '体检机器人'; title = '这条不该被创建' } | ConvertTo-Json -Compress)
    $r = Invoke-Hall -Url "$Base/api/works" -Method POST -BodyFile $tmp `
         -Header @('content-type: application/json', 'x-publish-token: definitely-a-wrong-token')
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
  $pass = $r.Ok -and $r.Status -eq 401
  Add-Check '8 错令牌发布应 401' $pass $r.Ms $(if ($pass) { '已正确拒绝' } else { "返回 HTTP $($r.Status)（危险：发布接口没有拦住） $($r.Error)" })
}

# ───────────────────────── 总结 ─────────────────────────

Head '总结'
$fail = @($script:Checks | Where-Object { -not $_.通过 })
$msList = @($script:Checks | Select-Object -ExpandProperty 耗时ms | Where-Object { $_ -gt 0 })
$avg = if ($msList.Count) { [Math]::Round(($msList | Measure-Object -Average).Average) } else { 0 }
$max = if ($msList.Count) { ($msList | Measure-Object -Maximum).Maximum } else { 0 }

Info "检查项 $($script:Checks.Count) 项，通过 $($script:Checks.Count - $fail.Count) 项，失败 $($fail.Count) 项"
Info "平均耗时 $avg ms，最慢 $max ms"
if ($max -gt 3000) { Warn '有请求超过 3 秒，现场网络或 Worker 冷启动偏慢，开场前建议先手动预热几次。' }

if ($fail.Count) {
  Write-Host ''
  Bad '以下项目未通过：'
  $fail | ForEach-Object { Bad "  - $($_.项目)：$($_.说明)" }
  exit 1
}

Good '全部通过，可以开场。'
exit 0
