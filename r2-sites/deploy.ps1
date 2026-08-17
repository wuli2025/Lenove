# 一键部署：Worker + R2 + llmwiki.cloud 子域名
# 严格增量：只新增，不修改/删除 llmwiki.cloud 上任何已有记录。
# 用法： pwsh -File deploy.ps1  [-Subdomain sites]

param(
  [string]$Subdomain = 'sites',
  [string]$Zone      = 'llmwiki.cloud',
  [string]$Bucket    = 'user-sites'
)

$ErrorActionPreference = 'Stop'
$env:WRANGLER_SEND_METRICS = 'false'
Set-Location $PSScriptRoot

function Step($n, $t) { Write-Host "`n[$n] $t" -ForegroundColor Cyan }

# ---------- 0. 网络与登录 ----------
Step 0 '检查网络与登录态'
$code = curl.exe -sS -o NUL -m 15 -w "%{http_code}" https://api.cloudflare.com/client/v4/user/tokens/verify 2>&1
if ($code -notmatch '^\d{3}$') { throw "连不上 api.cloudflare.com（$code）。先把代理节点恢复。" }
Write-Host "  api.cloudflare.com 可达 (HTTP $code)"
wrangler whoami

# ---------- 1. 先看现状，确认不会踩到已有东西 ----------
# 注意：wrangler 没有 dns 子命令（4.90 实测），改用 DoH 查公网解析。
# 本机若开着 Clash fake-ip，普通 Resolve-DnsName 会返回 198.18.x.x 假地址，必须走 DoH。
Step 1 "检查 $Subdomain.$Zone 是否已被占用（DoH，绕开 fake-ip）"
$doh = curl.exe -sS -m 20 -H 'accept: application/dns-json' `
       "https://dns.google/resolve?name=$Subdomain.$Zone&type=A" 2>$null | ConvertFrom-Json
if ($doh.Answer) {
  Write-Host "  ⚠ 已存在解析：" -ForegroundColor Red
  $doh.Answer | ForEach-Object { "    $($_.data)" }
  throw "$Subdomain.$Zone 已被占用，换个名字（-Subdomain xxx）后重跑。"
}
Write-Host "  未占用，可以使用（Status=$($doh.Status)）"

# ---------- 2. R2 桶 ----------
Step 2 "创建 R2 桶 $Bucket（已存在则跳过）"
$buckets = wrangler r2 bucket list 2>&1 | Out-String
if ($buckets -match [regex]::Escape($Bucket)) { Write-Host "  已存在，跳过" }
else { wrangler r2 bucket create $Bucket }

# ---------- 3. 写入路由后部署 ----------
Step 3 "写入路由 $Subdomain.$Zone/* 并部署 Worker"
$toml = Get-Content wrangler.toml -Raw
if ($toml -notmatch '^\s*\[\[routes\]\]' ) {
  $toml = $toml.TrimEnd() + @"


[[routes]]
pattern = "$Subdomain.$Zone/*"
zone_name = "$Zone"
custom_domain = true
"@
  [IO.File]::WriteAllText("$PSScriptRoot\wrangler.toml", $toml, (New-Object Text.UTF8Encoding($false)))
  Write-Host "  已写入 routes"
} else { Write-Host "  routes 已存在，未改动" }

wrangler deploy

# ---------- 4. 传两个测试站点 ----------
Step 4 '上传测试站点 site-a / site-b'
$tmp = Join-Path $env:TEMP 'r2sites'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
'<!doctype html><meta charset=utf-8><h1>site-a</h1><p>Worker + R2 OK</p>' | Set-Content "$tmp\a.html" -Encoding utf8
'<!doctype html><meta charset=utf-8><h1>site-b</h1>'                      | Set-Content "$tmp\b.html" -Encoding utf8
'<!doctype html><meta charset=utf-8><h1>404 · site-b</h1>'                | Set-Content "$tmp\b404.html" -Encoding utf8

# ⚠ 必须带 --remote：wrangler 4.90 的 r2 object put 默认写本地 miniflare 模拟存储
#   （.wrangler\state\v3\r2\），不加这个参数上传"成功"了但云端桶里什么都没有，
#   而且 r2 object get 也读本地，会给你一个一致的假象。这个坑实测踩过。
wrangler r2 object put "$Bucket/sites/site-a/index.html" --file "$tmp\a.html"    --content-type "text/html; charset=utf-8" --remote
wrangler r2 object put "$Bucket/sites/site-b/index.html" --file "$tmp\b.html"    --content-type "text/html; charset=utf-8" --remote
wrangler r2 object put "$Bucket/sites/site-b/404.html"   --file "$tmp\b404.html" --content-type "text/html; charset=utf-8" --remote

# ---------- 5. 功能验收 ----------
$base = "https://$Subdomain.$Zone"
Step 5 "功能验收  $base"
Write-Host '  (自定义域名首次生效可能要等几十秒)'
Start-Sleep -Seconds 20

function Probe($label, $url, $extra = @()) {
  $args = @('-sS','-o','NUL','-m','20','-D','-') + $extra + @($url)
  $h = curl.exe @args 2>&1 | Out-String
  $status = ($h -split "`n" | Select-Object -First 1).Trim()
  $cache  = ($h -split "`n" | Where-Object { $_ -match '^x-edge-cache:' }) -join ''
  $etag   = ($h -split "`n" | Where-Object { $_ -match '^etag:' }) -join ''
  "{0,-26} {1}  {2}  {3}" -f $label, $status, $cache.Trim(), $etag.Trim()
}

Probe '1 首次访问(应 MISS)'  "$base/u/site-a/"
Probe '2 再次访问(应 HIT)'   "$base/u/site-a/"
Probe '3 站点级404'          "$base/u/site-b/nope"
Probe '4 路径穿越(应404)'    "$base/u/site-a/../../etc"
Probe '5 不存在的站(应404)'  "$base/u/nosuchsite/"
Probe '6 HEAD'               "$base/u/site-a/" @('-I')

# ---------- 6. 计费真相验证 ----------
Step 6 '计费验证：对同一 URL 连打 10 次'
Write-Host '  另开一个终端跑: wrangler tail --format pretty' -ForegroundColor Yellow
Write-Host '  若 tail 出现 10 条日志 => 缓存命中仍计 Worker 请求额度（与官方文档一致）'
Write-Host '  若只出现 1 条        => 存在绕过机制，需要重算成本模型'
Read-Host '  已挂好 tail 后按回车开打'
1..10 | ForEach-Object { curl.exe -sS -o NUL -m 15 -w "$_ " "$base/u/site-a/" }
Write-Host "`n  打完。回 tail 那个窗口数日志条数。"

Write-Host "`n完成。站点访问地址：$base/u/<站点名>/" -ForegroundColor Green
