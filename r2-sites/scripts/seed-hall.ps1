<#
.SYNOPSIS
  给作品大厅种入 10 个样例作品，解决"活动开场大厅是空的"这个最尴尬的问题。

.DESCRIPTION
  每个样例作品做三件事：
    1. 调 POST /api/works 发布（令牌从 .dev.vars 读），拿到 id 与 slug；
    2. 生成一个真实可访问的深色系单页 index.html，上传到 R2 的 sites/<slug>/index.html
       （wrangler r2 object put 强制带 --remote，否则只写进本地 miniflare，线上是空的）；
    3. 用 wrangler d1 execute --remote 直接改 works.hits 与 created_at，
       让热度榜一开场就有层次。
       —— 为什么不刷 POST /api/works/<id>/hit？因为同一访客 30 分钟内只计一次，刷不上去。

  重复执行是安全的：slug 是固定的，已存在的作品接口会返回 409，脚本会跳过发布、
  但仍然重新上传站点页面并刷新点击数。

.PARAMETER DryRun
  只打印将要做什么（含生成的 HTML 落到本地临时目录供预览），不发任何请求、不写任何数据。

.PARAMETER Base
  线上地址，默认 https://r2t-9f3x.llmwiki.cloud

.PARAMETER Bucket
  R2 桶名，默认 user-sites

.PARAMETER Proxy
  auto（默认，先直连不通再试 127.0.0.1:7897）/ none / 具体的 http://host:port

.PARAMETER SkipHits
  跳过"直接改 hits / created_at"这一步，只发布 + 传页面。

.EXAMPLE
  pwsh -File scripts\seed-hall.ps1 -DryRun
.EXAMPLE
  pwsh -File scripts\seed-hall.ps1
#>

param(
  [switch]$DryRun,
  [string]$Base   = 'https://r2t-9f3x.llmwiki.cloud',
  [string]$Bucket = 'user-sites',
  [string]$Proxy  = 'auto',
  [switch]$SkipHits
)

. "$PSScriptRoot\_hall-lib.ps1"
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Base = $Base.TrimEnd('/')

# 出错只给一句能看懂的中文，不吐 PowerShell 调用栈
trap {
  Write-Host ''
  Bad "种入中断：$($_.Exception.Message)"
  Write-Host ''
  exit 1
}

# ───────────────────────── 样例作品数据 ─────────────────────────
# 题材刻意贴近普通人：这些卡片是给现场观众看的"我也能做"的样板。
# ago = 创建时间往前推的分钟数（让"最新"和"最热"两个榜看起来是真的在长）
# hits = 初始点击数（直接写库，绕开 30 分钟去重）

