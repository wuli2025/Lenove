# 实测记录 · 2026-08-13

**账号** `1799820934a@gmail.com`（`0acedf8c211bd536b702a15e61da42aa`）
**线上地址** `https://r2t-9f3x.llmwiki.cloud`
**资源** Worker `r2-sites` · R2 桶 `user-sites` · D1 库 `hall`

---

## 一、这次建成了什么

| 能力 | 地址 | 状态 |
|---|---|---|
| 作品大厅 | `/` | ✅ 服务端直出，最热/最新双 Tab |
| 发布作品 | `POST /api/works` | ✅ 姓名强校验 |
| 回填封面/海报/下架 | `PATCH /api/works/<id>` | ✅ status 白名单 |
| 作品列表 | `GET /api/works?sort=hot\|new` | ✅ 带热度值 |
| 点击计数 | `POST /api/works/<id>/hit` | ✅ 30 分钟同访客去重 |
| 分享海报页 | `/p/<id>` | ✅ 含 OG 卡片、长按保存 |
| 自包含海报 | `/p/<id>.svg` | ✅ 1080×1440，封面 data URI 内嵌 |
| 二维码 | `/qr?d=<url>` | ✅ Worker 内零依赖实现 |
| 产物上传 | `PUT /api/upload/{site\|cover\|poster}/…` | ✅ 走令牌，不发 S3 密钥 |
| 静态站分发 | `/u/<slug>/…` | ✅ 访问页面自动计一次点击 |

---

## 二、验证结果

### 功能验收（静态分发）8/8
目录自动补 `index.html`、站点级 404 回退、路径穿越拦截、指纹资源 `immutable`、
`X-Edge-Cache` MISS→HIT、`If-None-Match` → 304、HEAD 无 body。

### 点击语义
```
同访客连打 5 次      → counted: true, false, false, false, false
3 个不同 UA 访问站点 → hits 1 → 4
请求 css 静态资源    → hits 不变
不存在的作品记点击   → counted: false（修复前会返回 true 并留孤儿行）
```

### 二维码（两层，都是真解码）
```
编码器层  jsQR 逐字比对   7 定向 + 120 fuzz = 127/127，覆盖 V1–V11（含 V7+ 版本信息块）
渲染层    海报栅格化后从像素解码            4/4 + 线上实拍 1/1
```

### 拼音 slug
```
映射表 2512 字 / 354 音节，gzip 9.57 KB
75 用例 / 82 断言全通过
张三 → zhangsan-1dy4s     欧阳修 → ouyangxiu-3yl0g
李小明 → lixiaoming-du05m  Anna 李 → anna-li-nosc1
```

### 桌面端发布链路（MicaBase）
```
未设姓名          → 被 require_name() 拦下
发布              → slug=duandaoduanshi-9k8s8，upload_mode=worker，3 个文件
站点 / css / png  → 200，Content-Type 全部正确
封面回填          → PATCH cover → 海报 SVG 内嵌 data:image/png 成功
cargo test        43 passed; 0 failed
```

### 现场体检脚本
```
smoke-live.ps1  →  8/8 PASS，平均 1012 ms，最慢 1346 ms
```

---

## 三、修掉的三个 bug（联调中发现，都已实测确认）

### 1. 下架不是真的下架 —— 现场硬伤
`status=hidden` 原本只影响大厅列表，作品站 `/u/<slug>/`、海报页、海报 SVG 全部仍返回 200。
**真出内容事故时等于没有开关。**

修复：页面导航**在读缓存之前**先查在架状态。
> 顺序很关键——放在缓存之后判，已经进过边缘缓存的页面会一直绕过判断继续对外可见。

代价是每次 HTML 请求多一次 D1 读，现场量级可以接受。
只有在 `works` 表里登记过的 slug 才受管控，没登记的（冒烟测试站点）照常放行。

实测：下架后 站点 / 海报 / 海报 SVG / 公开详情接口 **四项全部 404**，
带令牌的运维接口仍 200（方便复核），恢复后全部回到 200。

### 2. `status` 没有取值白名单
`{"status":"banana"}` 返回 `ok:true`，作品变成既非 public 也非 hidden 的幽灵态。
修复：限定 `public|hidden`；`cover`/`poster` 也限定前缀与字符集。

### 3. 幽灵点击
对不存在的作品记点击返回 `counted:true`，并在 `hits` 表留下孤儿行（该表无外键）。
修复：先确认作品存在且在架再记数。

