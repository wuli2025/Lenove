<#
.SYNOPSIS
  活动现场值守用的大厅运维工具：查作品、一键下架 / 恢复、看汇总、导 CSV。

.DESCRIPTION
  五个动作，用 -Action 切换：

    list    列出所有作品（含已下架的），按热度倒序，表格输出
    hide    一键下架（PATCH status=hidden）—— 内容安全应急手段，不做二次确认，输入即执行
    show    恢复上架（PATCH status=public）
    stats   汇总：总作品数 / 总点击 / Top5 / 最近 1 小时新增
    export  导出 CSV（活动后结算与复盘用）

  读数据走 wrangler d1 execute --remote（必须 --remote，否则读的是本地 miniflare 模拟库，
  会看到一个和线上完全无关的"干净世界"）；改状态走线上 PATCH 接口，令牌从 .dev.vars 读。

  关于确认：hide / show 都是可逆操作，且 hide 是应急止血手段，越快越好，所以不设确认。
  只有 export 覆盖已存在的文件时才要求显式加 -Confirm。

.PARAMETER Action
  list | hide | show | stats | export

.PARAMETER Id
  作品 id（hide / show 必填），就是 list 里第一列、也是海报地址 /p/<id> 里的那一段。

.PARAMETER Out
  export 的输出路径。不填则默认当前目录下 hall-export-<时间戳>.csv。

.PARAMETER Confirm
  export 覆盖已有文件时需要显式加上。

.PARAMETER Top
  stats 的排行榜条数，默认 5。

.EXAMPLE
  pwsh -File scripts\hall-ops.ps1 -Action list
.EXAMPLE
  pwsh -File scripts\hall-ops.ps1 -Action hide -Id 3f0a1b2c9d4e
.EXAMPLE
  pwsh -File scripts\hall-ops.ps1 -Action export -Out D:\活动\结算.csv -Confirm
#>

param(
  [Parameter(Mandatory)]
  [ValidateSet('list', 'hide', 'show', 'stats', 'export')]
  [string]$Action,

  [string]$Id,
  [string]$Out,
  [switch]$Confirm,
  [int]$Top    = 5,
  [string]$Base  = 'https://r2t-9f3x.llmwiki.cloud',
  [string]$Proxy = 'auto'
)

. "$PSScriptRoot\_hall-lib.ps1"
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Base = $Base.TrimEnd('/')

# 出错只给一句能看懂的中文，不吐 PowerShell 调用栈
trap {
  Write-Host ''
  Bad "操作失败：$($_.Exception.Message)"
  Write-Host ''
  exit 1
}

$SELECT ='SELECT id, slug, creator, title, tagline, hits, status, created_at FROM works'

<# 取全部作品并算好热度，按热度倒序 #>
function Get-AllWorks {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $rows = Get-D1Rows "$SELECT ORDER BY created_at DESC;"
  return @($rows | ForEach-Object {
      $h = [int]$_.hits
      $c = [long]$_.created_at
      [pscustomobject]@{
        id = $_.id; slug = $_.slug; creator = $_.creator; title = $_.title
        tagline = $_.tagline; hits = $h; status = $_.status; created_at = $c
        heat = [Math]::Round((Get-Heat -Hits $h -CreatedAt $c -Now $now), 3)
      }
    } | Sort-Object -Property heat -Descending)
}