$Works = @(
  @{
    slug = 'linwanqing-mao'; creator = '林晚晴'; title = '猫咪回忆录'
    tagline = '十七年，一只叫豆沙的橘猫，和它留下的所有毛'
    kick = 'MEMOIR · 2009 — 2026'; accent = 0; hits = 428; ago = 88
    chips = @(@{k='陪伴';v='17 年'}, @{k='照片';v='2140 张'}, @{k='体重巅峰';v='6.8 kg'})
    blocks = @(
      @{h='2009 · 纸箱里的那天'; p='它在小区车棚的纸箱里，只有巴掌大，叫得比谁都凶。我妈说养一周就送走，结果一养十七年。'},
      @{h='每天下午四点'; p='它会准时坐到窗台第三格，等太阳挪过来。那块地板被晒得比别处旧一点，我一直没舍得换。'},
      @{h='2026 · 还没习惯'; p='现在四点我还是会看一眼窗台。这个网站是给它做的，也是给我自己做的。'}
    )
  },
  @{
    slug = 'chenmubai-shixian'; creator = '陈慕白'; title = '给女儿的成长时间线'
    tagline = '从第一声哭到第一次自己系鞋带，我全记下来了'
    kick = 'TIMELINE · 2020 — NOW'; accent = 1; hits = 251; ago = 76
    chips = @(@{k='记录';v='2190 天'}, @{k='里程碑';v='46 个'}, @{k='视频';v='312 段'})
    blocks = @(
      @{h='0 岁 · 抵达'; p='凌晨三点十七分，护士把她抱出来的时候我手抖得连相机都举不稳，第一张照片是糊的，我留着没删。'},
      @{h='3 岁 · 第一句完整的话'; p='"爸爸你别走"。那天我出差的行李箱在门口放了半小时，最后还是走了，但我把这句话录下来了。'},
      @{h='6 岁 · 自己系鞋带'; p='试了十九次。第二十次成功之后她跑遍整个客厅，我在后面追着拍。'}
    )
  },
  @{
    slug = 'zhouye-photo'; creator = '周野'; title = '荒野城市摄影集'
    tagline = '凌晨四点的城市没有人，只有光'
    kick = 'PHOTOGRAPHY · 11 CITIES'; accent = 2; hits = 306; ago = 71
    chips = @(@{k='快门';v='38000 次'}, @{k='城市';v='11 座'}, @{k='最早一张';v='2019'})
    blocks = @(
      @{h='关于这组照片'; p='都是四点到五点半之间拍的。那一个半小时城市是空的，路灯还没关，天已经开始亮，两种光会打架。'},
      @{h='器材与参数'; p='一台二手机身加一支 35mm 定焦，全程手持。ISO 尽量压到 800 以内，宁可欠曝也不想要噪点。'},
      @{h='下一站'; p='想去拍北方的冬天，四点半天还是全黑的，路灯的色温会完全不一样。'}
    )
  },
  @{
    slug = 'suyiran-books'; creator = '苏亦然'; title = '读书笔记站'
    tagline = '读过的每一本都留一段自己的话，不抄书评'
    kick = 'READING NOTES'; accent = 3; hits = 133; ago = 62
    chips = @(@{k='读完';v='128 本'}, @{k='笔记';v='1.2 万字'}, @{k='连续';v='340 天'})
    blocks = @(
      @{h='今年在读'; p='偏爱非虚构和一部分旧小说。读得慢，一本书通常拖两三周，中间会停下来查很多东西。'},
      @{h='我的做法'; p='读完当天必须写满三百字，写不出来就说明没读懂，那本书会重新排回队列。这个规矩坚持了 340 天。'},
      @{h='最近一条笔记'; p='"作者用了整整一章解释一个我以为三行就能说清的问题，读完才知道我原来那三行是错的。"'}
    )
  },
  @{
    slug = 'yehuo-tour'; creator = '野火乐队'; title = '2026 巡演行程'
    tagline = '八座城市十四场，票在各城 Livehouse 现场买'
    kick = 'TOUR · AUTUMN 2026'; accent = 4; hits = 187; ago = 55
    chips = @(@{k='城市';v='8 座'}, @{k='场次';v='14 场'}, @{k='新歌';v='9 首'})
    blocks = @(
      @{h='巡演路线'; p='杭州 → 南京 → 武汉 → 成都 → 西安 → 郑州 → 青岛 → 北京。十月八号开票，十一月二十九号收工。'},
      @{h='关于这张新专辑'; p='录了两年，中间换过一次鼓手，重录了四首。它不算干净，但每一条轨都是我们自己弹的。'},
      @{h='怎么找到我们'; p='巡演现场认穿黑色工装的那几个人，或者演出结束在后台门口等十分钟，我们一定会出来。'}
    )
  },
  @{
    slug = 'gaoyuan-fit'; creator = '高远'; title = '健身打卡第 214 天'
    tagline = '从 92kg 到 76kg，没吃任何药，全程记录'
    kick = 'TRAINING LOG · DAY 214'; accent = 5; hits = 98; ago = 43
    chips = @(@{k='打卡';v='214 天'}, @{k='减重';v='16 kg'}, @{k='卧推';v='85 kg'})
    blocks = @(
      @{h='我怎么开始的'; p='去年体检报告上有四项箭头朝上。医生没吓唬我，就说了句"你还年轻"，我回家就把跑鞋翻出来了。'},
      @{h='现在的一周安排'; p='三练两走一休。练腿那天雷打不动放在周三，因为周四不用见客户。'},
      @{h='给和我一样的人'; p='别一上来就买年卡。先连续走够三十天，那时候你自己会想去举铁的。'}
    )
  },
  @{
    slug = 'hesiqi-wedding'; creator = '何思琪 & 沈亦'; title = '我们要结婚了'
    tagline = '2026 年 10 月 3 日，杭州西溪，等你来'
    kick = 'WEDDING INVITATION'; accent = 0; hits = 164; ago = 35
    chips = @(@{k='日期';v='10 月 3 日'}, @{k='地点';v='杭州 · 西溪'}, @{k='席位';v='120'})
    blocks = @(
      @{h='时间与地点'; p='十月三号，周六。仪式下午四点整开始，地点在西溪湿地边上那家有院子的餐厅，导航搜名字就能到。'},
      @{h='当天流程'; p='三点半开始入场随便逛，四点仪式，五点开席，八点之后院子里有乐队，想留多久留多久。'},
      @{h='关于回执'; p='不用给红包，真的。人来了就是最好的。如果实在想给点什么，带一张你手写的话就够了。'}
    )
  },
  @{
    slug = 'wuyou-price'; creator = '吴悠'; title = '插画约稿报价'
    tagline = '明码标价，先看案例再谈，熟人也不打折'
    kick = 'COMMISSION · PRICE LIST'; accent = 1; hits = 46; ago = 26
    chips = @(@{k='起价';v='¥800'}, @{k='周期';v='7 天'}, @{k='已完成';v='96 单'})
    blocks = @(
      @{h='报价'; p='头像 800 起，半身 1500 起，全身带背景 3000 起，商用另议。加急按 50% 加价，不接三天以内的活。'},
      @{h='流程'; p='先聊需求 → 出草稿 → 确认构图后付 50% → 完稿 → 结清尾款交源文件。草稿阶段可改两次，之后每次加 200。'},
      @{h='不接的单'; p='不接"你先画我看看喜不喜欢"，不接抄别人风格，不接不给参考只说"你随便发挥"然后改十次的。'}
    )
  },
  @{
    slug = 'denglan-restore'; creator = '邓岚'; title = '老照片修复展'
    tagline = '把外婆的相册一张张扫回来，再一点点补好'
    kick = 'RESTORATION · SINCE 1953'; accent = 2; hits = 71; ago = 14
    chips = @(@{k='修复';v='340 张'}, @{k='最早';v='1953 年'}, @{k='单张耗时';v='约 3 小时'})
    blocks = @(
      @{h='修复前后'; p='最难的一张是 1953 年的全家福，右下角被水泡过，四个人的脸只剩两个半。补了整整两天。'},
      @{h='我用的方法'; p='先 1200dpi 扫描，再手工修，AI 只用来打底。人脸绝不交给模型自动生成，宁可留着残缺也不要编一张假脸。'},
      @{h='也帮别人修'; p='这半年帮邻居和同事修了六十多张。不收钱，条件是修完你要讲一讲照片里的人是谁。'}
    )
  },
  @{
    slug = 'luoyizhou-map'; creator = '罗一舟'; title = '我走过的地方'
    tagline = '六年，31 个省，一张不断长大的地图'
    kick = 'TRAVEL MAP · 6 YEARS'; accent = 3; hits = 23; ago = 5
    chips = @(@{k='省份';v='31 个'}, @{k='里程';v='6.2 万公里'}, @{k='照片';v='8900 张'})
    blocks = @(
      @{h='这张地图怎么来的'; p='一开始只是在纸质地图上戳洞。戳到第二十个省，纸破了，我才想着做成网页。'},
      @{h='印象最深的三段'; p='川西下雪的垭口、闽东凌晨的渔港、还有内蒙一段两百公里没信号的路——那天我第一次觉得手机可以关掉。'},
      @{h='还没去的'; p='还差四个地方。计划里剩下的都在冬天，得等明年了。'}
    )
  }
)

