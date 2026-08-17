/**
 * 首页 —— 数字人需求访谈。
 *
 * 一句话说清这个页面在干嘛：左边站着一个会说话的数字人，右边是对话栏，
 * 最右边是一张跟着对话实时长出来的需求单。聊满 5 轮，需求单齐了，就能开工。
 *
 * 结构与状态：
 *   gate  姓名门禁 —— 不填名字不给聊（名字要印在作品和分享海报上）
 *   talk  访谈中   —— AI 主动追问，每答一句需求单补一格
 *   build 生成中   —— 分阶段占位进度（真实生成链路还没接）
 *
 * 几个不太显然的决定：
 *  1. 形象不用视频、不用图。参考实现（真昼口袋版）是 2.9MB 单文件、内嵌 base64
 *     视频 + 三帧口型图，那套东西塞进 Worker 直出的 HTML 里是灾难 —— 每次首页
 *     请求都要吐几 MB。这里改成纯 CSS/SVG 的声波环 + 光晕 + 7 根波形柱，
 *     整页不到 30KB，而且不依赖任何外部资源。
 *  2. 口型驱动逻辑照搬真昼的「快攻慢放」：拿不到音频包络（speechSynthesis 不给
 *     音频流），就用节拍法伪造 —— 每 90~150ms 抽一个开合目标，当前值瞬间追上
 *     目标再按 0.62 衰减，遇标点短停。视觉上和真口型几乎没区别。
 *  3. 对话后端 /api/interview 还没写。前端先打这个接口，失败或超时就切到本地
 *     脚本化追问（persona.js 里的 SCRIPT），并且**只失败一次就永久转本地** ——
 *     不然每轮都要等 12 秒超时，现场没人受得了。
 *  4. 页面里绝不出现任何 API Key。模型调用一律由服务端代理。
 *
 * 调试入口：/#demo=gate|talk|ready|build 可以直接跳到某个状态，用于截图核对布局。
 */
import { page } from './layout.js';
import { BRAND, esc } from './brand.js';
import {
  AGENT, NAME_MAX, SPEC_FIELDS, SCRIPT, ACKS, KEYWORDS,
  OPENING, CLOSING, GEN_PHASES,
} from './persona.js';

/**
 * 往内联 <script> 里塞 JSON。
 * 直接 JSON.stringify 是不够的：字符串里只要出现 </script 就会提前闭合脚本标签，
 * 所以 < 一律转成 <。行分隔符同理（老式 JS 解析器会当成换行）。
 */
const J = (v) =>
  JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/\\u2028/g, '\\u2028')
    .replace(/\\u2029/g, '\\u2029');

/** 需求单的一行（服务端先渲出占位，JS 只负责填值，无 JS 时也不是白板） */
function specRow(f) {
  return `<div class="sf" id="sf-${f.key}">
    <span class="si">${f.icon}</span>
    <div class="sb">
      <div class="sl">${esc(f.label)}</div>
      <div class="sv" id="sv-${f.key}">${esc(f.hint)}</div>
    </div>
  </div>`;
}

/** 生成演出的一行 */
function genRow(p, i) {
  return `<div class="gp"><span class="gn">${String(i + 1).padStart(2, '0')}</span>
    <div class="gb"><b>${esc(p.label)}</b><span>${esc(p.note)}</span></div>
    <span class="gs"></span></div>`;
}