<# 调 PATCH 改状态，附带把改完的结果读回来确认 #>
function Set-WorkStatus {
  param([string]$WorkId, [ValidateSet('public', 'hidden')][string]$Status)

  if ([string]::IsNullOrWhiteSpace($WorkId)) {
    throw "缺少 -Id。先跑一次 -Action list 看第一列拿到作品 id。"
  }
  $token = Get-PublishToken $Root
  $usedProxy = Initialize-HallProxy -Base $Base -Proxy $Proxy
  if ($usedProxy -eq 'FAILED') { throw "连不上 $Base（直连和 127.0.0.1:7897 都不通）。" }

  $tmp = [IO.Path]::GetTempFileName()
  try {
    Write-Utf8NoBom $tmp (@{ status = $Status } | ConvertTo-Json -Compress)
    $r = Invoke-Hall -Url "$Base/api/works/$WorkId" -Method PATCH -BodyFile $tmp `
         -Header @('content-type: application/json', "x-publish-token: $token")
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }

  if (-not $r.Ok) { throw "请求没发出去：$($r.Error)" }
  switch ($r.Status) {
    200 { }
    401 { throw "发布令牌无效。检查 .dev.vars 里的 PUBLISH_TOKEN 和线上 Worker 的 secret 是否一致。" }
    404 { throw "作品 $WorkId 不存在。用 -Action list 确认 id。" }
    default { throw "接口返回 HTTP $($r.Status)：$($r.Body.Trim())" }
  }

  $rows = Get-D1Rows "$SELECT WHERE id = '$WorkId';"
  if (-not $rows.Count) { throw "改完却查不到这条记录（id=$WorkId），请人工核对。" }
  $w = $rows[0]
  $verb = if ($Status -eq 'hidden') { '已下架' } else { '已恢复上架' }
  Good "$verb（$($r.Ms) ms）"
  Info "id      : $($w.id)"
  Info "创作者  : $($w.creator)"
  Info "标题    : $($w.title)"
  Info "当前状态: $($w.status)"
  if ($Status -eq 'hidden') {
    Info "大厅与列表接口会立刻不再返回它；直链 $Base/u/$($w.slug)/ 仍可访问（R2 静态文件不受 status 控制）。"
  }
}

# ───────────────────────── 动作分发 ─────────────────────────

switch ($Action) {

  'list' {
    Head '全部作品（按热度倒序，含已下架）'
    $all = Get-AllWorks
    if (-not $all.Count) {
      Warn '大厅里一个作品都没有。先跑：pwsh -File scripts\seed-hall.ps1'
      break
    }
    $i = 0
    $view = $all | ForEach-Object {
      $i++
      [pscustomobject]@{
        '#'      = $i
        'id'     = $_.id
        '创作者' = $_.creator
        '标题'   = $_.title
        '点击'   = $_.hits
        '热度'   = $_.heat
        '状态'   = $(if ($_.status -eq 'public') { '上架' } else { '已下架' })
        '创建时间' = (Format-Ts $_.created_at)
      }
    }
    $view | Format-Table -AutoSize | Out-String -Width 220 | Write-Host
    Info "共 $($all.Count) 件，其中已下架 $(@($all | Where-Object status -ne 'public').Count) 件"
  }

  'hide' {
    Head '应急下架'
    Set-WorkStatus -WorkId $Id -Status 'hidden'
  }

  'show' {
    Head '恢复上架'
    Set-WorkStatus -WorkId $Id -Status 'public'
  }

  'stats' {
    Head '大厅汇总'
    $all = Get-AllWorks
    if (-not $all.Count) { Warn '还没有任何作品。'; break }

    $now      = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $pub      = @($all | Where-Object status -eq 'public')
    $hidden   = @($all | Where-Object status -ne 'public')
    $totalHit = ($all | Measure-Object -Property hits -Sum).Sum
    $lastHour = @($all | Where-Object { $_.created_at -gt ($now - 3600000) })
    $creators = @($all | Select-Object -ExpandProperty creator -Unique)

    Info "作品总数    : $($all.Count)   （上架 $($pub.Count) / 已下架 $($hidden.Count)）"
    Info "创作者人数  : $($creators.Count)"
    Info "总点击      : $totalHit"
    Info "人均点击    : $(if ($all.Count) { [Math]::Round($totalHit / $all.Count, 1) } else { 0 })"
    Info "最近 1 小时新增作品: $($lastHour.Count)"
    if ($lastHour.Count) {
      $lastHour | Sort-Object created_at -Descending | ForEach-Object {
        Info "    $(Format-Ts $_.created_at)  $($_.creator) · $($_.title)"
      }
    }

    Write-Host ''
    Write-Host "   Top $Top（按热度）" -ForegroundColor Cyan
    $rank = 0
    $topRows = $pub | Select-Object -First $Top | ForEach-Object {
      $rank++
      [pscustomobject]@{
        '名次' = $rank; '创作者' = $_.creator; '标题' = $_.title
        '点击' = $_.hits; '热度' = $_.heat; '海报' = "$Base/p/$($_.id)"
      }
    }
    $topRows | Format-Table -AutoSize | Out-String -Width 220 | Write-Host
  }

  'export' {
    Head '导出 CSV'
    if ([string]::IsNullOrWhiteSpace($Out)) {
      $Out = Join-Path (Get-Location) ("hall-export-{0}.csv" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    }
    if ((Test-Path -LiteralPath $Out) -and -not $Confirm) {
      throw "文件已存在：$Out`n   要覆盖请加 -Confirm，或换一个 -Out 路径。"
    }
    $dir = Split-Path -Parent $Out
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

    $all = Get-AllWorks
    $rank = 0
    $rows = $all | ForEach-Object {
      $rank++
      [pscustomobject]@{
        名次     = $rank
        id       = $_.id
        slug     = $_.slug
        创作者   = $_.creator
        标题     = $_.title
        亮点     = $_.tagline
        点击     = $_.hits
        热度     = $_.heat
        状态     = $_.status
        创建时间 = (Format-Ts $_.created_at)
        创建时间戳 = $_.created_at
        站点地址 = "$Base/u/$($_.slug)/"
        海报地址 = "$Base/p/$($_.id)"
      }
    }
    # utf8BOM：Excel 双击打开中文才不会乱码
    $rows | Export-Csv -LiteralPath $Out -NoTypeInformation -Encoding utf8BOM
    Good "已导出 $($rows.Count) 条 → $Out"
  }
}
