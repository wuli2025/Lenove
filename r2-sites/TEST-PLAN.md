# Worker + R2 子路径分发 —— 部署与实测清单

> 状态：**代码已写好，尚未在真实 Cloudflare 上跑过。**
> 原因：本机当前无法连通 Cloudflare（`dash/api/developers.cloudflare.com` TLS 握手全部失败，
> 本地代理 127.0.0.1:7897 在监听但上游同样不通，`registry.npmjs.org`、`github.com` 一并不通）。
> 网络恢复后按下面顺序跑，每一步都有明确的判定标准。

---

## 0. 前置

```powershell
# 确认网络通了
curl.exe -sS -o NUL -m 15 -w "%{http_code}\n" https://api.cloudflare.com/client/v4/user/tokens/verify

wrangler login          # 或 $env:CLOUDFLARE_API_TOKEN = "..."
wrangler whoami         # 能打出账号即可
```

Token 走环境变量时，最小权限：`Workers Scripts:Edit` + `Workers R2 Storage:Edit` + `Account Settings:Read`。

---

## 1. 建桶 + 部署

```powershell
cd D:\polaris\个人网站创作平台\r2-sites
wrangler r2 bucket create user-sites
wrangler deploy
```

部署完拿到 `https://r2-sites.<子域>.workers.dev`。

---

## 2. 传两个测试站点

```powershell
# 站点 A：普通页面
"<h1>site-a</h1><p>hello</p>" | Out-File -Encoding utf8 a.html
wrangler r2 object put user-sites/sites/site-a/index.html --file a.html --content-type "text/html; charset=utf-8"

# 站点 B：验证 404 回退
"<h1>site-b</h1>" | Out-File -Encoding utf8 b.html
"<h1>404 · site-b</h1>" | Out-File -Encoding utf8 b404.html
wrangler r2 object put user-sites/sites/site-b/index.html --file b.html --content-type "text/html; charset=utf-8"
wrangler r2 object put user-sites/sites/site-b/404.html   --file b404.html --content-type "text/html; charset=utf-8"
```

---

## 3. 功能判定

| # | 请求 | 期望 |
|---|---|---|
| 1 | `GET /u/site-a/` | 200，返回 site-a，`X-Edge-Cache: MISS` |
| 2 | 同上，立刻再请求一次 | 200，`X-Edge-Cache: HIT` |
| 3 | 带上第 1 次返回的 `ETag` 发 `If-None-Match` | 304，无 body |
| 4 | `GET /u/site-b/nope` | 404，且返回的是 site-b 自己的 404 页 |
| 5 | `GET /u/site-a/../../etc` | 404（路径穿越被拒） |
| 6 | `GET /u/不存在的站/` | 404 |
| 7 | `HEAD /u/site-a/` | 200，无 body，有 Content-Length |

```powershell
$base = "https://r2-sites.<子域>.workers.dev"
curl.exe -sSI "$base/u/site-a/"                      # 看 X-Edge-Cache / ETag
curl.exe -sSI "$base/u/site-a/"                      # 第二次应为 HIT
curl.exe -sSI -H 'If-None-Match: "<上一步的ETag>"' "$base/u/site-a/"
curl.exe -sS  "$base/u/site-b/nope"                  # 应看到 site-b 的 404 页
```

---

## 4. 计费真相的验证（**最重要的一步**）

这一步专门用来验证「缓存命中到底扣不扣 Worker 请求额度」。
文档结论是 **扣**（Worker 跑在缓存之前），下面是实证方法：

```powershell
# 开一个终端挂着实时日志
wrangler tail --format pretty
```

另开一个终端，对**同一个 URL** 连打 10 次：

```powershell
1..10 | ForEach-Object { curl.exe -sS -o NUL -w "%{http_code} " "$base/u/site-a/" }
```

**判定：**
- 如果 `wrangler tail` 里出现 **10 条**日志 → Worker 每次都执行了，
  即缓存命中**照样计请求额度**（预期结果，与官方文档一致）。
- 如果只出现 1 条 → 说明该路径上确实存在绕过机制，
  那么原分析成立，需要复核并更新成本模型。

再到 Dashboard → Workers → r2-sites → Metrics，对比 Requests 计数增量，做二次确认。

---

## 5. 成本压力测算（用真实数字替换假设）

跑完上面这步，用实测的「每页面请求数」重算：

```
日请求数 = 站点数 × 人均浏览次数 × 每页面文件请求数
```

- 免费版上限：**10 万请求/天**
- 付费版 $5/月：含 **1000 万请求/月**，CPU 上限 10ms → 30s

**若第 4 步确认「缓存命中仍计请求」，则按下面两条处理：**
1. 直接上 $5/月付费版（强烈建议，5 美元换掉一整类风险）；
2. 生成的站点尽量把 CSS/JS 内联进单个 HTML，把每页面请求数从 ~8 降到 ~2。

---

## 6. 内存红线自查

Worker 代码里**必须**保持流式：

```js
return new Response(obj.body, { headers })   // ✅ 流式，不占 128MB
const t = await obj.text()                   // ❌ 整个文件进内存，大图/视频会 OOM
```

上线前 grep 一遍，确认没有 `.text()` / `.arrayBuffer()` / `.blob()` 作用在 R2 对象上。

---

## 7. 与「十分钟自动上线」链路的衔接

生成完成后，客户端侧直接调 R2 API 批量 PUT：

```
PUT sites/<用户名>/index.html
PUT sites/<用户名>/assets/...
```

**不需要重新部署 Worker** —— 这才是选 R2 而不是 Workers Static Assets 的真正原因
（Static Assets 的资源随 Worker 版本一起打包，每新增一个站点就要重部署一次）。

⚠️ 本机到 Cloudflare 的链路目前不通。这条链路正是现场「生成完自动上线」的必经之路，
**必须在 8/17 之前用现场同款网络实测上传耗时与成功率**，否则现场会卡在这一步。
