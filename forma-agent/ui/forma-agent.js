/* ══════════════════════════════════════════════════════════════════
   FORMA Agent —— 前端装配层
   ------------------------------------------------------------------
   · 模板与渲染器全部复用 app.js 的既有实现（templates / renderTemplate /
     getTemplate / standaloneUrl / showToast），这里不重写一行模板逻辑。
   · 后端是 youxi(MicaBase)：任务网关 /v1/tasks(+SSE)、供应商 /v1/providers、
     环境医生 /v1/doctor、更新 /v1/update/check。
   · 设置页版式照搬有戏剧场（居中窄栏 + 分块卡片），接口换成上面这几条。
   ══════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const DEFAULT_PORTS = [1471, 1472, 1473, 1474, 1475, 1476, 1477, 1478];

  const FA = {
    api: "",
    ready: false,
    app: null,
    prov: null,
    doc: null,
    upd: null,
    presets: [],
    probe: {},
    // 创作态
    task: null,
    es: null,
    mode: "profile", // profile（AI 填充视觉系统）| config（改写独立成品的 PORTFOLIO_CONFIG）
    running: false,
    html: "",
    tplId: "noir",
    accent: "#DFFF57",
    lastProfile: null,
  };

  const esc = (v) =>
    String(v == null ? "" : v)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  const toast = (m) => (window.showToast ? window.showToast(m) : console.log("[forma]", m));

  /* ─────────── 后端连接 ─────────── */

  async function detectBackend() {
    // Tauri 壳：端口由 Rust 侧动态挑选后经 boot 命令下发
    try {
      const inv = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
      if (inv) {
        const boot = await inv("forma_boot");
        if (boot && boot.apiBase) return boot.apiBase;
      }
    } catch (e) {
      console.warn("[forma] forma_boot 失败，回落端口探测", e);
    }
    // 浏览器直开：挨个探 /healthz
    const tries = DEFAULT_PORTS.map((p) =>
      fetch(`http://127.0.0.1:${p}/healthz`, { cache: "no-store" })
        .then((r) => (r.ok ? `http://127.0.0.1:${p}` : Promise.reject(new Error("bad"))))
        .catch(() => Promise.reject(new Error("down"))),
    );
    try {
      return await Promise.any(tries);
    } catch {
      return "";
    }
  }

  async function jget(path) {
    const r = await fetch(FA.api + path, { cache: "no-store" });
    const t = await r.text();
    let j = {};
    try {
      j = t ? JSON.parse(t) : {};
    } catch {
      throw new Error(`${path} 返回的不是 JSON：${t.slice(0, 160)}`);
    }
    if (!r.ok) throw new Error(j.error || `${path} HTTP ${r.status}`);
    return j;
  }

  async function jpost(path, body) {
    const r = await fetch(FA.api + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const t = await r.text();
    let j = {};
    try {
      j = t ? JSON.parse(t) : {};
    } catch {
      throw new Error(`${path} 返回的不是 JSON：${t.slice(0, 160)}`);
    }
    if (!r.ok) {
      const e = new Error(j.error || `${path} HTTP ${r.status}`);
      e.payload = j;
      throw e;
    }
    return j;
  }

  function paintConn() {
    document.querySelectorAll(".fa-conn").forEach((el) => {
      el.className = "fa-conn " + (FA.ready ? "ok" : "bad");
      el.innerHTML = `<i></i>${
        FA.ready ? `后端已连接 · ${esc(FA.api.replace("http://", ""))}` : "后端未连接"
      }`;
    });
  }

  /* ─────────── 视图骨架 ─────────── */

  function injectShell() {
    // 顶栏入口
    const nav = document.querySelector(".main-nav");
    if (nav && !document.getElementById("faNavAgent")) {
      const b = document.createElement("button");
      b.type = "button";
      b.id = "faNavAgent";
      b.className = "fa-navBtn";
      b.innerHTML = "<span>✦</span> AI 创作";
      nav.appendChild(b);
    }
    const acts = document.querySelector(".nav-actions");
    if (acts && !document.getElementById("faNavSet")) {
      const g = document.createElement("button");
      g.type = "button";
      g.id = "faNavSet";
      g.className = "icon-button";
      g.setAttribute("aria-label", "设置：API 切换 / 环境医生 / 软件更新");
      g.title = "设置：API 切换 / 环境医生 / 软件更新";
      g.innerHTML =
        '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/></svg>';
      acts.insertBefore(g, acts.firstChild);
    }

    const wrap = document.createElement("div");
    wrap.innerHTML = `
<!-- ══ 创作面板 ══ -->
<div class="fa-view" id="faAgentView">
  <div class="fa-topbar">
    <button class="fa-back" type="button" data-fa-close="faAgentView">← 返回模板广场</button>
    <div>
      <h2>AI 创作</h2>
      <div class="fa-sub">把你的经历交给 AI，落进 FORMA 的版式里</div>
    </div>
    <div class="fa-sp"></div>
    <div class="fa-conn"><i></i>检测中…</div>
    <button class="fa-btn" type="button" id="faGoSet">设置</button>
  </div>
  <div class="fa-studio">
    <div class="fa-form" id="faForm"></div>
    <div class="fa-stage">
      <div class="fa-stageBar">
        <div class="fa-tabs" id="faTabs">
          <button type="button" data-pane="preview" class="on">预览</button>
          <button type="button" data-pane="log">生成日志</button>
          <button type="button" data-pane="sites">我的站点</button>
        </div>
        <div class="fa-sp" style="flex:1"></div>
        <button class="fa-btn" type="button" id="faOpenTab">新窗口打开</button>
        <button class="fa-btn" type="button" id="faDownload">下载 HTML</button>
        <button class="fa-btn pri" type="button" id="faSave">保存到我的站点</button>
      </div>
      <div class="fa-stageBody">
        <div class="fa-pane on" data-pane="preview"><iframe id="faPreview" title="生成预览"></iframe></div>
        <div class="fa-pane" data-pane="log"><pre id="faLog">还没有开始生成。

左侧填好信息后点「开始生成」，这里会实时显示模型的输出。</pre></div>
        <div class="fa-pane" data-pane="sites"><div class="fa-narrow" style="padding-top:26px"><div class="fa-row" style="justify-content:space-between;margin-bottom:14px"><strong style="font-size:14px">我的站点</strong><button class="fa-btn sm" type="button" id="faSitesRefresh">刷新</button></div><div class="fa-siteList" id="faSiteList"></div></div></div>
      </div>
    </div>
  </div>
</div>

<!-- ══ 设置页 ══ -->
<div class="fa-view" id="faSetView">
  <div class="fa-topbar">
    <button class="fa-back" type="button" data-fa-close="faSetView">← 返回</button>
    <div><h2>设置</h2><div class="fa-sub">软件更新 · API 切换 · 环境医生 · 运行环境</div></div>
    <div class="fa-sp"></div>
    <div class="fa-conn"><i></i>检测中…</div>
  </div>
  <div class="fa-narrow" id="faSetPage"></div>
</div>

<!-- ══ 供应商编辑浮层 ══ -->
<div class="fa-mask" id="pvMask">
  <div class="fa-dlg">
    <h3 id="pvTitle">新增供应商</h3>
    <div id="pvBody"></div>
    <div id="pvErr"></div>
    <div class="foot">
      <div class="fa-sp"></div>
      <button class="fa-btn" type="button" id="pvCancel">取消</button>
      <button class="fa-btn pri" type="button" id="pvSave">保存并测试</button>
    </div>
  </div>
</div>`;
    document.body.appendChild(wrap);
  }

  function openView(id) {
    document.querySelectorAll(".fa-view").forEach((v) => v.classList.remove("on"));
    document.getElementById(id).classList.add("on");
    document.body.classList.add("fa-locked");
  }
  function closeView(id) {
    document.getElementById(id).classList.remove("on");
    if (!document.querySelector(".fa-view.on")) document.body.classList.remove("fa-locked");
  }

  /* ═══════════════ 设置页 ═══════════════
     照搬有戏剧场的信息架构，服务端持有唯一状态，这里只是视图：
     任何一次操作后重新拉服务端状态整块重画，前端不自己攒状态。 */

  async function loadSettings(force) {
    const host = document.getElementById("faSetPage");
    if (!FA.ready) {
      host.innerHTML = `<div class="fa-head"><h1>设置</h1></div><div class="fa-blk"><div class="fa-msg err">连不上本机后端。<br>Tauri 壳里后端随程序启动；如果你是用浏览器直接打开 index.html，请先启动 <code>forma-agent</code> 桌面壳，或用 <code>cargo run</code> 起服。</div></div>`;
      return;
    }
    if (!FA.app || force) {
      host.innerHTML = `<div class="fa-head"><h1>设置</h1><p class="sub">正在读取…</p></div>`;
      try {
        const [app, prov, doc, presets] = await Promise.all([
          jget("/v1/app/info"),
          jget("/v1/providers"),
          jget("/v1/doctor"),
          jget("/v1/presets"),
        ]);
        FA.app = app;
        FA.prov = prov;
        FA.doc = doc;
        FA.presets = presets.presets || [];
      } catch (e) {
        host.innerHTML = `<div class="fa-head"><h1>设置</h1></div><div class="fa-blk"><div class="fa-msg err">读不到后端设置接口：${esc(e.message)}</div></div>`;
        return;
      }
    }
    paintSettings();
  }

  function paintSettings() {
    const host = document.getElementById("faSetPage");
    const a = FA.app || {};
    const P = FA.prov || { providers: [], active: null, fallback: null };
    const u = FA.upd;

    host.innerHTML = `
  <div class="fa-head">
    <h1>设置</h1>
    <p class="sub">配置 FORMA Agent 的软件更新、AI 走哪家 API，以及本机运行环境。后端是 youxi(MicaBase)，所有 key 只落在本机。</p>
  </div>

  <section class="fa-blk">
    <div class="bTitle">软件更新</div>
    <div class="bDesc">检查发布源上有没有新版本。检查走 GitHub 公开 Release API，不经任何自建网关。</div>
    <div class="fa-verCard">
      <div class="fa-verLogo">F</div>
      <div class="fa-verMeta">
        <div class="fa-verName">FORMA Agent · 个人网站创作</div>
        <div class="fa-verNum">当前版本 v${esc(a.version || "—")} · ${esc(a.shell || "")} 壳 · ${esc(a.platform || "")}-${esc(a.arch || "")} · 后端 ${esc(a.backend || "")}</div>
      </div>
      <button class="fa-btn" type="button" id="upCheck">检查更新</button>
    </div>
    ${updateHtml(u)}
  </section>

  <section class="fa-blk">
    <div class="bTitle">API 切换 <span class="tag">providers.json</span></div>
    <div class="bDesc">
      <b>当前使用</b>决定 AI 创作走哪家；<b>故障兜底</b>是它连续失败时自动顶上的那家（5 分钟内 3 次网络/鉴权失败即切换，恢复后不自动切回，防抖动）。
      切换会先做连通预检，探测不通不允许生效。key 存在 <code>${esc(a.providersFile || "")}</code>，只属于 FORMA Agent，与 MicaBase / 有戏剧场各自独立。
    </div>
    <div class="fa-slotGrid">
      ${slotHtml("当前使用", "AI 创作走这条通道", P.active, P, "active")}
      ${slotHtml("故障兜底", "主通道连挂时自动顶上", P.fallback, P, "fallback")}
    </div>
    <div class="fa-row" style="margin:16px 0 8px;justify-content:space-between">
      <span style="font-size:12.5px;color:var(--muted)">供应商清单（共 ${P.providers.length} 家）</span>
      <button class="fa-btn sm" type="button" id="pvAdd">＋ 新增供应商</button>
    </div>
    <div class="fa-provList">${
      P.providers.length
        ? P.providers.map((p) => provHtml(p, P)).join("")
        : `<div class="fa-msg info">还没有配置任何供应商。点右上「＋ 新增供应商」，选一个预设填上 API Key 即可开始创作。也可以不配 API，改用本机已登录的 Claude Code CLI（见下方环境医生）。</div>`
    }</div>
  </section>

  <section class="fa-blk">
    <div class="bTitle">环境医生 <span class="tag">/v1/doctor</span></div>
    <div class="bDesc">逐项体检本机的 CLI 与运行时。<b>claude</b> 是硬性前置里唯一必须的一项 —— 但如果你在上面配好了 API 供应商，AI 创作会直接走 API 直连，不需要本机装任何 CLI。</div>
    <div class="fa-row" style="margin-bottom:14px">
      <span class="fa-msg ${FA.doc && FA.doc.ready ? "ok" : "info"}" style="margin:0;flex:1">${
        FA.doc && FA.doc.ready
          ? "✓ 硬性组件齐全，本机 CLI 通道可用"
          : "部分组件缺失。装上即可用本机 CLI 通道；只想用 API 直连的话可以忽略。"
      }</span>
      <button class="fa-btn sm" type="button" id="docRefresh">重新体检</button>
    </div>
    <div class="fa-docGrid">${((FA.doc && FA.doc.components) || []).map(docHtml).join("")}</div>
  </section>

  <section class="fa-blk plain">
    <div class="bTitle">运行环境</div>
    <div class="bDesc">
      壳：<code>${esc(a.shell || "")}</code> · 后端：<code>${esc(a.backend || "")}</code> · 端口：<code>127.0.0.1:${esc(a.port || "")}</code><br>
      数据目录：<code>${esc(a.dataRoot || "")}</code><br>
      站点产出：<code>${esc(a.sitesDir || "")}</code><br>
      任务库：<code>${esc(a.dbFile || "")}</code> · 日志：<code>${esc(a.logsDir || "")}</code><br>
      这套目录是 FORMA Agent 独占的，和 <code>~/MicaBase</code>（youxi 服务器形态）以及有戏剧场互不干扰。
    </div>
    <div class="fa-row"><button class="fa-btn" type="button" id="openData">打开数据目录</button></div>
  </section>`;

    // ── 事件绑定 ──
    host.querySelector("#upCheck").onclick = async (ev) => {
      ev.target.disabled = true;
      ev.target.textContent = "检查中…";
      try {
        FA.upd = await jget("/v1/update/check");
      } catch (e) {
        FA.upd = { ok: false, error: e.message };
      }
      paintSettings();
    };
    host.querySelector("#pvAdd").onclick = () => openProvider(null);
    host.querySelector("#docRefresh").onclick = async (ev) => {
      ev.target.disabled = true;
      ev.target.textContent = "体检中…";
      try {
        FA.doc = await jget("/v1/doctor");
      } catch (e) {
        toast("体检失败：" + e.message);
      }
      paintSettings();
    };
    host.querySelector("#openData").onclick = async () => {
      try {
        await jpost("/v1/reveal-data", {});
        toast("已在文件管理器中打开数据目录");
      } catch (e) {
        toast(e.message);
      }
    };
    const rel = host.querySelector("#upOpen");
    if (rel)
      rel.onclick = () => jpost("/v1/open", { url: rel.dataset.url }).catch((e) => toast(e.message));

    host.querySelectorAll("[data-pick]").forEach((el) => {
      el.onclick = () => pickProvider(el.dataset.slot, el.dataset.pick);
    });
    host.querySelectorAll("[data-act]").forEach((el) => {
      el.onclick = () => provAction(el.dataset.act, el.dataset.id);
    });
    document.querySelectorAll(".fa-conn").forEach(() => {});
    paintConn();
  }

  function updateHtml(u) {
    if (!u) return `<div class="fa-msg info">还没查过。点右上「检查更新」即可。</div>`;
    if (!u.ok) return `<div class="fa-msg err">检查失败：${esc(u.error || "未知错误")}</div>`;
    if (u.update_available) {
      return `<div class="fa-msg ok">发现新版本 <b>${esc(u.latest)}</b>（当前 v${esc(u.current)}）${
        u.notes ? `<br><span style="color:var(--muted)">${esc(String(u.notes).slice(0, 300))}</span>` : ""
      }</div>${
        u.download_url
          ? `<div class="fa-row" style="margin-top:10px"><button class="fa-btn pri" type="button" id="upOpen" data-url="${esc(u.download_url)}">在浏览器打开发布页</button></div>`
          : ""
      }`;
    }
    return `<div class="fa-msg ok">已是最新版本${u.latest ? `（发布源最新 ${esc(u.latest)}）` : ""}</div>`;
  }

  function slotHtml(title, desc, current, P, slot) {
    const picks = P.providers
      .map((p) => {
        const on = current === p.id;
        const nokey = !p.secret_set;
        return `<button class="fa-pk${on ? " on" : ""}${nokey ? " nokey" : ""}" type="button" data-slot="${slot}" data-pick="${esc(p.id)}" title="${nokey ? "还没填 API Key" : esc(p.base_url || "")}"><span class="dot"></span>${esc(p.name)}</button>`;
      })
      .join("");
    const clear =
      slot === "fallback" && current
        ? `<button class="fa-pk" type="button" data-slot="fallback" data-pick="__none__">不设兜底</button>`
        : "";
    return `<div class="fa-slotRow">
      <div class="fa-slotName">${title}<span class="sd">${desc}</span></div>
      <div class="fa-slotPicks">${picks || '<span style="font-size:12px;color:var(--muted)">还没有可选供应商</span>'}${clear}</div>
    </div>`;
  }

  function provHtml(p, P) {
    const used = [];
    if (P.active === p.id) used.push("当前使用");
    if (P.fallback === p.id) used.push("故障兜底");
    const pr = FA.probe[p.id];
    const m = p.models || {};
    return `<div class="fa-provCard">
      <div class="ph">
        <span class="pn">${esc(p.name)}</span>
        <span class="kind">${esc(p.preset || "自定义")}</span>
        ${used.length ? `<span class="use">${used.join(" / ")}</span>` : ""}
        <span class="acts">
          <button class="fa-btn sm" type="button" data-act="test" data-id="${esc(p.id)}">${pr === "..." ? "测试中…" : "测试连通"}</button>
          <button class="fa-btn sm" type="button" data-act="edit" data-id="${esc(p.id)}">编辑</button>
          <button class="fa-btn sm danger" type="button" data-act="del" data-id="${esc(p.id)}">删除</button>
        </span>
      </div>
      <div class="meta">
        <span class="k">Base</span> ${esc(p.base_url || "")}<br>
        <span class="k">模型</span> ${esc(m.default || "")}${m.haiku ? ` · 小模型 ${esc(m.haiku)}` : ""}<br>
        <span class="k">Key</span> ${p.secret_set ? "已配置（脱敏不回显）" : "（未配置）"} · <span class="k" style="min-width:0">ID</span> ${esc(p.id)}
      </div>
      ${pr && pr !== "..." ? `<div class="res ${pr.ok ? "ok" : "err"}">${pr.ok ? "✓ " : "✕ "}${esc(pr.message || JSON.stringify(pr))}</div>` : ""}
    </div>`;
  }

  function docHtml(c) {
    return `<div class="fa-docCard${c.ok ? "" : " bad"}">
      <div class="dh">
        <span class="dn">${esc(c.name)}</span>
        <span class="st ${c.ok ? "ok" : "no"}">${c.ok ? "已就绪" : "缺失"}</span>
        <span class="req">${c.required ? "必需" : "可选"}</span>
      </div>
      ${
        c.ok
          ? `<div class="dm">${c.version ? esc(c.version) + "<br>" : ""}${esc(c.path || "")}${c.via ? `<br>来源：${esc(c.via)}` : ""}</div>`
          : `<div class="hint">${esc(c.hint || "")}</div>${installCmd(c.name)}`
      }
    </div>`;
  }

  function installCmd(name) {
    const map = {
      claude: "npm i -g @anthropic-ai/claude-code",
      codex: "npm i -g @openai/codex",
      node: "https://nodejs.org  （建议 Node 20+）",
      git: "https://git-scm.com/downloads",
    };
    const cmd = map[name];
    if (!cmd) return "";
    return `<div class="fa-cmd"><span>${esc(cmd)}</span><button class="fa-btn sm" type="button" onclick="navigator.clipboard.writeText(${JSON.stringify(cmd).replace(/"/g, "&quot;")}).then(()=>window.showToast&&window.showToast('已复制'))">复制</button></div>`;
  }

  async function pickProvider(slot, id) {
    try {
      if (slot === "active") {
        const r = await jpost(`/v1/providers/${encodeURIComponent(id)}/activate`, {});
        FA.probe[id] = r.probe || { ok: true, message: "预检通过" };
        toast("已切换当前使用的供应商");
      } else {
        const none = id === "__none__";
        await jpost(`/v1/providers/${encodeURIComponent(none ? "x" : id)}/fallback`, {
          enable: !none,
        });
        toast(none ? "已取消故障兜底" : "已设为故障兜底");
      }
      FA.prov = await jget("/v1/providers");
      paintSettings();
    } catch (e) {
      const p = e.payload && e.payload.probe;
      FA.probe[id] = p || { ok: false, message: e.message };
      paintSettings();
      toast("切换被拒：预检没通过 —— " + e.message);
    }
  }

  async function provAction(act, id) {
    const p = (FA.prov.providers || []).find((x) => x.id === id);
    if (!p) return;
    if (act === "edit") return openProvider(p);
    if (act === "del") {
      if (!confirm(`删除供应商「${p.name}」？\n只删本机配置，不影响远端账号。`)) return;
      try {
        await jpost(`/v1/providers/${encodeURIComponent(id)}/delete`, {});
        FA.prov = await jget("/v1/providers");
        delete FA.probe[id];
        paintSettings();
        toast("已删除");
      } catch (e) {
        toast(e.message);
      }
      return;
    }
    if (act === "test") {
      FA.probe[id] = "...";
      paintSettings();
      try {
        FA.probe[id] = await jpost(`/v1/providers/${encodeURIComponent(id)}/probe`, {});
      } catch (e) {
        FA.probe[id] = { ok: false, message: e.message };
      }
      paintSettings();
    }
  }

  /* ── 供应商编辑浮层 ── */
  let _pv = null;

  function openProvider(p) {
    _pv = p
      ? { edit: true, id: p.id, name: p.name, preset: p.preset || "", base_url: p.base_url, models: p.models || {} }
      : { edit: false, id: "", name: "", preset: FA.presets[0] ? FA.presets[0].key : "", base_url: "", models: {} };
    document.getElementById("pvTitle").textContent = p ? `编辑供应商 · ${p.name}` : "新增供应商";
    document.getElementById("pvErr").textContent = "";
    document.getElementById("pvErr").className = "";
    paintProviderForm();
    document.getElementById("pvMask").classList.add("show");
  }

  function paintProviderForm() {
    const e = _pv;
    const body = document.getElementById("pvBody");
    const preset = FA.presets.find((x) => x.key === e.preset);
    const custom = !preset;
    body.innerHTML = `
      <label>名称</label>
      <input id="pvName" spellcheck="false" value="${esc(e.name)}" placeholder="例如：我的智谱通道">
      <label>预设</label>
      <select id="pvPreset" ${e.edit ? "disabled" : ""}>
        ${FA.presets.map((x) => `<option value="${esc(x.key)}"${e.preset === x.key ? " selected" : ""}>${esc(x.name)}</option>`).join("")}
        <option value=""${custom ? " selected" : ""}>自定义（Anthropic 兼容网关）</option>
      </select>
      <div class="tip">${
        preset
          ? `Base <code>${esc(preset.base_url)}</code> · 鉴权字段 <code>${esc(preset.auth_field)}</code> · 默认模型 <code>${esc(preset.models.default)}</code>。选预设只需填 Key，四档模型已钉死（防 CLI 回落官方默认名被网关拒）。`
          : "自定义通道需要自己填 Base URL、鉴权字段与四档模型名。"
      }</div>
      <label>API Key${e.edit ? "（留空即保持不变）" : ""}</label>
      <input id="pvKey" type="password" autocomplete="off" placeholder="${e.edit ? "已配置，留空保持原 Key" : "sk-..."}">
      ${
        custom
          ? `
      <label>Base URL</label>
      <input id="pvBase" spellcheck="false" value="${esc(e.base_url)}" placeholder="https://your-gateway.com/anthropic">
      <label>鉴权字段</label>
      <select id="pvAuth">
        <option value="ANTHROPIC_AUTH_TOKEN">ANTHROPIC_AUTH_TOKEN（Bearer 网关，多数中转）</option>
        <option value="ANTHROPIC_API_KEY">ANTHROPIC_API_KEY（x-api-key，官方口径）</option>
      </select>
      <label>默认模型</label>
      <input id="pvM0" spellcheck="false" value="${esc(e.models.default || "")}" placeholder="例如 glm-4.7">
      <label>小模型（haiku 档，后台小任务用）</label>
      <input id="pvM3" spellcheck="false" value="${esc(e.models.haiku || "")}" placeholder="留空则与默认模型相同">`
          : ""
      }`;
    const sel = body.querySelector("#pvPreset");
    if (sel && !e.edit)
      sel.onchange = (ev) => {
        _pv.preset = ev.target.value;
        const pp = FA.presets.find((x) => x.key === _pv.preset);
        if (pp && !_pv.name) _pv.name = pp.name;
        paintProviderForm();
      };
  }

  function closeProvider() {
    document.getElementById("pvMask").classList.remove("show");
    _pv = null;
  }

  async function saveProvider() {
    const err = document.getElementById("pvErr");
    const g = (id) => {
      const el = document.getElementById(id);
      return el ? el.value.trim() : "";
    };
    const name = g("pvName");
    const key = g("pvKey");
    if (!name) {
      err.className = "";
      err.textContent = "名称不能为空";
      return;
    }
    err.className = "";
    err.textContent = "保存中…";
    try {
      let id = _pv.id;
      if (_pv.edit) {
        const models = _pv.preset
          ? undefined
          : { default: g("pvM0"), opus: g("pvM0"), sonnet: g("pvM0"), haiku: g("pvM3") || g("pvM0") };
        await jpost(`/v1/providers/${encodeURIComponent(id)}/update`, {
          name,
          secret: key || null,
          base_url: _pv.preset ? null : g("pvBase"),
          auth_field: _pv.preset ? null : g("pvAuth"),
          models,
        });
      } else {
        if (!key) {
          err.textContent = "新增供应商必须填 API Key";
          return;
        }
        id = `prov_${_pv.preset || "custom"}_${Math.random().toString(36).slice(2, 7)}`;
        const body = { id, name, secret: key };
        if (_pv.preset) {
          body.preset = _pv.preset;
        } else {
          const m0 = g("pvM0");
          if (!g("pvBase") || !m0) {
            err.textContent = "自定义通道必须填 Base URL 与默认模型";
            return;
          }
          body.base_url = g("pvBase");
          body.auth_field = g("pvAuth");
          body.models = { default: m0, opus: m0, sonnet: m0, haiku: g("pvM3") || m0 };
        }
        await jpost("/v1/providers", body);
      }
      err.className = "";
      err.textContent = "已保存，正在测试连通…";
      let pr;
      try {
        pr = await jpost(`/v1/providers/${encodeURIComponent(id)}/probe`, {});
      } catch (e) {
        pr = { ok: false, message: e.message };
      }
      FA.probe[id] = pr;
      FA.prov = await jget("/v1/providers");
      // 还没有 active 就顺手激活（预检通过才会成功）
      if (!FA.prov.active && pr.ok) {
        try {
          await jpost(`/v1/providers/${encodeURIComponent(id)}/activate`, {});
          FA.prov = await jget("/v1/providers");
        } catch {
          /* 激活失败不影响保存 */
        }
      }
      closeProvider();
      paintSettings();
      toast(pr.ok ? "已保存，连通正常" : "已保存，但连通测试没过：" + (pr.message || ""));
    } catch (e) {
      err.className = "";
      err.textContent = e.message;
    }
  }

  /* ═══════════════ 创作面板 ═══════════════ */

  const FIELDS = [
    ["fName", "你的名字 / 品牌名", "input", "林知夏", ""],
    ["fRole", "身份 / 职业", "input", "独立设计师 & 艺术指导", ""],
    ["fBio", "一句话介绍", "textarea", "用设计、影像和文字，把复杂的想法变成清晰而动人的体验。", "会出现在首屏，越具体越好"],
    ["fAbout", "关于你（经历、方法、在意什么）", "textarea", "", "写多少都行，AI 会自己提炼与扩写"],
    ["fWorks", "代表项目（一行一个：名称｜类型｜一句话）", "textarea", "", "例：城市漫游手册｜编辑设计｜为独立书店做的一套年度出版物"],
    ["fExp", "经历（一行一个：时间｜角色｜说明）", "textarea", "", "例：2023—NOW｜独立设计实践｜品牌与数字体验"],
    ["fSkills", "擅长 / 提供的服务", "textarea", "", "逗号或换行分隔即可"],
    ["fEmail", "联系邮箱", "input", "hello@example.com", ""],
    ["fLocation", "所在地 / 接单范围", "input", "上海 · 可远程合作", ""],
    ["fSocial", "社交链接（一行一个：名称｜网址）", "textarea", "", "例：小红书｜https://..."],
    ["fTone", "语气与风格倾向（可留空）", "textarea", "", "例：克制、少形容词、偏编辑部口吻"],
  ];

  function paintForm() {
    const host = document.getElementById("faForm");
    const visual = templates.filter((t) => !t.standaloneFile);
    const stand = templates.filter((t) => t.standaloneFile);
    host.innerHTML = `
      <div class="fh">01 · 选一套版式</div>
      <div class="fa-field">
        <span>模板</span>
        <select id="faTpl">
          <optgroup label="视觉系统 · AI 填充内容（${visual.length}）">
            ${visual.map((t) => `<option value="${esc(t.id)}">${esc(t.name)} — ${esc(t.subtitle)}</option>`).join("")}
          </optgroup>
          <optgroup label="独立成品 · AI 深度改写配置（${stand.length}）">
            ${stand.map((t) => `<option value="${esc(t.id)}">${esc(t.name)} — ${esc(t.subtitle)}</option>`).join("")}
          </optgroup>
        </select>
        <div class="hintline" id="faTplHint"></div>
      </div>
      <div class="fa-field">
        <span>强调色</span>
        <input id="faAccent" type="color" value="${esc(FA.accent)}" style="height:40px;padding:4px">
      </div>

      <div class="fh">02 · 说说你自己</div>
      ${FIELDS.map(
        ([id, label, kind, ph, hint]) => `
        <label class="fa-field">
          <span>${label}</span>
          ${kind === "textarea" ? `<textarea id="${id}" rows="3" placeholder="${esc(ph)}"></textarea>` : `<input id="${id}" placeholder="${esc(ph)}">`}
          ${hint ? `<div class="hintline">${hint}</div>` : ""}
        </label>`,
      ).join("")}

      <div class="fh">03 · 走哪条通道</div>
      <div class="fa-modes" id="faEngines">
        <button class="fa-mode on" type="button" data-engine="api"><i></i><div><strong>API 直连（推荐）</strong><small>用「设置 → API 切换」里当前使用的供应商，零子进程，最快。</small></div></button>
        <button class="fa-mode" type="button" data-engine="claude"><i></i><div><strong>本机 Claude Code CLI</strong><small>用本机已登录的 claude。需要环境医生里 claude 为「已就绪」。</small></div></button>
      </div>

      <button class="fa-go" type="button" id="faRun">开始生成</button>
      <button class="fa-btn fa-stop" type="button" id="faCancel" style="display:none">停止生成</button>
      <button class="fa-btn fa-stop" type="button" id="faDirect">跳过 AI · 直接套用这套模板</button>
    `;

    const sel = host.querySelector("#faTpl");
    sel.value = FA.tplId;
    sel.onchange = () => {
      FA.tplId = sel.value;
      syncTemplate();
    };
    host.querySelector("#faAccent").oninput = (e) => {
      FA.accent = e.target.value;
    };
    host.querySelectorAll("#faEngines .fa-mode").forEach((b) => {
      b.onclick = () => {
        host.querySelectorAll("#faEngines .fa-mode").forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
      };
    });
    host.querySelector("#faRun").onclick = runGeneration;
    host.querySelector("#faCancel").onclick = cancelGeneration;
    host.querySelector("#faDirect").onclick = directRender;
    syncTemplate();
  }

  function syncTemplate() {
    const t = getTemplate(FA.tplId);
    FA.mode = t.standaloneFile ? "config" : "profile";
    FA.accent = FA.accent || t.accent;
    const hint = document.getElementById("faTplHint");
    if (hint)
      hint.innerHTML =
        FA.mode === "config"
          ? "这是一套完整独立成品（含项目、经历、动效）。AI 会<b>改写它内置的 PORTFOLIO_CONFIG</b>，键名与结构一字不动，只换成你的内容。"
          : "这是一套视觉系统。AI 会产出一份结构化 profile，再交给 FORMA 自己的渲染器出页面。";
    const acc = document.getElementById("faAccent");
    if (acc && t.accent) {
      acc.value = t.accent;
      FA.accent = t.accent;
    }
  }

  function collect() {
    const g = (id) => (document.getElementById(id) || {}).value || "";
    return {
      name: g("fName").trim() || "你的名字",
      role: g("fRole").trim() || "独立创作者",
      bio: g("fBio").trim(),
      about: g("fAbout").trim(),
      works: g("fWorks").trim(),
      exp: g("fExp").trim(),
      skills: g("fSkills").trim(),
      email: g("fEmail").trim(),
      location: g("fLocation").trim(),
      social: g("fSocial").trim(),
      tone: g("fTone").trim(),
    };
  }

  function userBlock(v) {
    const rows = [
      ["姓名 / 品牌名", v.name],
      ["身份 / 职业", v.role],
      ["一句话介绍", v.bio],
      ["关于我", v.about],
      ["代表项目", v.works],
      ["经历", v.exp],
      ["擅长 / 服务", v.skills],
      ["联系邮箱", v.email],
      ["所在地", v.location],
      ["社交链接", v.social],
      ["语气与风格倾向", v.tone],
    ].filter(([, val]) => val);
    return rows.map(([k, val]) => `【${k}】${val}`).join("\n");
  }

  const COMMON_RULES = `
写作要求：
- 中文为主，克制、具体、有专业质感；不要空洞的形容词堆砌。
- 用户没写到的部分，基于他已给的信息合理推演补齐，让整页看起来完整。
- 但凡是可核验的事实（真实公司名、奖项、客户、学校、精确数字），用户没提供就不要编造，改用"示例"或中性表述占位。
- 严格只输出要求的那个对象本体，不要 markdown 代码围栏，不要任何解释性文字。`;

  const PROFILE_SCHEMA = `{
  "name": "", "role": "", "bio": "一句话首屏介绍",
  "aboutTitle": "关于区的大标题（一句有观点的话）",
  "about": "关于区正文，2-4 句",
  "location": "", "email": "",
  "availability": "当前接单/求职状态一句话",
  "services": [{"title":"","description":"","meta":"英文小标签"}],
  "metrics": [{"value":"08+","label":"年经验"}],
  "works": [{"title":"","meta":"类型 · 角色","description":"一句话说明"}],
  "experience": [{"period":"2023—NOW","title":"","detail":""}],
  "journal": [{"date":"06.18","topic":"FIELD NOTE","title":"","excerpt":""}],
  "clients": ["合作方或关键词"],
  "socials": [{"label":"","href":""}],
  "testimonial": {"quote":"","by":"","role":""}
}`;

  function buildProfilePrompt(v) {
    const t = getTemplate(FA.tplId);
    return {
      system: `你是 FORMA 个人网站创作助手。你的任务是把用户的自述，整理成一份用于渲染个人网站的 JSON 对象。

目标版式：「${t.name} — ${t.subtitle}」（方向：${t.search}）。文案气质要贴合这套版式。

只输出一个合法 JSON 对象，结构如下（数组长度：services 恰好 3、metrics 恰好 4、works 恰好 4、experience 3-4、journal 恰好 3、clients 6-8、socials 3）：
${PROFILE_SCHEMA}
${COMMON_RULES}`,
      user: userBlock(v),
    };
  }

  function buildConfigPrompt(v, configText) {
    const t = getTemplate(FA.tplId);
    return {
      system: `你是 FORMA 个人网站创作助手。下面会给你一份网页模板的配置对象（JavaScript 对象字面量）和一位用户的自述。

请输出一个**结构完全相同**的新对象：键名、嵌套层级、数组元素个数、每个元素的字段全部保持不变，只把「值」换成符合这位用户的新内容。图片/art/symbol/number 这类版式字段保持原值或按原规律递增，href 没有真实链接就保留 "#"。

目标版式：「${t.name} — ${t.subtitle}」。
${COMMON_RULES}
再强调一次：只输出那个对象字面量本身，以 { 开头、以 } 结尾。`,
      user: `【用户自述】\n${userBlock(v)}\n\n【原配置对象】\n${configText}`,
    };
  }

  /* ── 独立成品：抠出 / 换回 PORTFOLIO_CONFIG ── */

  function findConfig(html) {
    const i = html.indexOf("window.PORTFOLIO_CONFIG");
    if (i < 0) return null;
    const s = html.indexOf("{", i);
    if (s < 0) return null;
    let depth = 0;
    let str = null;
    let escNext = false;
    for (let j = s; j < html.length; j++) {
      const c = html[j];
      if (str) {
        if (escNext) escNext = false;
        else if (c === "\\") escNext = true;
        else if (c === str) str = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        str = c;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return { start: s, end: j + 1, text: html.slice(s, j + 1) };
      }
    }
    return null;
  }

  /** 从模型输出里取出第一个平衡的 {...} 块，顺手剥掉 markdown 围栏 */
  function extractObject(raw) {
    let t = String(raw || "").trim();
    t = t.replace(/^```(?:json|javascript|js)?\s*/i, "").replace(/```\s*$/, "");
    const s = t.indexOf("{");
    if (s < 0) return null;
    let depth = 0;
    let str = null;
    let escNext = false;
    for (let j = s; j < t.length; j++) {
      const c = t[j];
      if (str) {
        if (escNext) escNext = false;
        else if (c === "\\") escNext = true;
        else if (c === str) str = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        str = c;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return t.slice(s, j + 1);
      }
    }
    return null;
  }

  /* ── 日志 / 面板 ── */

  function log(text, cls) {
    const el = document.getElementById("faLog");
    if (!el) return;
    const span = document.createElement("span");
    if (cls) span.className = cls;
    span.textContent = text;
    el.appendChild(span);
    el.scrollTop = el.scrollHeight;
  }
  function clearLog() {
    document.getElementById("faLog").textContent = "";
  }
  function showPane(name) {
    document.querySelectorAll("#faTabs button").forEach((b) => b.classList.toggle("on", b.dataset.pane === name));
    document.querySelectorAll(".fa-pane").forEach((p) => p.classList.toggle("on", p.dataset.pane === name));
    if (name === "sites") loadSites();
  }

  function setPreview(html) {
    FA.html = html;
    const f = document.getElementById("faPreview");
    f.removeAttribute("src");
    f.srcdoc = html;
  }

  /* ── 直接套模板（不调 AI） ── */
  async function directRender() {
    const t = getTemplate(FA.tplId);
    const v = collect();
    if (FA.mode === "config") {
      const html = await fetch(standaloneUrl(t)).then((r) => r.text());
      setPreview(html);
      toast("已套用独立成品原稿，可下载后搜索 PORTFOLIO_CONFIG 自行修改");
    } else {
      const profile = { name: v.name, role: v.role, bio: v.bio || t.bio, accent: FA.accent, email: v.email, location: v.location };
      FA.lastProfile = profile;
      setPreview(renderTemplate(t, profile));
      toast("已用你填的基本信息套好版式");
    }
    showPane("preview");
  }

  /* ── 跑一次生成 ── */

  async function runGeneration() {
    if (!FA.ready) {
      toast("后端没连上，先看「设置 → 运行环境」");
      return;
    }
    if (FA.running) return;
    const t = getTemplate(FA.tplId);
    const v = collect();
    if (!v.about && !v.works && !v.exp && !v.bio) {
      toast("至少写点东西 —— 一句话介绍或关于你，随便哪个");
      return;
    }

    let prompt;
    let configSlot = null;
    let baseHtml = "";
    clearLog();
    showPane("log");
    setRunning(true);

    try {
      if (FA.mode === "config") {
        log(`读取独立成品 ${t.name} …\n`, "ev");
        baseHtml = await fetch(standaloneUrl(t)).then((r) => r.text());
        configSlot = findConfig(baseHtml);
        if (!configSlot) throw new Error("这套模板里没找到 PORTFOLIO_CONFIG，无法深度改写");
        log(`已抠出配置对象（${configSlot.text.length} 字符），交给模型改写…\n\n`, "ev");
        prompt = buildConfigPrompt(v, configSlot.text);
      } else {
        log(`版式 ${t.name} · AI 填充模式，请求模型生成 profile…\n\n`, "ev");
        prompt = buildProfilePrompt(v);
      }
    } catch (e) {
      log("\n✕ " + e.message + "\n", "bad");
      setRunning(false);
      return;
    }

    const engineBtn = document.querySelector("#faEngines .fa-mode.on");
    const engine = (engineBtn && engineBtn.dataset.engine) || "api";
    let submitted;
    try {
      submitted = await jpost("/v1/tasks", {
        prompt: prompt.user,
        system_prompt: prompt.system,
        engine,
        kind: "text",
        tenant: "forma",
        cancel_on_disconnect: true,
      });
    } catch (e) {
      log("\n✕ 提交任务失败：" + e.message + "\n", "bad");
      setRunning(false);
      return;
    }

    FA.task = submitted.task_id;
    if (submitted.rerouted) log(`（调度器把引擎改路成 ${submitted.engine}）\n`, "ev");

    let acc = "";
    const es = new EventSource(`${FA.api}/v1/tasks/${encodeURIComponent(FA.task)}/events`);
    FA.es = es;

    es.onmessage = (m) => {
      let ev;
      try {
        ev = JSON.parse(m.data);
      } catch {
        return;
      }
      switch (ev.type) {
        case "queued":
          log(`排队中（第 ${ev.position} 位）…\n`, "ev");
          break;
        case "started":
          log(`已开始生成。\n\n`, "ev");
          break;
        case "delta":
          acc += ev.text;
          log(ev.text);
          break;
        case "tool_use":
          log(`\n[工具] ${ev.name} ${ev.summary}\n`, "ev");
          break;
        case "usage":
          log(`\n\n（用量：输入 ${ev.input_tokens} · 输出 ${ev.output_tokens} tokens）\n`, "ev");
          break;
        case "done":
          finish(ev.result || acc);
          break;
        case "error":
          log(`\n✕ ${ev.code}：${ev.detail}\n`, "bad");
          if (ev.code === "auth" || ev.code === "provider_error")
            log("→ 多半是 API Key / Base URL 不对。去「设置 → API 切换」测一下连通。\n", "bad");
          if (ev.code === "engine_unavailable")
            log("→ 本机没装对应 CLI。去「设置 → 环境医生」看引导，或改用 API 直连。\n", "bad");
          setRunning(false);
          es.close();
          break;
        case "state_changed":
          if (["canceled", "error", "done"].includes(ev.state)) {
            if (ev.state === "canceled") log("\n已停止。\n", "ev");
            setRunning(false);
            es.close();
          }
          break;
      }
    };
    es.onerror = () => {
      if (FA.running) log("\n（事件流断开，任务可能仍在后台跑；重新点生成即可）\n", "bad");
      setRunning(false);
      es.close();
    };

    function finish(text) {
      es.close();
      setRunning(false);
      const obj = extractObject(text);
      if (!obj) {
        log("\n✕ 模型没有返回可用的对象。可以再点一次生成，或换一条通道。\n", "bad");
        return;
      }
      if (FA.mode === "config") {
        const html = baseHtml.slice(0, configSlot.start) + obj + baseHtml.slice(configSlot.end);
        setPreview(html);
        FA.lastProfile = null;
        log("\n\n✓ 配置已换回模板，右上切到「预览」看看。\n", "ev");
      } else {
        let profile;
        try {
          profile = JSON.parse(obj);
        } catch (e) {
          log("\n✕ 返回的 JSON 解析失败：" + e.message + "\n", "bad");
          return;
        }
        profile.accent = FA.accent || t.accent;
        if (!profile.name) profile.name = v.name;
        FA.lastProfile = profile;
        setPreview(renderTemplate(t, profile));
        log("\n\n✓ 已渲染成页面，右上切到「预览」看看。\n", "ev");
      }
      showPane("preview");
      toast("生成完成");
    }
  }

  function setRunning(on) {
    FA.running = on;
    const run = document.getElementById("faRun");
    const stop = document.getElementById("faCancel");
    if (run) {
      run.disabled = on;
      run.textContent = on ? "生成中…" : "开始生成";
    }
    if (stop) stop.style.display = on ? "" : "none";
  }

  async function cancelGeneration() {
    if (!FA.task) return;
    try {
      await jpost(`/v1/tasks/${encodeURIComponent(FA.task)}/cancel`, {});
      log("\n已请求停止…\n", "ev");
    } catch (e) {
      toast(e.message);
    }
  }

  /* ── 站点保存 / 列表 ── */

  // 后端只保留字母数字与 - _（防路径穿越），中文名会被吃掉，
  // 所以这里先自己压成 ASCII slug，再补随机尾巴避免覆盖同名旧站点。
  function slugify(s) {
    const ascii = String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return (ascii || "site") + "-" + Math.random().toString(36).slice(2, 6);
  }

  async function saveSite() {
    if (!FA.html) {
      toast("还没有生成内容");
      return;
    }
    if (!FA.ready) {
      toast("后端没连上，无法保存");
      return;
    }
    const t = getTemplate(FA.tplId);
    const v = collect();
    try {
      const r = await jpost("/v1/sites", {
        slug: slugify(v.name + "-" + t.id),
        name: `${v.name} · ${t.name}`,
        template: t.id,
        html: FA.html,
        profile: FA.lastProfile || {},
      });
      toast("已保存到 " + r.dir);
      loadSites();
    } catch (e) {
      toast("保存失败：" + e.message);
    }
  }

  async function loadSites() {
    const host = document.getElementById("faSiteList");
    if (!host) return;
    if (!FA.ready) {
      host.innerHTML = `<div class="fa-msg err">后端未连接</div>`;
      return;
    }
    try {
      const r = await jget("/v1/sites");
      const list = r.sites || [];
      host.innerHTML = list.length
        ? list
            .map(
              (s) => `<div class="fa-siteRow">
          <div><div class="sn">${esc(s.name || s.slug)}</div><div class="sm">${esc(s.template)} · ${esc(s.dir)}</div></div>
          <div class="sa">
            <button class="fa-btn sm" type="button" data-site-reveal="${esc(s.slug)}">打开目录</button>
            <button class="fa-btn sm danger" type="button" data-site-del="${esc(s.slug)}">删除</button>
          </div>
        </div>`,
            )
            .join("")
        : `<div class="fa-msg info">还没有保存过站点。生成一份后点右上「保存到我的站点」，会落在 <code>${esc((FA.app && FA.app.sitesDir) || "数据目录/sites")}</code>。</div>`;
      host.querySelectorAll("[data-site-reveal]").forEach((b) => {
        b.onclick = () =>
          jpost(`/v1/sites/${encodeURIComponent(b.dataset.siteReveal)}/reveal`, {}).catch((e) => toast(e.message));
      });
      host.querySelectorAll("[data-site-del]").forEach((b) => {
        b.onclick = async () => {
          if (!confirm("删除这个站点目录？")) return;
          try {
            await jpost(`/v1/sites/${encodeURIComponent(b.dataset.siteDel)}/delete`, {});
            loadSites();
          } catch (e) {
            toast(e.message);
          }
        };
      });
    } catch (e) {
      host.innerHTML = `<div class="fa-msg err">${esc(e.message)}</div>`;
    }
  }

  /* ─────────── 启动 ─────────── */

  async function boot() {
    injectShell();

    document.querySelectorAll("[data-fa-close]").forEach((b) => {
      b.onclick = () => closeView(b.dataset.faClose);
    });
    document.getElementById("faNavAgent").onclick = () => {
      openView("faAgentView");
      if (!document.getElementById("faTpl")) paintForm();
    };
    document.getElementById("faNavSet").onclick = () => {
      openView("faSetView");
      loadSettings();
    };
    document.getElementById("faGoSet").onclick = () => {
      openView("faSetView");
      loadSettings();
    };
    document.getElementById("faTabs").onclick = (e) => {
      const b = e.target.closest("[data-pane]");
      if (b) showPane(b.dataset.pane);
    };
    document.getElementById("faSitesRefresh").onclick = loadSites;
    document.getElementById("faSave").onclick = saveSite;
    document.getElementById("faDownload").onclick = () => {
      if (!FA.html) return toast("还没有生成内容");
      const t = getTemplate(FA.tplId);
      const blob = new Blob([FA.html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(collect().name || "personal-site").replace(/[\\/:*?"<>|]+/g, "-")}-${t.id}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    };
    document.getElementById("faOpenTab").onclick = () => {
      if (!FA.html) return toast("还没有生成内容");
      const blob = new Blob([FA.html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    };
    document.getElementById("pvCancel").onclick = closeProvider;
    document.getElementById("pvSave").onclick = saveProvider;
    document.getElementById("pvMask").addEventListener("click", (e) => {
      if (e.target.id === "pvMask") closeProvider();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (document.getElementById("pvMask").classList.contains("show")) return closeProvider();
      const open = document.querySelector(".fa-view.on");
      if (open) closeView(open.id);
    });

    // 模板卡片上的「用此模板」直接带进创作面板
    const useBtn = document.getElementById("useTemplate");
    if (useBtn) {
      useBtn.addEventListener(
        "click",
        () => {
          const t = getTemplate(state && state.activeId);
          if (!t) return;
          FA.tplId = t.id;
          openView("faAgentView");
          if (!document.getElementById("faTpl")) paintForm();
          else {
            document.getElementById("faTpl").value = t.id;
            syncTemplate();
          }
        },
        true,
      );
    }

    FA.api = await detectBackend();
    FA.ready = Boolean(FA.api);
    paintConn();
    if (FA.ready) console.info("[forma] 后端:", FA.api);
    else console.warn("[forma] 未发现本机后端");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.FORMA_AGENT = FA;
})();
