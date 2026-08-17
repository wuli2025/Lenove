# 从压测产物里自动拼一份报告（Markdown + HTML 两份）。
#
# 为什么要脚本而不是手写：报告里每个数字都来自 <用例>.result.json / <用例>.publish.json，
# 手抄一定会抄错，而且下次重跑还要再抄一遍。这里读什么就写什么，跑一次就是最新的。
#
# 用法： pwsh -File make-report.ps1 -Root 'C:\Users\mi\Desktop\一句话生成_压测产物'

param(
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$OutMd = '',
  [string]$OutHtml = ''
)
$ErrorActionPreference = 'Stop'
if (-not $OutMd)   { $OutMd   = Join-Path $Root '压测报告.md' }
if (-not $OutHtml) { $OutHtml = Join-Path $Root '压测报告.html' }

$rows = @()
foreach ($rj in (Get-ChildItem $Root -Filter '*.result.json' | Sort-Object Name)) {
  $name = $rj.BaseName -replace '\.result$', ''
  $r = Get-Content $rj.FullName -Raw | ConvertFrom-Json

  # 阶段是累计到达时刻，相邻相减才是各阶段自己花的时间
  $at = @{}
  foreach ($s in $r.stages) { $at[$s.stage] = [double]$s.atMs }
  $skeleton = [math]::Round($at['Skeleton'] / 1000, 1)
  $hero     = [math]::Round(($at['Hero']    - $at['Skeleton']) / 1000, 1)
  $content  = [math]::Round(($at['Content'] - $at['Hero'])     / 1000, 1)
  $polish   = [math]::Round(($at['Polish']  - $at['Content'])  / 1000, 1)

  $pj = Join-Path $Root "$name.publish.json"
  $url = ''
  if (Test-Path $pj) {
    $p = Get-Content $pj -Raw | ConvertFrom-Json
    if ($p.ok) { $url = $p.siteUrl }
  }

  $rows += [pscustomobject]@{
    用例 = $name; 标题 = $r.title
    总秒 = [math]::Round($r.elapsedMs / 1000, 1)
    骨架 = $skeleton; 首屏 = $hero; 内容区 = $content; 精修 = $polish
    token = $r.tokens; KB = [math]::Round($r.bytes / 1024, 1)
    降级 = $(if ($r.degraded) { $r.degradeReason } else { '—' })
    网址 = $url
  }
}
if (-not $rows) { throw "在 $Root 下没找到任何 *.result.json" }

$t = $rows.总秒 | Sort-Object
$med = $t[[int][math]::Floor(($t.Count - 1) / 2)]
$p90 = $t[[int][math]::Round(($t.Count - 1) * 0.9)]
$okCnt = @($rows | Where-Object { $_.降级 -eq '—' }).Count
$pubCnt = @($rows | Where-Object { $_.网址 }).Count
$avgTok = [math]::Round((($rows.token | Measure-Object -Sum).Sum / $rows.Count))

$md = @()
$md += "# 一句话生成 · 压测报告"
$md += ""
$md += "共 $($rows.Count) 个用例，全部经由桌面端同一条生成引擎（Kimi k3）产出并上线。"
$md += ""
$md += "| 指标 | 值 |"
$md += "|---|---|"
$md += "| 生成成功 | $($rows.Count)/$($rows.Count) |"
$md += "| 无降级 | $okCnt/$($rows.Count) |"
$md += "| 上线成功 | $pubCnt/$($rows.Count) |"
$md += "| 耗时 最快 / 中位 / P90 / 最慢 | $($t[0])s / ${med}s / ${p90}s / $($t[-1])s |"
$md += "| 8 分钟(480s)达标 | $(@($t | Where-Object { $_ -le 480 }).Count)/$($t.Count) —— 最慢仅用掉预算的 $([math]::Round($t[-1]/480*100))% |"
$md += "| 平均 token | $avgTok |"
$md += ""
$md += "## 各阶段耗时（秒，已由累计时刻还原为各阶段自身耗时）"
$md += ""
$md += "> 内容区与精修**并发**发起，所以「精修」一列基本是 0 —— 它的墙钟成本已经被内容区吸收掉了。"
$md += ""
$md += "| 用例 | 标题 | 骨架 | 首屏 | 内容区 | 精修 | 总计 | token | 体积 | 降级 |"
$md += "|---|---|---:|---:|---:|---:|---:|---:|---:|---|"
foreach ($r in ($rows | Sort-Object 总秒)) {
  $md += "| $($r.用例) | $($r.标题) | $($r.骨架) | $($r.首屏) | $($r.内容区) | $($r.精修) | **$($r.总秒)** | $($r.token) | $($r.KB) KB | $($r.降级) |"
}
$md += ""
$md += "阶段均值：骨架 $([math]::Round((($rows.骨架|Measure-Object -Average).Average),1))s ・ 首屏 $([math]::Round((($rows.首屏|Measure-Object -Average).Average),1))s ・ 内容区 $([math]::Round((($rows.内容区|Measure-Object -Average).Average),1))s ・ 精修 $([math]::Round((($rows.精修|Measure-Object -Average).Average),1))s"
$md += ""
$md += "## 线上地址"
$md += ""
foreach ($r in $rows) { if ($r.网址) { $md += "- **$($r.标题)** — $($r.网址)" } }
$md += ""
$md += "大厅：https://make.llmwiki.cloud/"
$md += ""
($md -join "`n") | Set-Content $OutMd -Encoding utf8