export function homeHtml({ user }) {
  const op = OPENING('%N%'); // %N% 由前端替换成真实姓名

  return page({
    title: `${BRAND.name} · ${BRAND.slogan}`,
    desc: `跟${AGENT.name}聊两分钟，把想法聊成一份需求单，然后生成属于你的网站。`,
    active: 'home',
    user,

    css: `
:root{--hd:72px}
body{overflow:hidden;
  background-image:radial-gradient(1100px 620px at 22% 8%,rgba(102,217,232,.10),transparent 60%),
                   radial-gradient(760px 520px at 92% 92%,rgba(181,138,224,.08),transparent 62%)}

/* ── 三栏：舞台 / 对话 / 需求单 ── */
.iv{display:flex;height:calc(100vh - var(--hd));overflow:hidden}
.stage{position:relative;flex:1 1 440px;min-width:0;overflow:hidden;--lv:0}
.side{flex:0 0 376px;min-width:0;display:flex;flex-direction:column;
  border-left:1px solid var(--line);background:rgba(8,13,22,.60);backdrop-filter:blur(14px)}
.spec{flex:0 0 312px;min-width:0;display:flex;flex-direction:column;
  border-left:1px solid var(--line);background:rgba(6,10,17,.72)}

/* ── 舞台：光晕 + 声波环 + 波形柱 ── */
.orbwrap{position:absolute;left:50%;top:46%;transform:translate(-50%,-50%);
  width:min(52vh,380px);aspect-ratio:1}
.halo{position:absolute;inset:-16%;border-radius:50%;
  background:radial-gradient(circle,rgba(102,217,232,.20),rgba(181,138,224,.07) 46%,transparent 66%);
  filter:blur(22px);animation:breath 4.8s ease-in-out infinite}
.rings{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.rings circle{fill:none;transform-origin:50% 50%;transform-box:fill-box}
.rings .r1{stroke:url(#ivg);stroke-width:1.6;opacity:calc(.30 + var(--lv)*.60);transform:scale(calc(1 + var(--lv)*.10))}
.rings .r2{stroke:url(#ivg);stroke-width:1.1;opacity:calc(.16 + var(--lv)*.46);transform:scale(calc(1 + var(--lv)*.17))}
.rings .r3{stroke:url(#ivg);stroke-width:1;opacity:calc(.08 + var(--lv)*.32);transform:scale(calc(1 + var(--lv)*.24))}
.rings .rd{stroke:rgba(102,217,232,.30);stroke-width:1;stroke-dasharray:2 14;opacity:.42;
  animation:spin 34s linear infinite}
.core{position:absolute;left:50%;top:50%;width:50%;height:50%;border-radius:50%;
  transform:translate(-50%,-50%) scale(calc(1 + var(--lv)*.14));
  background:radial-gradient(circle at 42% 36%,rgba(102,217,232,.50),rgba(181,138,224,.20) 48%,transparent 72%);
  filter:blur(7px);opacity:calc(.52 + var(--lv)*.48)}
.bars{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  display:flex;align-items:center;gap:9px;height:104px}
.bars i{display:block;width:7px;height:100%;border-radius:5px;transform:scaleY(.08);
  background:linear-gradient(180deg,#66d9e8,#b58ae0);box-shadow:0 0 18px rgba(102,217,232,.40)}
@keyframes breath{0%,100%{opacity:.45;transform:scale(.97)}50%{opacity:1;transform:scale(1.03)}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes blink{0%,100%{opacity:.32}50%{opacity:1}}

/* 状态 chip：在听 / 在想 / 在说 —— 三种状态必须一眼可见 */
.chiprow{position:absolute;left:0;right:0;top:22px;display:flex;justify-content:center;gap:10px;z-index:4}
.stchip{display:inline-flex;align-items:center;gap:9px;padding:6px 15px;border-radius:999px;
  border:1px solid var(--line);background:rgba(7,11,18,.66);backdrop-filter:blur(8px);
  font-family:var(--mono);font-size:11.5px;letter-spacing:.2em;color:var(--muted-light)}
.stchip i{width:6px;height:6px;border-radius:50%;background:#6ad39a;box-shadow:0 0 10px #6ad39a;flex:0 0 6px}
.mode-think .stchip i{background:var(--gold);box-shadow:0 0 10px var(--gold);animation:blink 1.1s ease-in-out infinite}
.mode-speak .stchip i{background:var(--acid);box-shadow:0 0 12px var(--acid)}
.who{position:absolute;left:24px;top:22px;z-index:4;font-family:var(--mono);font-size:11px;
  letter-spacing:.22em;color:var(--dim)}
.who b{display:block;font-family:var(--sans);font-size:15px;letter-spacing:.02em;
  color:var(--text);font-weight:650;margin-bottom:3px}
/* THINKING 呼吸灯，沿用参考实现的位置与手感 */
.think{position:absolute;left:24px;top:76px;z-index:4;font-family:var(--mono);font-size:11px;
  letter-spacing:.16em;color:var(--acid);opacity:0;transition:opacity .45s}
.think.on{opacity:1;animation:blink 2.1s ease-in-out infinite}

.sub{position:absolute;left:0;right:0;bottom:0;z-index:5;padding:70px 34px 30px;
  font-size:18px;line-height:1.85;min-height:96px;opacity:0;transition:opacity .35s;
  background:linear-gradient(180deg,transparent,rgba(4,7,13,.92));text-shadow:0 1px 10px rgba(0,0,0,.8)}
.sub.on{opacity:1}

/* ── 生成演出态 ── */
.gen{position:absolute;left:50%;bottom:26px;transform:translateX(-50%);z-index:6;
  width:min(520px,calc(100% - 48px));padding:18px 20px 16px;border-radius:14px;
  border:1px solid var(--line-strong);background:rgba(7,11,18,.90);backdrop-filter:blur(16px);
  opacity:0;pointer-events:none;transition:opacity .3s}
.gen.on{opacity:1;pointer-events:auto}
.gen h3{font-size:13px;letter-spacing:.16em;font-family:var(--mono);color:var(--acid);
  font-weight:500;margin-bottom:13px}
.gbar{height:3px;border-radius:2px;background:rgba(217,226,234,.10);overflow:hidden;margin-bottom:13px}
.gbar i{display:block;height:100%;width:0;border-radius:2px;transition:width .6s ease;
  background:linear-gradient(90deg,#66d9e8,#b58ae0)}
.gp{display:flex;align-items:center;gap:11px;padding:5px 0;opacity:.34;transition:opacity .3s}
.gp.run,.gp.done{opacity:1}
.gn{font-family:var(--mono);font-size:11px;color:var(--dim);flex:0 0 20px}
.gb{flex:1;min-width:0}
.gb b{display:block;font-size:13.5px;font-weight:600}
.gb span{font-size:11.5px;color:var(--dim)}
.gs{flex:0 0 16px;height:16px;border-radius:50%;border:1px solid var(--line)}
.gp.run .gs{border-color:var(--acid);border-top-color:transparent;animation:spin .9s linear infinite}
.gp.done .gs{border-color:transparent;background:none}
.gp.done .gs::after{content:"✓";display:block;text-align:center;line-height:16px;font-size:12px;color:#6ad39a}
.gnote{margin-top:10px;padding-top:10px;border-top:1px solid var(--line);
  font-size:11.5px;color:var(--dim);line-height:1.7}

/* ── 对话栏 ── */
.shd{display:flex;align-items:center;gap:9px;padding:16px 16px 10px;
  font-family:var(--mono);font-size:10.5px;letter-spacing:.18em;color:var(--dim)}
.tag{margin-left:auto;padding:2px 9px;border-radius:4px;border:1px solid var(--line);
  font-size:10px;letter-spacing:.08em;color:var(--muted)}
.tag.ok{color:#6ad39a;border-color:rgba(106,211,154,.32)}
.tag.local{color:var(--gold);border-color:rgba(240,208,138,.30)}
#log{flex:1;min-height:0;overflow-y:auto;padding:6px 15px 4px;display:flex;flex-direction:column;gap:11px;
  scrollbar-width:thin;scrollbar-color:rgba(217,226,234,.18) transparent}
.msg{max-width:94%;padding:9px 13px;border-radius:11px;font-size:13.5px;line-height:1.75;
  white-space:pre-wrap;word-break:break-word;animation:rise .28s ease}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.msg.her{align-self:flex-start;background:rgba(102,217,232,.07);border:1px solid rgba(102,217,232,.15);
  border-bottom-left-radius:3px}
.msg.me{align-self:flex-end;background:rgba(181,138,224,.10);border:1px solid rgba(181,138,224,.22);
  border-bottom-right-radius:3px}
.msg.sys{align-self:center;max-width:100%;text-align:center;background:none;border:none;padding:2px;
  color:var(--dim);font-size:11.5px;font-family:var(--mono)}
.msg .w{display:block;font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;
  color:var(--dim);margin-bottom:4px}
/* 快捷回答：现场用手机打字太慢，能点就别让人打 */
#chips{display:flex;flex-wrap:wrap;gap:6px;padding:8px 15px 0}
#chips button{padding:5px 11px;border-radius:999px;border:1px dashed rgba(102,217,232,.30);
  background:rgba(102,217,232,.05);color:var(--muted-light);font-size:12px;cursor:pointer;
  transition:140ms ease}
#chips button:hover{color:var(--text);border-style:solid;background:rgba(102,217,232,.13)}
.inrow{display:flex;gap:7px;padding:10px 14px 4px}
#tin{flex:1;min-width:0;height:42px;max-height:120px;padding:10px 13px;border-radius:9px;resize:none;
  border:1px solid var(--line);background:rgba(4,7,13,.72);color:var(--text);
  font-family:var(--sans);font-size:13.5px;line-height:1.5;outline:none}
#tin:focus{border-color:var(--line-strong)}
#tin:disabled{opacity:.45}
.btn{padding:0 14px;border-radius:9px;cursor:pointer;font-size:13px;white-space:nowrap;
  border:1px solid rgba(102,217,232,.32);background:rgba(102,217,232,.10);color:var(--acid);
  transition:140ms ease}
.btn:hover:not(:disabled){background:rgba(102,217,232,.20)}
.btn:disabled{opacity:.38;cursor:not-allowed}
.btn.ghost{border-color:var(--line);background:transparent;color:var(--dim)}
.btn.ghost:hover:not(:disabled){color:#e2656b;border-color:rgba(226,101,107,.42);background:transparent}
.statbar{display:flex;justify-content:space-between;gap:10px;min-height:26px;padding:4px 15px 10px;
  font-family:var(--mono);font-size:11px;color:var(--dim)}
#status{color:var(--acid)}

/* ── 需求单 ── */
.sfoot,.shd2{padding:16px 16px 10px}
.shd2{display:flex;align-items:baseline;gap:9px;font-family:var(--mono);font-size:10.5px;
  letter-spacing:.18em;color:var(--dim)}
#specCnt{margin-left:auto;font-size:12px;color:var(--acid);letter-spacing:.06em}
#specList{flex:1;min-height:0;overflow-y:auto;padding:0 14px;display:flex;flex-direction:column;gap:8px;
  scrollbar-width:thin}
.sf{display:flex;gap:11px;padding:11px 13px;border-radius:10px;border:1px dashed var(--line);
  background:rgba(255,255,255,.012);transition:180ms ease}
.sf .si{flex:0 0 18px;font-size:13px;color:var(--dim);line-height:1.5}
.sf .sb{min-width:0;flex:1}
.sf .sl{font-size:11px;letter-spacing:.1em;color:var(--dim);margin-bottom:3px}
.sf .sv{font-size:13.5px;line-height:1.6;color:var(--dim);word-break:break-word}
.sf.on{border-style:solid;border-color:rgba(102,217,232,.30);background:rgba(102,217,232,.055)}
.sf.on .si{color:var(--acid)}
.sf.on .sl{color:var(--muted)}
.sf.on .sv{color:var(--text);font-weight:600}
.sf.hit{animation:pop .5s ease}
@keyframes pop{0%{transform:translateX(8px);border-color:var(--acid);box-shadow:0 0 0 3px rgba(102,217,232,.12)}
  100%{transform:none}}
.sfoot{border-top:1px solid var(--line);padding:14px 16px 18px}
#go{width:100%;height:44px;border-radius:10px;font-size:14.5px;font-weight:700;cursor:pointer;border:0;
  color:#04070d;background:linear-gradient(135deg,#66d9e8,#b58ae0);transition:160ms ease}
#go:hover:not(:disabled){filter:brightness(1.08)}
#go:disabled{cursor:not-allowed;color:var(--dim);background:rgba(255,255,255,.05);
  box-shadow:inset 0 0 0 1px var(--line)}
.sfoot p{margin-top:9px;font-size:11.5px;line-height:1.7;color:var(--dim)}

/* ── 姓名门禁 ── */
.gate{position:fixed;inset:var(--hd) 0 0 0;z-index:40;display:flex;align-items:center;justify-content:center;
  padding:24px;background:rgba(5,8,14,.80);backdrop-filter:blur(18px);transition:opacity .35s}
.gate.off{opacity:0;pointer-events:none}
.gcard{width:min(520px,100%);padding:34px 32px 28px;border-radius:16px;
  border:1px solid var(--line-strong);background:linear-gradient(180deg,rgba(13,20,32,.96),rgba(8,12,20,.96));
  box-shadow:0 30px 80px rgba(0,0,0,.55)}
.gk{font-family:var(--mono);font-size:10.5px;letter-spacing:.26em;color:var(--acid);margin-bottom:14px}
.gcard h2{font-size:24px;line-height:1.5;font-weight:750;letter-spacing:-.01em;margin-bottom:10px}
.gcard h2 em{font-style:normal;color:var(--acid)}
.gcard p{font-size:13.5px;line-height:1.85;color:var(--muted)}
.grow{display:flex;gap:9px;margin-top:20px}
#gateIn{flex:1;min-width:0;height:46px;padding:0 15px;border-radius:10px;
  border:1px solid var(--line);background:rgba(4,7,13,.7);color:var(--text);
  font-family:var(--sans);font-size:15px;outline:none}
#gateIn:focus{border-color:var(--line-strong)}
#gateBtn{height:46px;padding:0 22px;border-radius:10px;border:0;cursor:pointer;
  font-size:14px;font-weight:700;color:#04070d;background:linear-gradient(135deg,#66d9e8,#b58ae0)}
.gerr{min-height:20px;margin-top:8px;font-size:12.5px;color:#e2656b}
.gtip{margin-top:6px;font-family:var(--mono);font-size:11px;letter-spacing:.06em;color:var(--dim)}

/* ── 窄屏：舞台压成一条横幅，对话与需求单并排；再窄就整条竖排 ── */
@media(max-width:1180px){
  body{overflow:auto}
  .iv{flex-wrap:wrap;height:auto}
  .stage{flex:1 1 100%;height:min(46vh,380px)}
  .orbwrap{width:min(34vh,260px);top:48%}
  .bars{height:76px}
  .sub{padding:56px 24px 22px;font-size:16px;min-height:80px}
  .side{flex:1 1 380px;min-height:58vh;border-top:1px solid var(--line)}
  .spec{flex:1 1 300px;border-top:1px solid var(--line)}
  .gen{bottom:16px}
}
@media(max-width:900px){:root{--hd:64px}}
@media(max-width:760px){
  .side,.spec{flex:1 1 100%}
  .stage{height:min(40vh,300px)}
  .who{left:16px;top:16px}.think{left:16px;top:66px}
  .side{min-height:52vh}
  .spec{border-left:0}
  #log{max-height:46vh}
  .gcard{padding:26px 20px 22px}
  .gcard h2{font-size:20px}
  .grow{flex-direction:column}
  #gateBtn{width:100%}
}`,

    body: `<main class="iv" id="iv">

  <!-- ① 舞台：数字人形象。纯 CSS/SVG，不内嵌任何大文件 -->
  <section class="stage mode-listen" id="stage">
    <div class="who"><b>${esc(AGENT.name)}</b>${esc(AGENT.en)}</div>
    <div class="think" id="think">THINKING</div>
    <div class="chiprow"><span class="stchip"><i></i><span id="stTxt">在听</span></span></div>

    <div class="orbwrap">
      <div class="halo"></div>
      <svg class="rings" viewBox="0 0 320 320" aria-hidden="true">
        <defs><linearGradient id="ivg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#66d9e8"/><stop offset="1" stop-color="#b58ae0"/>
        </linearGradient></defs>
        <circle class="r1" cx="160" cy="160" r="66"/>
        <circle class="r2" cx="160" cy="160" r="98"/>
        <circle class="r3" cx="160" cy="160" r="130"/>
        <circle class="rd" cx="160" cy="160" r="150"/>
      </svg>
      <div class="core"></div>
      <div class="bars" id="bars"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
    </div>

    <div class="sub" id="sub"></div>

    <div class="gen" id="gen">
      <h3>GENERATING · 正在生成</h3>
      <div class="gbar"><i id="genBar"></i></div>
      <div id="genList">${GEN_PHASES.map(genRow).join('')}</div>
      <div class="gnote" id="genNote">真实生成链路尚未接通，这里先把过程演出来。</div>
    </div>
  </section>

  <!-- ② 对话栏 -->
  <aside class="side">
    <div class="shd">对话 · INTERVIEW<span class="tag" id="tag">准备中</span></div>
    <div id="log"></div>
    <div id="chips"></div>
    <div class="inrow">
      <textarea id="tin" rows="1" placeholder="说说你想要什么样的网站…"
        title="Enter 发送，Shift+Enter 换行"></textarea>
      <button class="btn" id="send">发送</button>
      <button class="btn ghost" id="stop">停止</button>
    </div>
    <div class="statbar"><span id="status"></span><span id="lat"></span></div>
  </aside>

  <!-- ③ 需求单：每答一句补一格，看得见才有"聊出来的东西没白说"的感觉 -->
  <aside class="spec">
    <div class="shd2">需求单 · SPEC<span id="specCnt">0 / ${SPEC_FIELDS.length}</span></div>
    <div id="specList">${SPEC_FIELDS.map(specRow).join('')}</div>
    <div class="sfoot">
      <button id="go" disabled>就这样，开始做</button>
      <p id="goNote">还差几项没聊到，聊完这个按钮就亮。</p>
    </div>
  </aside>

  <!-- ④ 姓名门禁：不填名字不给聊 -->
  <div class="gate" id="gate">
    <div class="gcard">
      <div class="gk">${esc(BRAND.en)}</div>
      <h2>先留个名字，<em>${esc(AGENT.name)}</em>才知道在跟谁说话</h2>
      <p>这个名字会印在你的作品和分享海报上，1–${NAME_MAX} 个字，之后随时能改。</p>
      <div class="grow">
        <input id="gateIn" maxlength="${NAME_MAX}" placeholder="你的名字"
          autocomplete="name" spellcheck="false" enterkeyhint="go">
        <button id="gateBtn">开始访谈</button>
      </div>
      <div class="gerr" id="gateErr"></div>
      <div class="gtip">接下来 5 个问题，大约两分钟。</div>
    </div>
  </div>

</main>`,

    script: `"use strict";
(function(){
var FIELDS=${J(SPEC_FIELDS)},SCRIPT=${J(SCRIPT)},KEYWORDS=${J(KEYWORDS)},
    ACKS=${J(ACKS)},CLOSING=${J(CLOSING)},PHASES=${J(GEN_PHASES)},
    AGENT=${J(AGENT.name)},NAME_MAX=${J(NAME_MAX)},
    OPEN_SPOKEN=${J(op.spoken)},OPEN_SUB=${J(op.sub)},
    INIT_NAME=${J(user && user.name ? String(user.name) : '')},
    LS_KEY='osos.creator.name';

var $=function(i){return document.getElementById(i)};
var stage=$('stage'),subEl=$('sub'),stTxt=$('stTxt'),thinkEl=$('think'),logEl=$('log'),
    chipsEl=$('chips'),tin=$('tin'),sendBtn=$('send'),stopBtn=$('stop'),
    statusEl=$('status'),latEl=$('lat'),tagEl=$('tag'),
    gate=$('gate'),gateIn=$('gateIn'),gateBtn=$('gateBtn'),gateErr=$('gateErr'),
    specCnt=$('specCnt'),goBtn=$('go'),goNote=$('goNote'),
    genEl=$('gen'),genBar=$('genBar'),genNote=$('genNote'),
    bars=Array.prototype.slice.call(document.querySelectorAll('#bars i'));

var S={name:'',phase:'gate',step:0,busy:false,spec:{},history:[],remote:null,ctrl:null};

/* ══ 波形 / 口型引擎 ═══════════════════════════════════════════
   照搬参考实现的「快攻慢放」：speechSynthesis 不给音频流，拿不到真包络，
   就用节拍法伪造 —— 每 90~150ms 抽一个开合目标，当前值瞬间追上目标
   再按 0.62 系数衰减，遇标点闭一下嘴。三种状态各有各的驱动：
     listen 慢呼吸  think 快而浅的抖动  speak 上面那套节拍
   引擎一直在跑，不然静止时舞台像张死图。 */
var mode='listen',lv=0,target=0,nextAt=0,pauseUntil=0,raf=0;
var BARW=[.40,.66,.88,1,.88,.66,.40];  // 中间高两边低，看起来才像声波而不像柱状图

function paint(){
  stage.style.setProperty('--lv',lv.toFixed(3));
  for(var i=0;i<bars.length;i++){
    var jit=mode==='speak'?(0.80+Math.random()*0.40):1;
    var v=0.07+lv*BARW[i]*jit;
    bars[i].style.transform='scaleY('+(v>1?1:v).toFixed(3)+')';
  }
}
function tick(now){
  if(mode==='speak'){
    if(now>=nextAt){
      if(now<pauseUntil){target=0;nextAt=now+60;}
      else{target=0.15+Math.random()*0.75;nextAt=now+90+Math.random()*70;}
    }
    lv=Math.max(target,lv*0.62);       // 快攻慢放
    if(lv<0.02)lv=0;
  }else if(mode==='think'){
    target=0.06+Math.abs(Math.sin(now/380))*0.11;
    lv+=(target-lv)*0.14;
  }else{
    target=0.05+Math.abs(Math.sin(now/900))*0.09;
    lv+=(target-lv)*0.06;
  }
  paint();
  raf=requestAnimationFrame(tick);
}
function setMode(m){
  mode=m;
  stage.className='stage mode-'+m;
  stTxt.textContent=m==='speak'?'在说':(m==='think'?'在想':'在听');
  thinkEl.className=m==='think'?'think on':'think';
}
raf=requestAnimationFrame(tick);

/* ══ 语音 ═══════════════════════════════════════════════════
   系统 TTS 有就用，没有（无头浏览器、部分安卓）就纯靠计时驱动口型，
   两条路都要能把 cb 回调出来，不然对话会卡死在"在说"这一状态。 */
var voice=null,voiceTried=false;
function pickVoice(){
  if(voiceTried)return voice;
  try{
    var vs=window.speechSynthesis?speechSynthesis.getVoices():[];
    if(!vs||!vs.length)return null;             // 还没加载完，下次再试
    voiceTried=true;
    for(var i=0;i<vs.length;i++)if(/zh/i.test(vs[i].lang)){voice=vs[i];break;}
  }catch(e){voiceTried=true}
  return voice;
}
try{if(window.speechSynthesis)speechSynthesis.onvoiceschanged=function(){voiceTried=false;pickVoice()}}catch(e){}

var sayTk=0,sayTimer=0,sayCap=0;
function endSay(tk,cb){
  if(tk!==sayTk)return;
  sayTk++;clearTimeout(sayTimer);clearTimeout(sayCap);
  setMode(S.phase==='build'?'think':'listen');
  setTimeout(function(){if(mode!=='speak')subEl.className='sub'},4200);
  if(cb)cb();
}
function say(spoken,sub,cb){
  sayTk++;var tk=sayTk;
  clearTimeout(sayTimer);clearTimeout(sayCap);
  try{if(window.speechSynthesis)speechSynthesis.cancel()}catch(e){}
  subEl.textContent=sub||spoken;subEl.className='sub on';
  setMode('speak');
  var est=Math.min(9000,Math.max(1500,(spoken||'').length*118));
  sayTimer=setTimeout(function(){endSay(tk,cb)},est);
  sayCap=setTimeout(function(){endSay(tk,cb)},est+9000);   // TTS 卡住时的兜底闸
  var v=pickVoice();
  if(!v)return;
  try{
    var u=new SpeechSynthesisUtterance(spoken);
    u.voice=v;u.lang=v.lang;u.rate=1.03;u.pitch=1.0;
    u.onstart=function(){clearTimeout(sayTimer)};            // 有真语音就交给它收尾
    u.onboundary=function(e){
      var ch=spoken.charAt(e.charIndex);
      if(ch&&/[，。！？；、~…,.!?;]/.test(ch))pauseUntil=performance.now()+240;
    };
    u.onend=function(){endSay(tk,cb)};
    u.onerror=function(){endSay(tk,cb)};
    speechSynthesis.speak(u);
  }catch(e){}
}
function hush(){try{if(window.speechSynthesis)speechSynthesis.cancel()}catch(e){}endSay(sayTk,null)}

/* ══ 消息流 ═════════════════════════════════════════════════ */
function addMsg(cls,who,text){
  var d=document.createElement('div');d.className='msg '+cls;
  if(who){var w=document.createElement('span');w.className='w';w.textContent=who;d.appendChild(w)}
  d.appendChild(document.createTextNode(text));
  logEl.appendChild(d);logEl.scrollTop=logEl.scrollHeight;
}
function renderChips(list){
  chipsEl.innerHTML='';
  if(!list||!list.length)return;
  for(var i=0;i<list.length;i++){
    (function(t){
      var b=document.createElement('button');b.type='button';b.textContent=t;
      b.onclick=function(){renderChips(null);send(t)};
      chipsEl.appendChild(b);
    })(list[i]);
  }
}

/* ══ 需求单 ═════════════════════════════════════════════════ */
function fieldOf(k){for(var i=0;i<FIELDS.length;i++)if(FIELDS[i].key===k)return FIELDS[i];return null}
function addSpec(k,v,force){
  var f=fieldOf(k);if(!f)return;
  v=String(v==null?'':v).trim();if(!v)return;
  if(f.multi){
    var a=S.spec[k]||[];
    if(a.indexOf(v)<0&&a.length<6)a.push(v);
    S.spec[k]=a;
  }else if(force||!S.spec[k]){S.spec[k]=v}
}
/**
 * 从一句话里尽量多捞几个字段。
 * 关键词表命中就补对应字段；当前正在问的那一项如果没被关键词命中，
 * 就把原话收进去 —— 否则用户答了个表里没有的说法，需求单会永远缺一格。
 */
function extract(text,key){
  var t=String(text||''),hitKey=false;
  for(var k in KEYWORDS){
    var tbl=KEYWORDS[k];
    for(var i=0;i<tbl.length;i++){
      try{if(new RegExp(tbl[i][0]).test(t)){addSpec(k,tbl[i][1]);if(k===key)hitKey=true}}catch(e){}
    }
  }
  if(key&&!hitKey)addSpec(key,t.slice(0,24),true);
}
function mergeSpec(o){
  if(!o)return;
  for(var k in o){
    var v=o[k];
    if(Object.prototype.toString.call(v)==='[object Array]'){for(var i=0;i<v.length;i++)addSpec(k,v[i])}
    else addSpec(k,v,true);
  }
}
function renderSpec(){
  var filled=0;
  for(var i=0;i<FIELDS.length;i++){
    var f=FIELDS[i],v=S.spec[f.key],row=$('sf-'+f.key),val=$('sv-'+f.key);
    var txt=f.multi?((v&&v.length)?v.join(' · '):''):(v||'');
    if(txt){
      filled++;
      if(val.textContent!==txt){
        val.textContent=txt;row.className='sf on';
        void row.offsetWidth;row.className='sf on hit';   // 强制重排，动画才会重放
      }else row.className='sf on';
    }else{val.textContent=f.hint;row.className='sf'}
  }
  specCnt.textContent=filled+' / '+FIELDS.length;
  var ready=filled===FIELDS.length&&S.phase==='talk';
  goBtn.disabled=!ready;
  goNote.textContent=filled===FIELDS.length
    ?'确认后进入生成。生成过程中还能回来改。'
    :('还差 '+(FIELDS.length-filled)+' 项没聊到，聊完这个按钮就亮。');
}

/* ══ 秒表 ═══════════════════════════════════════════════════ */
var t0=0,latT=0;
function latOn(){t0=performance.now();latEl.textContent='0.0s';
  latT=setInterval(function(){latEl.textContent=((performance.now()-t0)/1000).toFixed(1)+'s'},100)}
function latOff(){clearInterval(latT);if(t0)latEl.textContent=((performance.now()-t0)/1000).toFixed(1)+'s'}

/* ══ 后端 / 本地兜底 ════════════════════════════════════════
   /api/interview 还没上线。失败一次就把 S.remote 钉死成 false，
   后面全部走本地脚本 —— 每轮都等一次超时的话现场没人受得了。 */
function setTag(cls,txt){tagEl.className='tag '+cls;tagEl.textContent=txt}
function remoteTurn(){
  return new Promise(function(res,rej){
    var ctrl=new AbortController();S.ctrl=ctrl;
    var to=setTimeout(function(){try{ctrl.abort()}catch(e){}},12000);
    fetch('/api/interview',{method:'POST',signal:ctrl.signal,
      headers:{'content-type':'application/json'},
      body:JSON.stringify({name:S.name,spec:S.spec,history:S.history.slice(-16)})})
    .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})
    .then(function(d){
      clearTimeout(to);S.ctrl=null;
      if(!d||!d.spokenText)throw new Error('payload');
      S.remote=true;setTag('ok','在线');
      res({spoken:d.spokenText,sub:d.subtitleText||d.spokenText,spec:d.spec,done:!!d.done});
    })
    .catch(function(e){clearTimeout(to);S.ctrl=null;S.remote=false;setTag('local','本地脚本');rej(e)});
  });
}
function localTurn(){
  S.step++;
  if(S.step<SCRIPT.length){
    var q=SCRIPT[S.step],ack=ACKS[Math.floor(Math.random()*ACKS.length)];
    return {spoken:ack+q.ask,sub:ack+' '+q.sub,chips:q.chips};
  }
  return {spoken:CLOSING.spoken,sub:CLOSING.sub,done:true};
}

function send(text){
  if(S.phase!=='talk'||S.busy)return;
  text=String(text!=null?text:tin.value).trim();
  if(!text)return;
  tin.value='';tin.style.height='42px';renderChips(null);
  addMsg('me',S.name,text);
  var key=S.step<SCRIPT.length?SCRIPT[S.step].key:null;
  extract(text,key);renderSpec();
  S.history.push({role:'user',content:text});

  S.busy=true;sendBtn.disabled=true;
  setMode('think');statusEl.textContent='在想…';latOn();

  var after=function(reply){
    latOff();statusEl.textContent='';
    if(reply.spec)mergeSpec(reply.spec);
    renderSpec();
    S.history.push({role:'assistant',content:reply.sub||reply.spoken});
    addMsg('her',AGENT,reply.sub||reply.spoken);
    say(reply.spoken,reply.sub,function(){
      S.busy=false;sendBtn.disabled=false;
      if(reply.chips)renderChips(reply.chips);
      renderSpec();
      if(reply.done)addMsg('sys','','需求单已就绪 — 右边确认一下');
      if(!tin.disabled)tin.focus();
    });
  };

  if(S.remote===false){setTimeout(function(){after(localTurn())},420);return}
  remoteTurn().then(after,function(){after(localTurn())});
}

/* ══ 生成演出态 ═════════════════════════════════════════════ */
function runPhase(i){
  var rows=document.getElementById('genList').children;
  for(var k=0;k<rows.length;k++)rows[k].className='gp'+(k<i?' done':(k===i?' run':''));
  genBar.style.width=Math.round((i/PHASES.length)*100+6)+'%';
  statusEl.textContent=PHASES[i].label+'…';
  if(i<PHASES.length-1)setTimeout(function(){runPhase(i+1)},1500+Math.random()*900);
  else{
    genBar.style.width='92%';
    genNote.textContent='真实生成链路尚未接通 —— 到这一步就停住了。接上后这里会直接给出你的网址。';
  }
}
function startBuild(){
  if(S.phase!=='talk')return;
  S.phase='build';
  goBtn.disabled=true;goBtn.textContent='已确认，生成中';
  tin.disabled=true;sendBtn.disabled=true;renderChips(null);
  addMsg('sys','','需求单已确认，开始生成');
  genEl.className='gen on';
  say('好，我这就照着需求单开始做。','好，这就照着需求单开始做。');
  runPhase(0);
}

/* ══ 姓名门禁 ═══════════════════════════════════════════════ */
function enter(name,quiet){
  S.name=name;S.phase='talk';
  try{localStorage.setItem(LS_KEY,name)}catch(e){}
  window.__creatorName=name;                 // 预留给后续接后端用
  gate.className='gate off';
  setTag('','等待接入');
  tin.placeholder=name+'，说说你想要什么样的网站…';
  renderSpec();
  if(quiet)return;
  addMsg('sys','','访谈开始 · '+name);
  var o1=OPEN_SPOKEN.split('%N%').join(name),o2=OPEN_SUB.split('%N%').join(name);
  addMsg('her',AGENT,o2);
  say(o1,o2,function(){
    var q=SCRIPT[0];
    addMsg('her',AGENT,q.sub);
    say(q.ask,q.sub,function(){renderChips(q.chips);tin.focus()});
  });
}
function tryEnter(){
  var v=(gateIn.value||'').trim().replace(/\\s+/g,' ');
  if(!v){gateErr.textContent='还没填名字呢';gateIn.focus();return}
  if(v.length>NAME_MAX){gateErr.textContent='名字太长了，最多 '+NAME_MAX+' 个字';return}
  if(/[<>]/.test(v)){gateErr.textContent='名字里不能有尖括号';return}
  gateErr.textContent='';
  enter(v,false);
}
gateBtn.onclick=tryEnter;
gateIn.onkeydown=function(e){if(e.key==='Enter'){e.preventDefault();tryEnter()}};
gateIn.oninput=function(){if(gateErr.textContent)gateErr.textContent=''};

/* ══ 输入区 ═════════════════════════════════════════════════ */
tin.addEventListener('keydown',function(e){
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}
});
tin.addEventListener('input',function(){
  tin.style.height='42px';
  tin.style.height=Math.min(120,tin.scrollHeight)+'px';
});
sendBtn.onclick=function(){send()};
stopBtn.onclick=function(){
  hush();
  if(S.ctrl){try{S.ctrl.abort()}catch(e){}S.ctrl=null}
  latOff();statusEl.textContent='';
  if(S.busy){S.busy=false;sendBtn.disabled=false;addMsg('sys','','已打断')}
};
goBtn.onclick=startBuild;

/* ══ 调试入口 ═══════════════════════════════════════════════
   /#demo=gate|talk|ready|build 直接跳到某个状态，用来截图核对布局。
   不走 TTS、不等动画，纯把 DOM 摆成那个样子。 */
function demo(){
  var m=/(?:^|[#&])demo=([a-z]+)/i.exec(location.hash||'');
  if(!m)return false;
  var d=m[1].toLowerCase();
  if(d==='gate'){gateIn.value='林小满';return true}
  enter('林小满',true);
  setTag('local','本地脚本');
  addMsg('sys','','访谈开始 · 林小满');
  addMsg('her',AGENT,OPEN_SUB.split('%N%').join('林小满'));
  var n=(d==='talk')?2:SCRIPT.length;
  for(var i=0;i<n;i++){
    addMsg('her',AGENT,(i?ACKS[i%ACKS.length]+' ':'')+SCRIPT[i].sub);
    var a=['给家人看的相册，放我妈这些年拍的花','就叫「阳台上的四季」','照片墙，再加一条时间线','安静一点，别太花哨','手机里有大概三百张照片，还有几段文字'][i];
    addMsg('me','林小满',a);
    extract(a,SCRIPT[i].key);
  }
  S.step=n;
  if(d==='talk'){
    addMsg('her',AGENT,ACKS[2]+' '+SCRIPT[2].sub);
    renderChips(SCRIPT[2].chips);
    subEl.textContent=SCRIPT[2].sub;subEl.className='sub on';
    setMode('speak');lv=0.72;paint();
    statusEl.textContent='';latEl.textContent='1.4s';
  }else{
    addMsg('her',AGENT,CLOSING.sub);
    addMsg('sys','','需求单已就绪 — 右边确认一下');
    subEl.textContent=CLOSING.sub;subEl.className='sub on';
    setMode('listen');
    latEl.textContent='1.8s';
  }
  renderSpec();
  if(d==='build'){startBuild();setMode('think');}
  return true;
}

/* ══ 启动 ═══════════════════════════════════════════════════ */
renderSpec();
if(!demo()){
  var saved='';
  try{saved=localStorage.getItem(LS_KEY)||''}catch(e){}
  gateIn.value=INIT_NAME||saved||'';
  // 已登录的话名字是确定的，没必要再问一遍
  if(INIT_NAME)enter(INIT_NAME,false);else gateIn.focus();
}
})();`,
  });
}