---

## 四、踩过的坑（按再犯代价排序）

### ① 二维码「结构全对但一个都扫不出来」
第一版定位图形、定时图形、校正图形、固定暗模块逐项自检全过，肉眼看完全正常，
**扫描器一个都读不出来**。原因：格式信息位序写反了——标准要求 MSB 先放，写成了 LSB 先放。

> **凡是要被机器读的东西，验收标准必须是「机器能读」，不是「人看着对」。**
> 这类 bug 靠看永远发现不了。配套 `verify-qr.mjs` / `verify-poster-qr.mjs` 就是为此存在的。

### ② `wrangler r2 object put` 默认写本地
wrangler 4.90 的 `r2 object put/get` 默认 `--local`，写进 `.wrangler/state/v3/r2/`。
最阴的是 `get` 也读本地——put 成功、get 读回来内容正确，**给你一个完全一致的假象**，
但线上 Worker 通过绑定读到的是空桶。

现象：所有路径 404。定位方法：加临时 `/__debug` 端点调 `env.SITES.list()`，看到 `count: 0` 立刻明确。
**修复：所有 `r2 object` 与 `d1 execute` 一律加 `--remote`。**

### ③ Worker 版本在各 PoP 之间不是瞬时同步
部署后几秒内，同一个 URL 打到 TPE 拿到新版本、打到 SJC 还是旧版本，
表现为「同样的请求一会儿成功一会儿 404」（看 `CF-RAY` 尾部的机房代码能确认）。
**活动当天不要在演示前几十秒部署**，改完至少留 2 分钟再验。

### ④ 缓存命中仍然调用 Worker
`wrangler tail` 实测：10 次请求 = 10 次 Worker 调用，其中 9 次是缓存命中。
`cpuTime` 为 0–1 ms。**缓存省的是 CPU 和 R2 读取，不是请求额度。**
免费版 10 万/天按现场量级兜不住，建议直接上 $5/月。

### ⑤ 本机 Clash fake-ip 让 DNS 检查失真
`Resolve-DnsName`（哪怕指定 `-Server 8.8.8.8`）返回 `198.18.x.x` 假地址，
会误判子域名已被占用。**DNS 检查必须走 DoH。**

### ⑥ PowerShell 的 `[Math]::Max(0, $hours)` 会截断成整数
命中 `Max(int,int)` 重载，热度算出来比线上高一大截，排序也会错。
必须写成 `if ($hours -lt 0) { $hours = 0.0 }`。

---

## 五、仓库结构

```
src/
  index.js    路由总入口（大厅 / API / 海报 / 上传 / 静态分发）
  api.js      数据层与接口实现
  hall.js     大厅页（六条硬规则写死在这里）
  poster.js   分享海报（HTML 分享页 + 自包含 SVG）
  qr.js       零依赖 QR 编码器（byte 模式 · RS 纠错 · 8 掩码择优 · V1–V15）
  pinyin.js   汉字→拼音（2512 字，用于中文姓名转专属网址）
  brand.js    活动主题元素、配色、生成式封面（4 种版式按关键词选）
scripts/
  verify-qr.mjs         QR 编码器真解码验证
  verify-poster-qr.mjs  海报渲染后的二维码可扫性验证
  verify-pinyin.mjs     拼音与 slug 验证
  preview-poster.mjs    海报边界情况本地预览
  smoke-live.ps1        现场开场前 8 项体检
  hall-ops.ps1          list / hide / show / stats / export
  seed-hall.ps1         种入样例作品（永不空榜）
schema.sql    D1 表结构
```

---

## 六、还没做 / 还没验

- [ ] **国内直连未验证** —— 全程走代理测的。「分配域名 + 国内可访问」是核心承诺，
      必须用现场同款网络实测：直连 / 微信内 / 手机 4G，记录首屏耗时。**这是最大的未知。**
- [ ] 邮箱验证码登录与个人中心（现阶段靠发布令牌，够撑 8/18）
- [ ] `MICA_UPLOAD_MODE=s3` 那条 SigV4 通道只有单元级验证，没对着真 R2 打过 PUT
- [ ] 批量并发上传的真实耗时与成功率（现场「生成完自动上线」的关键指标）
- [ ] HTML 的 ETag 被 Cloudflare 边缘去掉了（CSS 的保留），304 链路在 HTML 上可能不生效
- [ ] 大文件流式返回的内存表现（当前测试文件都很小）