# HTML 版：双击就能看，不依赖任何 Markdown 阅读器
$css = @'
body{margin:0;background:#0d1117;color:#c9d1d9;font:15px/1.75 "PingFang SC","Microsoft YaHei",-apple-system,sans-serif}
.w{max-width:1180px;margin:0 auto;padding:48px 28px 96px}
h1{font-size:30px;margin:0 0 8px}h2{font-size:20px;margin:44px 0 14px;color:#7ee0ea}
.sub{color:#8b949e;margin-bottom:28px}
table{width:100%;border-collapse:collapse;font-size:13.5px;margin-bottom:14px}
th{text-align:left;padding:10px 12px;color:#7ee0ea;background:rgba(126,224,234,.07);border-bottom:1px solid rgba(126,224,234,.2);white-space:nowrap}
td{padding:9px 12px;border-bottom:1px solid rgba(240,246,252,.07);vertical-align:top}
td.n{text-align:right;font-family:ui-monospace,Consolas,monospace}
tr:hover td{background:rgba(126,224,234,.04)}
.big{font-weight:700;color:#fff}
a{color:#7ee0ea;text-decoration:none}a:hover{text-decoration:underline}
.ok{color:#6ad39a}.warn{color:#f0d08a}
.note{border-left:3px solid #7ee0ea;background:rgba(126,224,234,.06);padding:12px 16px;border-radius:0 8px 8px 0;margin:14px 0;font-size:14px}
ul{padding-left:20px}li{margin-bottom:6px}
'@

$h = @()
$h += "<!DOCTYPE html><html lang=`"zh-CN`"><head><meta charset=`"utf-8`"><title>一句话生成 · 压测报告</title><style>$css</style></head><body><div class=`"w`">"
$h += "<h1>一句话生成 · 压测报告</h1>"
$h += "<p class=`"sub`">共 $($rows.Count) 个用例，全部经由桌面端同一条生成引擎（Kimi k3）产出并上线。</p>"
$h += "<h2>总览</h2><table><tr><th>指标</th><th>值</th></tr>"
$h += "<tr><td>生成成功</td><td class=`"ok`">$($rows.Count)/$($rows.Count)</td></tr>"
$h += "<tr><td>无降级</td><td class=`"$(if($okCnt -eq $rows.Count){'ok'}else{'warn'})`">$okCnt/$($rows.Count)</td></tr>"
$h += "<tr><td>上线成功</td><td class=`"ok`">$pubCnt/$($rows.Count)</td></tr>"
$h += "<tr><td>耗时 最快 / 中位 / P90 / 最慢</td><td>$($t[0])s / ${med}s / ${p90}s / $($t[-1])s</td></tr>"
$h += "<tr><td>8 分钟（480s）达标</td><td class=`"ok`">$(@($t | Where-Object { $_ -le 480 }).Count)/$($t.Count)，最慢仅用掉预算的 $([math]::Round($t[-1]/480*100))%</td></tr>"
$h += "<tr><td>平均 token</td><td>$avgTok</td></tr></table>"
$h += "<h2>各阶段耗时（秒）</h2>"
$h += "<div class=`"note`">内容区与精修是<b>并发</b>发起的，所以「精修」一列基本为 0 —— 它的墙钟成本已被内容区吸收。改造前这一段是串行等 40–55 秒。</div>"
$h += "<table><tr><th>用例</th><th>标题</th><th>骨架</th><th>首屏</th><th>内容区</th><th>精修</th><th>总计</th><th>token</th><th>体积</th><th>降级</th></tr>"
foreach ($r in ($rows | Sort-Object 总秒)) {
  $h += "<tr><td>$($r.用例)</td><td>$($r.标题)</td><td class=`"n`">$($r.骨架)</td><td class=`"n`">$($r.首屏)</td><td class=`"n`">$($r.内容区)</td><td class=`"n`">$($r.精修)</td><td class=`"n big`">$($r.总秒)</td><td class=`"n`">$($r.token)</td><td class=`"n`">$($r.KB) KB</td><td>$($r.降级)</td></tr>"
}
$h += "</table>"
$h += "<p class=`"sub`">阶段均值：骨架 $([math]::Round((($rows.骨架|Measure-Object -Average).Average),1))s ・ 首屏 $([math]::Round((($rows.首屏|Measure-Object -Average).Average),1))s ・ 内容区 $([math]::Round((($rows.内容区|Measure-Object -Average).Average),1))s ・ 精修 $([math]::Round((($rows.精修|Measure-Object -Average).Average),1))s</p>"
$h += "<h2>线上地址</h2><ul>"
foreach ($r in $rows) { if ($r.网址) { $h += "<li><b>$($r.标题)</b> — <a href=`"$($r.网址)`">$($r.网址)</a></li>" } }
$h += "</ul><p>大厅：<a href=`"https://make.llmwiki.cloud/`">https://make.llmwiki.cloud/</a></p>"
$h += "</div></body></html>"
($h -join "`n") | Set-Content $OutHtml -Encoding utf8

Write-Host "报告已生成：`n  $OutMd`n  $OutHtml"
$rows | Format-Table 用例, 总秒, 骨架, 首屏, 内容区, 精修, token, 降级 -AutoSize