# 六档配色，和 Worker 端 accent 0-5 的气质对齐
$Palette = @(
  @{ a = '#ff8a5c'; b = '#ff3d71' },
  @{ a = '#5ce1e6'; b = '#3b82f6' },
  @{ a = '#a78bfa'; b = '#6366f1' },
  @{ a = '#34d399'; b = '#10b981' },
  @{ a = '#fbbf24'; b = '#f97316' },
  @{ a = '#f472b6'; b = '#a855f7' }
)

# ───────────────────────── 页面生成 ─────────────────────────

function New-SiteHtml {
  param([hashtable]$W, [string]$HallUrl)

  $p    = $Palette[$W.accent % 6]
  $glow = $p.a + '33'   # 八位十六进制带透明度，比 color-mix 兼容性好
  $title   = Esc $W.title
  $creator = Esc $W.creator
  $tagline = Esc $W.tagline
  $kick    = Esc $W.kick
  $initial = Esc ($W.creator.Substring(0, 1))

  $chips = ($W.chips | ForEach-Object { "<li><b>$(Esc $_.v)</b><span>$(Esc $_.k)</span></li>" }) -join ''
  $blocks = ($W.blocks | ForEach-Object {
      "  <section class=""bk""><h2>$(Esc $_.h)</h2><p>$(Esc $_.p)</p></section>"
    }) -join "`n"

  return @"
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>$title · $creator</title>
<meta name="description" content="$tagline">
<style>
:root{--a:$($p.a);--b:$($p.b);--bg:#0a0c11;--fg:#e9edf6;--dim:#8b95ad;--line:#1a2032}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--fg);font:16px/1.85 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
body::before{content:"";position:fixed;inset:0;background:radial-gradient(58% 42% at 50% 0,$glow,transparent 72%);pointer-events:none}
.wrap{position:relative;max-width:680px;margin:0 auto;padding:0 24px 96px}
header{padding:80px 0 8px}
.kick{font-size:11px;letter-spacing:.26em;color:var(--dim)}
h1{margin:14px 0 14px;font-size:40px;line-height:1.22;letter-spacing:-.01em;background:linear-gradient(120deg,var(--a),var(--b));-webkit-background-clip:text;background-clip:text;color:transparent}
.tag{font-size:17px;color:#b9c2d6}
.by{display:flex;align-items:center;gap:10px;margin-top:26px;font-size:14px;color:var(--dim)}
.av{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-size:13px;font-weight:700;color:#0a0c11;background:linear-gradient(135deg,var(--a),var(--b))}
ul.st{display:flex;flex-wrap:wrap;gap:10px;list-style:none;margin:32px 0 0;padding:26px 0 0;border-top:1px solid var(--line)}
ul.st li{flex:1 1 150px;padding:14px 16px;border:1px solid var(--line);border-radius:14px;background:#11141c}
ul.st b{display:block;font-size:19px;color:var(--fg);line-height:1.4}
ul.st span{font-size:12px;color:var(--dim)}
.bk{margin-top:42px}
.bk h2{font-size:14px;letter-spacing:.06em;color:var(--a);margin-bottom:8px}
.bk p{color:#c3cbdd}
footer{margin-top:64px;padding-top:24px;border-top:1px solid var(--line);font-size:13px;color:var(--dim);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
footer a{color:var(--a);text-decoration:none}
footer a:hover{text-decoration:underline}
@media(max-width:520px){h1{font-size:31px}header{padding-top:56px}}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div class="kick">$kick</div>
  <h1>$title</h1>
  <p class="tag">$tagline</p>
  <div class="by"><span class="av">$initial</span><span>$creator</span></div>
  <ul class="st">$chips</ul>
</header>
$blocks
<footer><span>© 2026 $creator</span><a href="$HallUrl">← 回到作品大厅</a></footer>
</div>
</body>
</html>
"@
}

# ───────────────────────── 主流程 ─────────────────────────

$mode = if ($DryRun) { '演练（不写任何东西）' } else { '真实执行（会往线上写）' }
Head "种入样例作品 · $mode"
Info "目标站点 : $Base"
Info "R2 桶    : $Bucket"
Info "样例数量 : $($Works.Count)"

$tmpDir = Join-Path $env:TEMP 'hall-seed'
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

$token = $null
if (-not $DryRun) {
  $token = Get-PublishToken $Root
  Info "发布令牌 : 已从 .dev.vars 读取（$($token.Substring(0,8))…，长度 $($token.Length)）"

  Head '探测网络通路'
  $usedProxy = Initialize-HallProxy -Base $Base -Proxy $Proxy
  if ($usedProxy -eq 'FAILED') {
    throw "直连和代理 127.0.0.1:7897 都连不上 $Base。先确认代理节点，再用 -Proxy http://host:port 指定。"
  }
  if ($usedProxy) { Good "走代理：$usedProxy" } else { Good '直连可用，不走代理' }
} else {
  Info '发布令牌 : 演练模式不读取'
}

Head '逐个处理'
$results = @()
$idx = 0
foreach ($w in $Works) {
  $idx++
  $htmlText = New-SiteHtml -W $w -HallUrl "$Base/"
  $htmlFile = Join-Path $tmpDir "$($w.slug).html"
  Write-Utf8NoBom $htmlFile $htmlText

  $tag = "[{0,2}/{1}] {2} · {3}" -f $idx, $Works.Count, $w.creator, $w.title

  if ($DryRun) {
    Write-Host "  $tag" -ForegroundColor White
    Info    "POST $Base/api/works  slug=$($w.slug)"
    Info    "R2   $Bucket/sites/$($w.slug)/index.html  ($([Math]::Round($htmlText.Length/1024,1)) KB, --remote --content-type text/html)"
    Info    "SQL  UPDATE works SET hits=$($w.hits), created_at=<now-$($w.ago)min> WHERE slug='$($w.slug)'"
    Info    "预览 $htmlFile"
    $results += [pscustomobject]@{ 创作者 = $w.creator; 标题 = $w.title; slug = $w.slug; id = '(演练)'; 点击 = $w.hits; 结果 = '演练' }
    continue
  }

  Write-Host "  $tag" -ForegroundColor White

  # 1) 发布
  $payload = @{ creator = $w.creator; title = $w.title; tagline = $w.tagline; slug = $w.slug } | ConvertTo-Json -Compress
  $jsonFile = Join-Path $tmpDir "$($w.slug).json"
  Write-Utf8NoBom $jsonFile $payload

  $r = Invoke-Hall -Url "$Base/api/works" -Method POST -BodyFile $jsonFile `
       -Header @('content-type: application/json', "x-publish-token: $token")

  $workId = $null
  $state  = ''
  if (-not $r.Ok) {
    Bad "发布失败：$($r.Error)"
    $results += [pscustomobject]@{ 创作者 = $w.creator; 标题 = $w.title; slug = $w.slug; id = '-'; 点击 = 0; 结果 = "网络失败: $($r.Error)" }
    continue
  }
  if ($r.Status -eq 200) {
    $workId = ($r.Body | ConvertFrom-Json).id
    $state = '新建'
    Good "发布成功 id=$workId  ($($r.Ms) ms)"
  } elseif ($r.Status -eq 409) {
    $rows = Get-D1Rows "SELECT id FROM works WHERE slug = '$($w.slug)';"
    if ($rows.Count) { $workId = $rows[0].id }
    $state = '已存在'
    Warn "slug 已存在，跳过发布（id=$workId）"
  } else {
    Bad "发布返回 HTTP $($r.Status)：$($r.Body.Trim())"
    $results += [pscustomobject]@{ 创作者 = $w.creator; 标题 = $w.title; slug = $w.slug; id = '-'; 点击 = 0; 结果 = "HTTP $($r.Status)" }
    continue
  }

  # 2) 上传站点页（必须 --remote）
  try {
    Invoke-R2Put -Bucket $Bucket -Key "sites/$($w.slug)/index.html" -File $htmlFile -ContentType 'text/html; charset=utf-8'
    Good "站点已上传 $Base/u/$($w.slug)/"
  } catch {
    Bad "站点上传失败：$($_.Exception.Message)"
    $state += ' / 页面上传失败'
  }

  $results += [pscustomobject]@{
    创作者 = $w.creator; 标题 = $w.title; slug = $w.slug; id = $workId; 点击 = $w.hits; 结果 = $state
  }
}

# 3) 刷初始点击与创建时间（必须直接写库：接口有 30 分钟去重，刷不出层次）
if (-not $DryRun -and -not $SkipHits) {
  Head '写入初始热度（直接改 D1，绕开 30 分钟点击去重）'
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $stmts = foreach ($w in $Works) {
    "UPDATE works SET hits = $($w.hits), created_at = $($now - $w.ago * 60000) WHERE slug = '$($w.slug)';"
  }
  $sql = $stmts -join ' '
  try {
    $res = Invoke-D1 -Sql $sql
    $changed = ($res | ForEach-Object { $_.meta.changes } | Measure-Object -Sum).Sum
    Good "已更新 $changed 行（$($Works.Count) 条语句）"
  } catch {
    Bad $_.Exception.Message
    Warn '热度未写入，可稍后单独重跑：pwsh -File scripts\seed-hall.ps1（已存在的会跳过发布）'
  }
} elseif ($SkipHits) {
  Warn '已指定 -SkipHits，跳过热度写入'
}

Head '结果'
$results | Format-Table -AutoSize | Out-String -Width 200 | Write-Host

if ($DryRun) {
  Info "演练完成。生成的样例页面在：$tmpDir"
  Info '确认无误后去掉 -DryRun 再跑一次即可真正种入。'
} else {
  Good "完成。打开大厅看看：$Base/"
  Info  "抽查一个站点：$Base/u/$($Works[0].slug)/"
}
