"use strict";
/* 一句话生成 · 桌面端前端
 *
 * 口型引擎与 T2A 流水线整段沿用《真昼·口袋版》——那套东西已经在真机上跑熟了
 * （分句 + 边放边合成 + 串行闸 + RPM 退避 + 双模型降级 + 波形驱动口型）。
 * T2A 请求改由 Rust 代理：JavaScript 只拿音频字节，密钥不再进入 webview。
 */

/* 前端起不来时必须看得见。桌面端没有 devtools，一旦这个文件在顶层抛异常，
   页面就是一张不会动的静态图，现场根本无从下手查。所以：
   1) 立刻在标题里留痕（标题能从进程外读到，是唯一的外部可观测点）；
   2) 顶层异常直接糊在页面上，而不是静静地死掉。 */
window.addEventListener('error', e => {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:auto 0 0 0;z-index:999;background:#2a0d10;'
    + 'color:#ffd7d9;font:12px ui-monospace,Consolas,monospace;padding:10px 14px;'
    + 'white-space:pre-wrap;border-top:1px solid #e2656b';
  box.textContent = '前端异常：' + (e.message || e.error) + '\n' + (e.filename || '') + ':' + (e.lineno || '');
  document.body.appendChild(box);
});

const TAURI = window.__TAURI__;
if (!TAURI) {
  throw new Error('window.__TAURI__ 不存在：tauri.conf.json 里 app.withGlobalTauri 没开？');
}
const { invoke } = TAURI.core;
const { listen } = TAURI.event;

/* ============ DOM ============ */
const $ = id => document.getElementById(id);
const subtitle = $('subtitle'), statusEl = $('status'), latEl = $('lat'), logEl = $('log');
const textin = $('textin'), thinkingEl = $('thinking');
const chipModel = $('chip-model'), chipVoice = $('chip-voice'), chipCreator = $('chip-creator');
const chipCloud = $('chip-cloud');
const mouthClosed = $('mouthClosed'), mouthHalf = $('mouthHalf'), mouthOpen = $('mouthOpen');
const reqcard = $('reqcard'), goBtn = $('go');
const pvframe = $('pvframe'), pvurl = $('pvurl'), pvwait = $('pvwait');

let BOOT = null, TTS = null;
let CLOUD = null, cloudChecked = false, cloudRefreshPromise = null;
let publication = null, posterSpec = null, posterBusy = false, posterUploaded = false, posterSeq = 0;
let requirement = null, ready = false;
let siteId = null, previewUrl = null;
let generating = false, finished = false;
/* 一句话直达正在补需求单。和 generating 分开：这段还没开工，
   但按钮必须先锁住，否则连点会开出两个作品目录。 */
let preparing = false, launchSeq = 0;
/* 当前这份需求单是从哪句话补出来的。生成失败后直达框还留在屏幕上，
   用户很可能改一句再点一次——不记这个的话 workable() 仍然为真，
   会拿着上一句话的旧需求单开工，新写的那句被静静吃掉。 */
let reqSeed = '';
let tokensUsed = 0;

function addMsg(cls, who, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  if (who) { const w = document.createElement('span'); w.className = 'who'; w.textContent = who; d.appendChild(w); }
  d.appendChild(document.createTextNode(text));
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

/* ============ 嘴部补丁定位（cover 裁切重映射） ============ */
const MOUTH_RECT = [190, 245, 105, 55];
const VIDEO_SIZE = [576, 720];
const OBJ_POS_Y = 0.22;
function layoutMouth() {
  const stage = document.querySelector('.stage').getBoundingClientRect();
  const [vw, vh] = VIDEO_SIZE;
  const scale = Math.max(stage.width / vw, stage.height / vh);
  const dw = vw * scale, dh = vh * scale;
  const ox = (stage.width - dw) / 2;
  const oy = (stage.height - dh) * OBJ_POS_Y;
  const [mx, my, mw] = MOUTH_RECT;
  for (const el of [mouthClosed, mouthHalf, mouthOpen]) {
    el.style.left = ((ox + mx * scale) / stage.width * 100) + '%';
    el.style.top = ((oy + my * scale) / stage.height * 100) + '%';
    el.style.width = (mw * scale / stage.width * 100) + '%';
  }
}
window.addEventListener('resize', layoutMouth);
// 舞台在进入生成模式时会收窄，过渡结束要重新标定
document.querySelector('.stage').addEventListener('transitionend', layoutMouth);

/* ============ 口啪引擎（真昼原版） ============ */
let flapRaf = 0, speaking = false, pauseUntil = 0;
let target = 0, current = 0, nextTargetAt = 0, envelope = null;

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function setMouth(level) {
  const open = smoothstep(0.45, 0.75, level);
  const half = smoothstep(0.12, 0.30, level) * (1 - open);
  mouthHalf.style.opacity = half.toFixed(3);
  mouthOpen.style.opacity = open.toFixed(3);
}
function flapTick(now) {
  if (!speaking) return;
  if (envelope) target = envelope();
  else if (now >= nextTargetAt) {
    if (now < pauseUntil) { target = 0; nextTargetAt = now + 60; }
    else { target = 0.15 + Math.random() * 0.75; nextTargetAt = now + 90 + Math.random() * 70; }
  }
  if (envelope) current += (target - current) * (target > current ? 0.45 : 0.20);
  else current = Math.max(target, current * 0.62);
  if (current < 0.02) current = 0;
  setMouth(current);
  flapRaf = requestAnimationFrame(flapTick);
}
function flapStart(env) {
  envelope = env || null;
  speaking = true; target = 0; current = 0; nextTargetAt = 0;
  cancelAnimationFrame(flapRaf);
  flapRaf = requestAnimationFrame(flapTick);
}
function flapStop() { speaking = false; envelope = null; cancelAnimationFrame(flapRaf); setMouth(0); }
function makeEnvelope(an) {
  const buf = new Uint8Array(an.fftSize);
  let pk = 0.08, sm = 0;
  return () => {
    an.getByteTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; }
    const rms = Math.sqrt(s / buf.length);
    sm = sm * 0.55 + rms * 0.45;
    pk = Math.max(sm, pk * 0.995);
    return sm < 0.008 ? 0 : Math.min(1, sm / Math.max(pk, 0.03) * 0.95);
  };
}

/* ============ MiniMax 语音 T2A v2（真昼原版） ============ */
const TTS_MODELS = ["speech-2.6-hd", "speech-02-hd"];
const TTS_RPM_GAP = 240;
const VOICES = [
  ["Chinese (Mandarin)_Gentle_Senior", "温柔学姐"],
  ["danya_xuejie", "淡雅学姐"],
  ["Chinese (Mandarin)_Warm_Bestie", "温暖闺蜜"],
  ["Chinese (Mandarin)_Wise_Women", "阅历姐姐"],
  ["Chinese (Mandarin)_Soft_Girl", "软软女孩"],
  ["female-yujie-jingpin", "御姐"],
  ["Chinese (Mandarin)_Sweet_Lady", "甜美女声"],
];
const EMO = {
  neutral:   { e: "neutral",   speed: 0.93, pitch: 0 },
  warm:      { e: "happy",     speed: 0.90, pitch: 0 },
  amused:    { e: "happy",     speed: 1.00, pitch: 1 },
  concerned: { e: "sad",       speed: 0.88, pitch: -1 },
  curious:   { e: "surprised", speed: 0.97, pitch: 1 },
};
const CHUNK_MAX = 70;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let voiceId = VOICES[0][0];

let audioCtx = null, masterGain = null, analyser = null;
function initAudio() {
  if (audioCtx) { if (audioCtx.state === 'suspended') audioCtx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AC();
  masterGain = audioCtx.createGain();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0;
  masterGain.connect(analyser); analyser.connect(audioCtx.destination);
}

function splitForTts(text) {
  const hard = /[。！？!?…]/, soft = /[，,、；;：:]/;
  const out = []; let cur = '';
  for (const ch of text) {
    cur += ch;
    if (hard.test(ch) && cur.trim().length >= 8) { out.push(cur); cur = ''; }
    else if (cur.length >= CHUNK_MAX && soft.test(ch)) { out.push(cur); cur = ''; }
  }
  if (cur.trim()) out.push(cur);
  const merged = [];
  for (const p of out) {
    const last = merged[merged.length - 1];
    if (last && last.length < 24 && last.length + p.length <= CHUNK_MAX) merged[merged.length - 1] = last + p;
    else merged.push(p);
  }
  return merged.length ? merged : [text];
}

let gate = Promise.resolve(), lastAt = 0;
function serialize(fn) {
  const run = gate.then(async () => {
    const wait = TTS_RPM_GAP - (performance.now() - lastAt);
    if (wait > 0) await sleep(wait);
    lastAt = performance.now();
    return fn();
  });
  gate = run.then(() => {}, () => {});
  return run;
}
const hexToBytes = hex => {
  const n = hex.length >> 1, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
};

const inflightTts = new Set();
async function ttsFetch(text, emotionKey, model) {
  /* Tauri IPC 没有 AbortController 的传输取消协议。这里的 token 负责“用户按停后
     即使后台那次合成稍后回来，也绝不播放”；Rust 请求会自行在 90 秒内结束。 */
  const ctrl = { aborted: false, abort() { this.aborted = true; } };
  inflightTts.add(ctrl);
  try {
    let hex;
    try {
      hex = await invoke('tts_synth', { text, voiceId, emotion: emotionKey, model });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      // 保留真昼原流水线的 1002 退避语义
      const code = String(e).match(/T2A\s+(\d+)/);
      if (code) err.code = Number(code[1]);
      throw err;
    }
    if (ctrl.aborted) {
      const e = new Error('T2A 已取消'); e.name = 'AbortError'; throw e;
    }
    if (!hex) throw new Error('T2A 未返回音频');
    return hexToBytes(hex);
  } finally { inflightTts.delete(ctrl); }
}

const ttsCache = new Map();
function synth(text, emotionKey) {
  const emo = EMO[emotionKey] || EMO.neutral;
  const key = `${voiceId}|${emo.e}|${emo.speed}|${text}`;
  if (ttsCache.has(key)) return ttsCache.get(key);
  const p = (async () => {
    let lastErr = null;
    for (const model of TTS_MODELS) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const bytes = await serialize(() => ttsFetch(text, emotionKey, model));
          return await audioCtx.decodeAudioData(bytes.buffer);
        } catch (e) {
          lastErr = e;
          if (e.name === 'AbortError') throw e;
          if (e.code === 1002) { await sleep(4200); continue; }
          break;
        }
      }
    }
    throw lastErr || new Error('T2A 失败');
  })();
  ttsCache.set(key, p);
  p.catch(() => ttsCache.delete(key));
  if (ttsCache.size > 40) ttsCache.delete(ttsCache.keys().next().value);
  return p;
}

let curSource = null, playSeq = 0;
function playBuffer(buf) {
  return new Promise(res => {
    const src = audioCtx.createBufferSource();
    src.buffer = buf; src.connect(masterGain);
    src.onended = () => { if (curSource === src) curSource = null; res(); };
    curSource = src; src.start();
  });
}
function stopAudio() {
  playSeq++;
  for (const c of inflightTts) { try { c.abort(); } catch {} }
  inflightTts.clear();
  if (curSource) { try { curSource.onended = null; curSource.stop(); } catch {} curSource = null; }
  try { speechSynthesis.cancel(); } catch {}
  flapStop();
}
function ttsOk() { chipVoice.textContent = '语音 MiniMax'; chipVoice.className = 'chip ok'; }
function ttsBad(msg) {
  chipVoice.textContent = '语音兜底'; chipVoice.className = 'chip bad';
  addMsg('sys', '', 'MiniMax 语音失败，改用系统语音：' + String(msg).slice(0, 60));
}

async function speak(text, subtitleText, emotion) {
  stopAudio();
  const seq = ++playSeq;
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  subtitle.textContent = subtitleText || clean;
  subtitle.className = 'subtitle ' + (emotion || '');
  if (!clean) return;
  if (!TTS) { setTimeout(() => { if (seq === playSeq) subtitle.textContent = ''; }, 7000); return; }
  const fade = () => setTimeout(() => { if (seq === playSeq) subtitle.textContent = ''; }, 6000);
  try {
    initAudio();
    const chunks = splitForTts(clean);
    let next = synth(chunks[0], emotion);
    for (let i = 0; i < chunks.length; i++) {
      const buf = await next;
      if (seq !== playSeq) return;
      if (i === 0) ttsOk();
      if (i + 1 < chunks.length) next = synth(chunks[i + 1], emotion);
      if (!speaking) flapStart(makeEnvelope(analyser));
      await playBuffer(buf);
      if (seq !== playSeq) return;
    }
    flapStop(); fade();
  } catch (e) {
    if (e.name === 'AbortError' || seq !== playSeq) return;
    flapStop(); ttsBad(e.message); sysSpeak(clean, seq, fade);
  }
}

/* ============ 系统语音（仅兜底） ============ */
let sysVoice = null;
function pickSysVoice() {
  if (typeof speechSynthesis === 'undefined') return;
  const vs = speechSynthesis.getVoices();
  sysVoice = vs.find(v => /zh/i.test(v.lang) && /Xiaoxiao|Xiaoyi/i.test(v.name))
          || vs.find(v => /zh/i.test(v.lang) && /Huihui|Yaoyao|Tingting|Meijia/i.test(v.name))
          || vs.find(v => /zh/i.test(v.lang)) || null;
}
if (typeof speechSynthesis !== 'undefined') { speechSynthesis.onvoiceschanged = pickSysVoice; pickSysVoice(); }
function sysSpeak(text, seq, fade) {
  if (!sysVoice) { setTimeout(() => { if (seq === playSeq) subtitle.textContent = ''; }, 8000); return; }
  const u = new SpeechSynthesisUtterance(text);
  u.voice = sysVoice; u.lang = sysVoice.lang; u.rate = 1.0; u.pitch = 1.05;
  u.onstart = () => flapStart(null);
  u.onboundary = e => { const ch = text[e.charIndex]; if (ch && /[，。！？；~…,.!?;]/.test(ch)) pauseUntil = performance.now() + 260; };
  u.onend = () => { flapStop(); fade(); };
  u.onerror = flapStop;
  speechSynthesis.speak(u);
}

/* ============ 需求单实时预览 ============
   规划书第 03 节：「用户说一句，右边的需求单就补一条，可视化很强」。
   所以这里逐字段 diff，只给**变化的那一行**加高亮动画。 */
const REQ_FIELDS = [
  ['title', '标题'], ['site_type', '类型'], ['audience', '给谁看'],
  ['sections', '栏目'], ['style', '风格'], ['tagline', '亮点'], ['content', '内容'],
];
let lastReqSnapshot = {};

function fieldText(req, key) {
  const v = req ? req[key] : '';
  if (Array.isArray(v)) return v.join('、');
  return (v || '').toString().trim();
}

function renderRequirement(req) {
  requirement = req;
  const any = REQ_FIELDS.some(([k]) => fieldText(req, k));
  if (!any) return;

  reqcard.classList.remove('empty');
  reqcard.innerHTML = '';
  for (const [key, label] of REQ_FIELDS) {
    const val = fieldText(req, key);
    const row = document.createElement('div');
    row.className = 'reqrow';
    if (val && val !== lastReqSnapshot[key]) row.classList.add('fresh');
    const k = document.createElement('span'); k.className = 'k'; k.textContent = label;
    const v = document.createElement('span');
    v.className = 'v' + (val ? '' : ' blank');
    v.textContent = val || '—';
    row.append(k, v);
    reqcard.appendChild(row);
    lastReqSnapshot[key] = val;
  }
}

/* 需求单够不够直接开工。和 Rust 侧 Requirement::is_workable() 是同一条判据。 */
function workable() {
  return !!(requirement && fieldText(requirement, 'title') && fieldText(requirement, 'content'));
}

/* 现在手上一切能当需求用的文字。
   优先用首屏那句话；没有就把用户在对话里说过的全部内容凑起来。
   「凑起来」比「打回去重聊」好：哪怕只说了半句，也够生成引擎起个头。 */
function seedText() {
  const one = $('oneline') ? $('oneline').value.trim() : '';
  if (one) return one;
  const said = history.filter(m => m.role === 'user').map(m => m.content).join('\n').trim();
  const typing = textin.value.trim();
  return [said, typing].filter(Boolean).join('\n').trim();
}

/* 开工按钮的状态。
   原来的判据是 `ready && workable()`——ready 由模型说了算，于是按钮绝大多数时间是灰的，
   而灰按钮不会告诉你还差什么，用户只能继续聊、继续猜。
   现在只要有话可用就亮：缺的部分在按下去之后由一句话直达补齐。 */
function updateGo() {
  // 整个界面只有这一颗生成按钮，它的文字就是当前状态的全部说明
  if (preparing) {
    goBtn.disabled = true;
    goBtn.classList.add('working');
    goBtn.textContent = '正在把这句话展开…';
    return;
  }
  if (inflight) {
    goBtn.disabled = true;
    goBtn.classList.add('working');
    goBtn.textContent = '正在等真昼回复…';
    return;
  }
  goBtn.classList.remove('working');
  const cloudReady = !!(CLOUD && CLOUD.publish && CLOUD.image);
  const hasSeed = workable() || !!seedText();
  if (!cloudReady) {
    const retryable = cloudChecked && (!BOOT || BOOT.cloudConfigured !== false) && !generating && hasSeed;
    goBtn.disabled = !retryable;
    goBtn.textContent = !cloudChecked ? '正在检查云端生图…'
      : retryable ? '重试云端后开始做' : '云端生图未就绪';
    return;
  }
  const ok = !generating && hasSeed;
  goBtn.disabled = !ok;
  goBtn.textContent = !ok ? '先说一句你想做什么'
    : workable() ? '就这样，开始做'
    : '就用现在说的，直接开始做';
}

/* ============ 访谈 ============ */
const history = [];
let inflight = false, interviewSeq = 0, thinkStart = 0, latTimer = null;

async function sendText() {
  const t = textin.value.trim();
  if (!t || inflight || generating || preparing) return;
  textin.value = '';
  launchSeq++;
  addMsg('me', '你', t);
  history.push({ role: 'user', content: t });

  const turn = ++interviewSeq;
  inflight = true;
  updateGo();
  thinkingEl.classList.add('on');
  statusEl.textContent = '思考中…';
  thinkStart = performance.now();
  latTimer = setInterval(() => {
    latEl.textContent = `等待回应 ${((performance.now() - thinkStart) / 1000).toFixed(0)}s`;
  }, 500);

  try {
    const reply = await invoke('interview_turn', { history });
    // 生成/补需求单一旦开始，旧访谈回复就不能再覆盖 canonical requirement。
    if (turn !== interviewSeq || generating || preparing) return;
    history.push({ role: 'assistant', content: JSON.stringify({
      spokenText: reply.spokenText, subtitleText: reply.subtitleText,
      emotion: reply.emotion, requirement: reply.requirement, ready: reply.ready }) });

    tokensUsed += (reply.inputTokens || 0) + (reply.outputTokens || 0);
    latEl.textContent = `${((performance.now() - thinkStart) / 1000).toFixed(1)}s`;
    statusEl.textContent = '';
    chipModel.textContent = `模型 ${BOOT.model}`; chipModel.className = 'chip ok';

    addMsg('her', '真昼', reply.subtitleText || reply.spokenText);
    renderRequirement(reply.requirement);
    ready = !!reply.ready;
    updateGo();
    if (ready) $('side-sub').textContent = '可以开工了';
    speak(reply.spokenText, reply.subtitleText, reply.emotion);
  } catch (e) {
    if (turn === interviewSeq) {
      statusEl.textContent = '';
      latEl.textContent = '';
      chipModel.textContent = '模型 异常'; chipModel.className = 'chip bad';
      addMsg('sys', '', String(e).slice(0, 160));
    }
  } finally {
    if (turn === interviewSeq) {
      inflight = false;
      thinkingEl.classList.remove('on');
      clearInterval(latTimer);
      updateGo();
    }
  }
}

/* ============ 生成演出 ============
   规划书第 01 节：十分钟里屏幕上必须一直有东西在动、在长出来。
   真昼在旁边当引导员讲解「现在在做什么」——旁白是本地固定台词，
   不再调模型：省 token，也不会因为网络抖动让讲解迟到。 */
const STAGES = [
  ['skeleton', '骨架先出来'],
  ['visuals',  '生图模型画作品画面'],
  ['hero',     '首屏正在长出来'],
  ['content',  '内容区一屏一屏地填'],
  ['footer',   '补页脚与出口'],
  ['polish',   '配图与细节'],
  ['done',     '做好了'],
];
const NARRATION = {
  skeleton: ['先把页面的骨架搭出来，你会看到一个灰色的轮廓，那是它的结构。', 'neutral'],
  visuals:  ['现在调用生图模型画作品画面。这里不会拿灰卡或 SVG 假装成配图。', 'warm'],
  hero:     ['现在在写首屏，就是别人打开你的网站第一眼看到的地方。', 'warm'],
  content:  ['接下来一屏一屏地把内容填进去，你可以看着它慢慢长大。', 'warm'],
  footer:   ['补上页脚，还有回到大厅的入口。', 'neutral'],
  polish:   ['最后调一下配图和细节，让它在手机上也好看。', 'amused'],
  done:     ['做好了。你看看喜不喜欢，不满意我们可以再来一版。', 'warm'],
};

let genStart = 0, tickTimer = null;

/* 刷新预览窗。
   绝对不能用 pvframe.contentWindow.location.reload()——
   主页面在 http://tauri.localhost，预览在 http://127.0.0.1:<port>，是**跨源**的，
   碰 contentWindow.location 会抛 SecurityError。更坏的是它抛在事件处理函数中间，
   会把后面的旁白、日志一起带走（实测：预览停在 404、真昼全程不说话、完成日志也没有）。
   重设 src 是跨源允许的操作。带一个递增参数确保不吃缓存。 */
let pvSeq = 0;
function reloadPreview() {
  if (!previewUrl) return;
  try {
    pvframe.src = previewUrl + (previewUrl.includes('?') ? '&' : '?') + '_=' + (++pvSeq);
    pvwait.classList.add('gone');
  } catch (e) {
    addMsg('sys', '', '预览刷新失败：' + String(e).slice(0, 80));
  }
}

function buildStageList() {
  const el = $('stagelist');
  el.innerHTML = '';
  for (const [id, label] of STAGES) {
    const d = document.createElement('div');
    d.className = 'st'; d.dataset.stage = id;
    d.innerHTML = `<span class="dot"></span><span class="l"></span><span class="t"></span>`;
    d.querySelector('.l').textContent = label;
    el.appendChild(d);
  }
}

function markStage(id, state, elapsedMs) {
  const idx = STAGES.findIndex(s => s[0] === id);
  document.querySelectorAll('.st').forEach((el, i) => {
    if (i < idx) { el.className = 'st done'; }
    else if (i === idx) {
      el.className = 'st ' + state;
      if (elapsedMs != null) el.querySelector('.t').textContent = fmt(elapsedMs);
    }
  });
}

const fmt = ms => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function startTick() {
  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    const el = performance.now() - genStart;
    $('m-time').textContent = fmt(el);
    // 过了软截止就把计时器染成警示色，现场一眼能看出要进降级了
    $('m-time').className = (el / 1000 >= BOOT.softDeadlineSecs) ? 'over' : '';
  }, 500);
}

function resetPublishedState() {
  posterSeq++;
  publication = null;
  posterSpec = null;
  posterBusy = false;
  posterUploaded = false;
  $('poster-modal').classList.remove('on');
  $('poster-modal').setAttribute('aria-hidden', 'true');
  $('btn-publish').disabled = false;
  $('btn-publish').textContent = '推上线，分配网址';
  $('btn-share').disabled = true;
  $('btn-share').textContent = '生成分享卡/海报';
  $('btn-poster-open').disabled = true;
  $('btn-poster-retry').style.display = 'none';
}

async function startGeneration(isRegen) {
  if (generating || inflight || !requirement) return;
  generating = true;
  goBtn.disabled = true;
  goBtn.classList.add('working');
  goBtn.textContent = '正在启动生成…';

  try {
    // 先让 Rust 接受这次任务，再破坏当前完成态。这样重做次数用尽、云端忙或
    // 能力预检瞬时失败时，上一版预览和上线/海报按钮仍然可用。
    const r = await invoke('start_generation', { requirement, regenerate: !!isRegen });

    finished = false;
    document.body.classList.add('performing');
    document.body.classList.remove('finished');
    $('stages').style.display = 'block';
    $('side-title').textContent = '生成中';
    $('side-sub').textContent = '';
    $('note').style.display = 'none';
    $('gobar').style.display = 'none';
    buildStageList();
    $('barfill').style.width = '0%';
    genStart = performance.now();
    startTick();
    layoutMouth();

    resetPublishedState();
    siteId = r.siteId; previewUrl = r.previewUrl;
    pvurl.textContent = previewUrl;
    // 这时候骨架还没写盘，现在指过去只会拿到 404 页。
    // 先摆等待态，等第一个阶段事件到了再真正加载。
    pvframe.src = 'about:blank';
    pvwait.classList.remove('gone');
    if (r.regenUsed > 0) $('m-regen').textContent = `重做 ${r.regenUsed}/${BOOT.maxRegen}`;
    addMsg('sys', '', `开工，产物目录 ${siteId}`);
  } catch (e) {
    generating = false;
    goBtn.classList.remove('working');
    updateGo();
    addMsg('sys', '', '开工失败：' + String(e).slice(0, 200));
    speak('抱歉，刚才没能开始。' + String(e).slice(0, 40), null, 'concerned');
  }
}

/* 事件处理函数里一旦抛异常，后面的代码会被静默跳过——
   这次就是 contentWindow.location 抛 SecurityError，把旁白和完成日志一起吃掉了，
   表面上只看得到"预览没刷新"，真正的原因完全不可见。
   包一层，出事至少能在对话栏里看见。 */
function on(evt, fn) {
  // listen() 返回的是 Promise。**必须 catch**——它 reject 时监听根本没注册上，
  // 而 unhandledrejection 不触发 window.onerror，于是表现成
  // 「invoke 全通、事件一个不来」，看起来像后端卡死，实际是前端压根没在听。
  const pr = listen(evt, e => {
    try { fn(e); }
    catch (err) { addMsg('sys', '', `[${evt}] 处理异常：` + String(err).slice(0, 160)); }
  });
  if (pr && typeof pr.catch === 'function') {
    pr.catch(err => {
      addMsg('sys', '', `[${evt}] 监听注册失败：` + String(err).slice(0, 160));
      selftest.push(`listen(${evt}) REJECTED: ${err}`);
      flushSelftest();
    });
  }
  return pr;
}

/* 事件通道自检。Rust 侧启动后会各发一次 selftest:colon / selftest-dash，
   这里记录谁真的到了，落盘到 ui-diag.txt——事件通道是否可用，
   不能靠"跑一次生成看有没有动静"来判断，那要等十分钟还未必定位得到。 */
const selftest = [];
let flushTimer = null;
function flushSelftest() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    invoke('ui_diag', { payload: '事件通道自检\n' + selftest.join('\n') }).catch(() => {});
  }, 400);
}
window.addEventListener('unhandledrejection', e => {
  selftest.push('unhandledrejection: ' + String(e.reason).slice(0, 200));
  flushSelftest();
});
let gotColon = false, gotDash = false;
listen('selftest:colon', () => { gotColon = true; selftest.push('收到 selftest:colon  → 冒号事件名可用'); flushSelftest(); })
  .catch(e => { selftest.push('listen(selftest:colon) REJECTED: ' + e); flushSelftest(); });
listen('selftest-dash', () => { gotDash = true; selftest.push('收到 selftest-dash  → 连字符事件名可用'); flushSelftest(); })
  .catch(e => { selftest.push('listen(selftest-dash) REJECTED: ' + e); flushSelftest(); });

/* 静默判定。上面两条只在「收到」或「注册失败」时落盘，可最坏的一种故障是
   **注册成功、事件永远不来**（capabilities 里没给 core:event:allow-listen 就是这样：
   自定义命令照常 invoke，listen 却是个哑巴）。那种情况下上面两条都不触发，
   ui-diag.txt 里干干净净，看着像一切正常，实际上生成永远不会收尾。
   所以必须有人在超时后主动宣布"没来"。Rust 侧 2 秒发，这里等 6 秒足够宽裕。 */
setTimeout(() => {
  if (gotColon && gotDash) return;
  const miss = [!gotColon && 'selftest:colon', !gotDash && 'selftest-dash'].filter(Boolean);
  selftest.push(`⚠ 事件通道不通：等 6 秒没等到 ${miss.join(' / ')}`);
  selftest.push('  → 十有八九是 capabilities 缺 core:event:allow-listen（Tauri 2 只拦插件命令，不拦自定义命令，所以 invoke 全通）');
  flushSelftest();
  // 现场也得看得见，不能只躺在文件里
  addMsg('sys', '', '事件通道自检失败：后端事件到不了前端，生成会停在"生成中"不收尾。');
}, 6000);

on('gen:progress', ev => {
  const p = ev.payload;
  $('barfill').style.width = p.pct + '%';
  $('m-token').textContent = p.tokens.toLocaleString();
  if (p.tokens >= BOOT.genTokenBudget * 0.8) $('m-token').className = 'over';

  const skipped = p.label.includes('跳过');
  markStage(p.stage, skipped ? 'skip' : (p.stage === 'done' ? 'done' : 'doing'), p.elapsedMs);

  if (p.note) {
    $('note').style.display = 'block';
    $('note').textContent = p.note;
  }
  // 预览必须在写盘之后刷新，Rust 侧是先写文件再 emit，顺序是对的
  if (p.reload) reloadPreview();
  const n = NARRATION[p.stage];
  if (n && !skipped) speak(n[0], n[0], n[1]);
});

on('gen:done', ev => {
  const o = ev.payload;
  generating = false; finished = true;
  clearInterval(tickTimer);
  $('m-time').textContent = fmt(o.elapsedMs);
  $('m-token').textContent = o.tokens.toLocaleString();
  markStage('done', 'done', o.elapsedMs);
  $('barfill').style.width = '100%';
  document.body.classList.add('finished');
  $('side-title').textContent = '做好了';
  $('side-sub').textContent = fmt(o.elapsedMs);
  if (o.degraded && o.degradeReason) {
    $('note').style.display = 'block';
    $('note').textContent = '降级：' + o.degradeReason;
  }
  reloadPreview();
  addMsg('sys', '', `完成，用时 ${fmt(o.elapsedMs)}，${o.tokens.toLocaleString()} token`);
});

on('gen:error', ev => {
  generating = false;
  clearInterval(tickTimer);
  document.body.classList.remove('performing');
  $('gobar').style.display = 'block';
  addMsg('sys', '', '生成失败：' + String(ev.payload).slice(0, 240));
  speak('抱歉，中间出了点问题，我们再试一次好吗？', null, 'concerned');
});

/* ============ 完成后的动作 / PNG 分享海报 ============ */
const posterModal = $('poster-modal');
const posterCanvas = $('poster-canvas');
const posterStatus = $('poster-status');
const FONT_SANS = '"Microsoft YaHei","PingFang SC","Segoe UI",sans-serif';
const FONT_MONO = '"Cascadia Mono",Consolas,monospace';

function normalizePublication(r) {
  return {
    id: r.id,
    siteUrl: r.siteUrl || r.site_url,
    posterUrl: r.posterUrl || r.poster_url,
    uploadedFiles: r.uploadedFiles ?? r.uploaded_files,
    uploadMode: r.uploadMode || r.upload_mode,
  };
}

function setPosterStatus(text, state) {
  posterStatus.textContent = text;
  posterStatus.className = 'sub' + (state ? ' ' + state : '');
}

function roundedRectPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function wrapCanvasText(ctx, text, maxWidth, maxLines) {
  const chars = Array.from(String(text || '').trim());
  if (!chars.length) return [];
  const lines = [];
  let line = '';
  for (const ch of chars) {
    const next = line + ch;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = ch;
      if (lines.length === maxLines) break;
    } else {
      line = next;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines) {
    let last = lines[maxLines - 1];
    const consumed = lines.join('').length;
    if (consumed < chars.length) {
      while (last && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
      lines[maxLines - 1] = last + '…';
    }
  }
  return lines;
}

function drawTextLines(ctx, lines, x, y, lineHeight) {
  lines.forEach((line, i) => ctx.fillText(line, x, y + i * lineHeight));
  return y + lines.length * lineHeight;
}

async function loadRasterCover(dataUrl) {
  if (!/^data:image\/(?:jpeg|png|webp);base64,/i.test(String(dataUrl || ''))) {
    throw new Error('作品画面不是允许的 JPEG/PNG/WebP 位图');
  }
  const img = new Image();
  img.decoding = 'async';
  img.src = dataUrl;
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('作品画面解码失败'));
  });
  if (!img.naturalWidth || !img.naturalHeight) throw new Error('作品画面尺寸无效');
  return img;
}

function drawCoverImage(ctx, img, x, y, w, h) {
  const srcRatio = img.naturalWidth / img.naturalHeight;
  const dstRatio = w / h;
  let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
  if (srcRatio > dstRatio) {
    sw = img.naturalHeight * dstRatio;
    sx = (img.naturalWidth - sw) / 2;
  } else {
    sh = img.naturalWidth / dstRatio;
    sy = (img.naturalHeight - sh) / 2;
  }
  ctx.save();
  roundedRectPath(ctx, x, y, w, h, 28);
  ctx.clip();
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  const shade = ctx.createLinearGradient(0, y, 0, y + h);
  shade.addColorStop(0, 'rgba(4,7,13,.02)');
  shade.addColorStop(1, 'rgba(4,7,13,.34)');
  ctx.fillStyle = shade;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

function drawQrMatrix(ctx, matrix, x, y, boxSize) {
  if (!Array.isArray(matrix) || !matrix.length ||
      !matrix.every(row => Array.isArray(row) && row.length === matrix.length)) {
    throw new Error('体验二维码矩阵不完整');
  }
  const n = matrix.length;
  const quiet = 4;
  const cell = Math.floor(boxSize / (n + quiet * 2));
  if (cell < 2) throw new Error('体验二维码过密，无法清晰绘制');
  const actual = cell * (n + quiet * 2);
  const ox = x + Math.floor((boxSize - actual) / 2);
  const oy = y + Math.floor((boxSize - actual) / 2);
  ctx.fillStyle = '#fff';
  ctx.fillRect(ox, oy, actual, actual);
  ctx.fillStyle = '#071019';
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (matrix[row][col]) {
        ctx.fillRect(ox + (col + quiet) * cell, oy + (row + quiet) * cell, cell, cell);
      }
    }
  }
}

async function renderSharePoster(canvas, spec) {
  if (canvas.width !== 1080 || canvas.height !== 1440) {
    throw new Error('海报画布必须是 1080×1440');
  }
  const ctx = canvas.getContext('2d', { alpha: false });
  const brand = spec.brand || {};
  const bg = /^#[0-9a-f]{6}$/i.test(brand.bg || '') ? brand.bg : '#070b12';
  const accent = /^#[0-9a-f]{6}$/i.test(brand.accent || '') ? brand.accent : '#66d9e8';
  const gold = /^#[0-9a-f]{6}$/i.test(brand.gold || '') ? brand.gold : '#f0d08a';

  ctx.save();
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 1080, 1440);
  const base = ctx.createLinearGradient(0, 0, 1080, 1440);
  base.addColorStop(0, 'rgba(102,217,232,.13)');
  base.addColorStop(.45, 'rgba(7,11,18,0)');
  base.addColorStop(1, 'rgba(240,208,138,.08)');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 1080, 1440);

  // 主活动视觉元素：48px 网格、青色光晕、金色定位点，全部直接由 Canvas 绘制。
  ctx.strokeStyle = 'rgba(143,163,182,.09)';
  ctx.lineWidth = 1;
  for (let x = 24; x < 1080; x += 48) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 1440); ctx.stroke(); }
  for (let y = 24; y < 1440; y += 48) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(1080, y); ctx.stroke(); }
  const glow = ctx.createRadialGradient(920, 140, 0, 920, 140, 360);
  glow.addColorStop(0, 'rgba(102,217,232,.23)');
  glow.addColorStop(1, 'rgba(102,217,232,0)');
  ctx.fillStyle = glow; ctx.fillRect(560, 0, 520, 500);

  ctx.fillStyle = accent;
  ctx.font = `600 24px ${FONT_MONO}`;
  ctx.fillText((brand.name || '一句话生成').toUpperCase(), 84, 92);
  ctx.textAlign = 'right';
  ctx.fillStyle = gold;
  ctx.fillText(brand.date || '2026.08.18', 996, 92);
  ctx.textAlign = 'left';
  ctx.strokeStyle = accent; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(84, 126); ctx.lineTo(996, 126); ctx.stroke();

  ctx.fillStyle = 'rgba(217,226,234,.68)';
  ctx.font = `500 22px ${FONT_SANS}`;
  ctx.fillText('创作者 / CREATOR', 84, 184);
  ctx.fillStyle = '#f3f7fa';
  let creatorSize = 48;
  do { ctx.font = `700 ${creatorSize}px ${FONT_SANS}`; creatorSize -= 2; }
  while (creatorSize > 30 && ctx.measureText(spec.creator).width > 912);
  ctx.fillText(spec.creator, 84, 242);

  const cover = await loadRasterCover(spec.coverDataUrl);
  drawCoverImage(ctx, cover, 84, 282, 912, 548);
  ctx.strokeStyle = 'rgba(102,217,232,.55)'; ctx.lineWidth = 2;
  roundedRectPath(ctx, 84, 282, 912, 548, 28); ctx.stroke();

  ctx.fillStyle = accent;
  ctx.font = `600 19px ${FONT_MONO}`;
  ctx.fillText('作品主题 / WORK', 84, 888);
  ctx.fillStyle = '#f3f7fa';
  ctx.font = `750 58px ${FONT_SANS}`;
  const titleLines = wrapCanvasText(ctx, spec.title, 912, 2);
  const afterTitle = drawTextLines(ctx, titleLines, 84, 956, 70);
  ctx.fillStyle = 'rgba(217,226,234,.80)';
  ctx.font = `400 28px ${FONT_SANS}`;
  drawTextLines(ctx, wrapCanvasText(ctx, spec.tagline || '一句话，长成一个可以体验的网站。', 640, 2), 84, afterTitle + 8, 40);

  ctx.fillStyle = accent;
  ctx.font = `600 19px ${FONT_MONO}`;
  ctx.fillText('扫码体验 / OPEN THE SITE', 744, 1128);
  drawQrMatrix(ctx, spec.qrMatrix, 744, 1148, 252);

  ctx.fillStyle = gold;
  ctx.font = `600 20px ${FONT_MONO}`;
  ctx.fillText(brand.event || '现场共创活动', 84, 1190);
  ctx.fillStyle = '#f3f7fa';
  ctx.font = `650 31px ${FONT_SANS}`;
  drawTextLines(ctx, wrapCanvasText(ctx, brand.slogan || '说一句话，就有一个网站', 590, 2), 84, 1240, 43);
  ctx.fillStyle = 'rgba(143,163,182,.78)';
  ctx.font = `500 18px ${FONT_MONO}`;
  ctx.fillText(brand.en || 'ONE SENTENCE · ONE SITE', 84, 1344);
  ctx.fillStyle = accent;
  ctx.fillRect(84, 1382, 110, 4);
  ctx.fillStyle = gold;
  ctx.fillRect(204, 1382, 34, 4);
  ctx.restore();
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Canvas PNG 编码失败')), 'image/png');
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '');
    reader.onerror = () => reject(new Error('读取 PNG 编码失败'));
    reader.readAsDataURL(blob);
  });
}

async function runPosterFlow() {
  if (!publication || posterBusy) return;
  const seq = ++posterSeq;
  posterBusy = true;
  posterUploaded = false;
  posterModal.classList.add('on');
  posterModal.setAttribute('aria-hidden', 'false');
  $('btn-share').disabled = true;
  $('btn-share').textContent = '海报生成中…';
  $('btn-poster-open').disabled = true;
  $('btn-poster-retry').style.display = 'none';
  let phase = 'prepare';
  let pngBase64 = '';
  try {
    setPosterStatus('正在读取当前作品与体验二维码…');
    const spec = await invoke('prepare_share_poster');
    if (seq !== posterSeq) return;
    posterSpec = spec;
    phase = 'render';
    setPosterStatus('正在绘制作品画面、活动主题和体验二维码…');
    await renderSharePoster(posterCanvas, spec);
    if (seq !== posterSeq) return;
    const blob = await canvasToPngBlob(posterCanvas);
    if (posterCanvas.width !== 1080 || posterCanvas.height !== 1440) throw new Error('导出尺寸异常');
    phase = 'upload';
    setPosterStatus('PNG 已生成，正在上传到 Cloudflare…');
    pngBase64 = await blobToBase64(blob);
    const uploaded = await invoke('upload_share_poster', { nonce: spec.nonce, pngBase64 });
    pngBase64 = '';
    if (seq !== posterSeq) return;
    publication.posterUrl = uploaded.posterUrl || publication.posterUrl;
    posterUploaded = true;
    setPosterStatus('分享卡/海报已经上线，可扫码体验作品。', 'ok');
    $('btn-poster-open').disabled = false;
    $('btn-share').disabled = false;
    $('btn-share').textContent = '打开分享卡/海报';
    addMsg('sys', '', `PNG 分享海报已上线：${publication.posterUrl}`);
  } catch (e) {
    pngBase64 = '';
    if (seq !== posterSeq) return;
    const prefix = phase === 'upload' ? '网站已上线；海报上传失败：' : '海报生成失败：';
    setPosterStatus(prefix + String(e).slice(0, 180), phase === 'upload' ? 'warn' : 'bad');
    $('btn-poster-retry').style.display = '';
    $('btn-share').disabled = false;
    $('btn-share').textContent = '重试生成分享卡/海报';
    addMsg('sys', '', prefix + String(e).slice(0, 220));
  } finally {
    if (seq === posterSeq) posterBusy = false;
  }
}

$('btn-open').onclick = async () => {
  if (!previewUrl) return;
  try { await invoke('open_external', { url: previewUrl }); }
  catch (e) { addMsg('sys', '', String(e)); }
};
$('btn-reload').onclick = reloadPreview;
$('btn-regen').onclick = () => startGeneration(true);
$('btn-publish').onclick = async () => {
  const btn = $('btn-publish');
  btn.disabled = true; btn.textContent = '上线中…';
  try {
    const r = await invoke('publish_site');
    publication = normalizePublication(r);
    addMsg('sys', '', `已上线：${publication.siteUrl}（${publication.uploadedFiles} 个文件，通道 ${publication.uploadMode}）`);
    speak('上线了，你的专属网址已经生效。现在可以生成分享海报。', null, 'amused');
    pvurl.textContent = publication.siteUrl;
    btn.textContent = '已上线';
    $('btn-share').disabled = false;
    $('btn-share').textContent = '生成分享卡/海报';
  } catch (e) {
    btn.disabled = false; btn.textContent = '推上线，分配网址';
    addMsg('sys', '', '上线失败：' + String(e).slice(0, 240));
  }
};
$('btn-share').onclick = () => {
  if (posterUploaded && publication) {
    invoke('open_external', { url: publication.posterUrl }).catch(e => addMsg('sys', '', String(e)));
  } else {
    runPosterFlow();
  }
};
$('btn-poster-close').onclick = () => {
  posterModal.classList.remove('on');
  posterModal.setAttribute('aria-hidden', 'true');
};
$('btn-poster-retry').onclick = runPosterFlow;
$('btn-poster-open').onclick = () => {
  if (publication && posterUploaded) {
    invoke('open_external', { url: publication.posterUrl }).catch(e => addMsg('sys', '', String(e)));
  }
};

/* ============ 一句话直达 ============
   规划书把访谈当成必经之路，现场跑下来 4–6 轮问答要三四分钟，
   而排队的人只想看见页面开始长。所以留一条不经访谈的路径。
   访谈入口照旧保留——愿意细说的人说得越多，需求单越准。 */
/* 胶囊上只写短标签，填进输入框的是整句。
   侧栏只有 420px 宽，四行整句会把直达区撑到把需求单挤没；
   而填进去的那句越具体，补出来的需求单越准，两者不能将就同一份文本。 */
const EXAMPLES = [
  ['宠物纪念站', '给我家养了十八年的橘猫做一个纪念站，放照片和几段故事'],
  ['摄影作品集', '做一个我的摄影作品集，安静一点，黑白为主'],
  ['读书会招新', '给我们的读书会做个招新页，写清楚每周活动和怎么加入'],
  ['个人简历页', '做一份我的个人简历页，写我的经历和做过的东西'],
];

const oneline = $('oneline'), lstatus = $('lstatus');

function setLaunchStatus(text, bad) {
  lstatus.textContent = text || '';
  lstatus.className = 'lstatus' + (bad ? ' bad' : '');
}

function setPreparingControls(busy) {
  oneline.disabled = busy;
  textin.disabled = busy;
  $('send').disabled = busy;
  $('btn-chat').disabled = busy;
  document.querySelectorAll('.lchip').forEach(chip => {
    chip.setAttribute('aria-disabled', busy ? 'true' : 'false');
    chip.style.pointerEvents = busy ? 'none' : '';
  });
}

/* 从任意可用的文字直接开工。
   这是「一点就生成」的主干：需求单齐了就直接开工，不齐就先用一句话补齐再开工，
   **中间不再回头找用户要任何东西**。 */
async function beginFromAnything(seed) {
  if (generating || preparing) return;
  if (inflight) {
    setLaunchStatus('真昼正在回复，等这条需求补完就可以开始。');
    return;
  }

  const attempt = ++launchSeq;
  const startedInChat = document.body.classList.contains('chatting');
  // 直达框里的话改过了就得重新补一份。访谈那条路上 oneline 是空的（切过去时清掉了），
  // 所以这里不会把聊出来的需求单误判成过期。
  const typed = oneline.value.trim();
  const s = (seed || seedText()).trim();
  if (!s) {
    setLaunchStatus('先写一句话，说说你想做个什么网站。', true);
    (startedInChat ? textin : oneline).focus();
    return;
  }

  preparing = true;
  setPreparingControls(true);
  updateGo();

  try {
    if (!(CLOUD && CLOUD.publish && CLOUD.image)) {
      setLaunchStatus('正在重新检查 Cloudflare 发布与生图能力…');
      await refreshCloud();
      if (!(CLOUD && CLOUD.publish && CLOUD.image)) {
        throw new Error('云端发布或生图暂不可用；可点击右上角云端状态再次重试。');
      }
    }
    if (attempt !== launchSeq || startedInChat !== document.body.classList.contains('chatting')) {
      setLaunchStatus('输入或模式已经变化，请按当前内容重新开始。');
      return;
    }

    if (workable() && !(typed && typed !== reqSeed)) {
      setLaunchStatus('');
      startGeneration(false);
      return;
    }

    setLaunchStatus('真昼正在把这句话展开成需求单，十几秒就好…');
    // 这十几秒里舞台上必须有人说话，否则和「点了没反应」在观感上没区别
    speak('好，就按你说的做。我先把它理成一份需求单，你稍等一下。', null, 'warm');

    // 这个命令的契约是「永不因模型失败而失败」（见 main.rs）：
    // 超时或 JSON 写坏都会退成本地拼装的需求单，照样能开工。
    const req = await invoke('quick_requirement', { sentence: s });
    if (attempt !== launchSeq || startedInChat !== document.body.classList.contains('chatting')) {
      setLaunchStatus('输入或模式已经变化，请按当前内容重新开始。');
      return;
    }
    renderRequirement(req);
    reqSeed = typed;
    ready = true;
    $('side-sub').textContent = '一句话直达';
    addMsg('me', '你', s);
    history.push({ role: 'user', content: s });
    setLaunchStatus('');
    startGeneration(false);
  } catch (e) {
    setLaunchStatus(String(e).slice(0, 120), true);
    addMsg('sys', '', String(e).slice(0, 200));
  } finally {
    preparing = false;
    setPreparingControls(false);
    updateGo();
  }
}

// Enter 直接开工：一句话场景里换行没什么用，Shift+Enter 留给真想换行的人
oneline.onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); beginFromAnything(oneline.value); }
};
oneline.oninput = () => {
  launchSeq++;
  updateGo();
  if (lstatus.textContent) setLaunchStatus('');
};

for (const [label, sentence] of EXAMPLES) {
  const c = document.createElement('span');
  c.className = 'lchip';
  c.textContent = label;
  c.title = sentence;
  // 只填进输入框，不直接开工：替人做决定会让人不敢点第二次
  c.onclick = () => {
    if (preparing || generating) return;
    launchSeq++;
    oneline.value = sentence;
    oneline.focus();
    updateGo();
    setLaunchStatus('');
  };
  $('lex').appendChild(c);
}

$('btn-chat').onclick = () => {
  if (preparing || generating) return;
  launchSeq++;
  document.body.classList.add('chatting');
  $('side-title').textContent = '需求单 · 实时';
  // 把已经写的那句话带过去，别让人重打一遍。带过去就从 oneline 清掉，
  // 否则 seedText() 会一直优先读它，后面聊出来的内容反而被这句旧话盖住。
  if (oneline.value.trim() && !textin.value.trim()) textin.value = oneline.value.trim();
  oneline.value = '';
  textin.focus();
  layoutMouth();
  updateGo();
};

/* ============ 交互绑定 ============ */
$('send').onclick = sendText;
textin.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); } };
textin.oninput = () => { launchSeq++; updateGo(); };
$('stop').onclick = () => { stopAudio(); subtitle.textContent = ''; };
goBtn.onclick = () => beginFromAnything();

/* 设置面板 */
const modal = $('modal');
function clearSettingSecrets() {
  $('f-key').value = '';
  $('f-ttskey').value = '';
}
$('btn-setting').onclick = async () => {
  clearSettingSecrets();
  $('f-url').value = BOOT.apiUrl || '';
  $('f-model').value = BOOT.model || '';
  $('f-hall').value = BOOT.hallUrl || '';
  $('f-creator').value = await invoke('get_creator').catch(() => '');
  modal.classList.add('on');
};
$('btn-cancel').onclick = () => {
  clearSettingSecrets();
  modal.classList.remove('on');
};
$('btn-save').onclick = async () => {
  const patch = {
    apiUrl: $('f-url').value, model: $('f-model').value, hallUrl: $('f-hall').value,
  };
  const k = $('f-key').value.trim();
  if (k) patch.apiKey = k;
  const tk = $('f-ttskey').value.trim();
  if (tk) patch.ttsKey = tk;
  // invoke 会在返回 Promise 前同步序列化参数；随后立刻清空 DOM，避免 WebView2
  // 的表单恢复/自动填充资料库在网络等待期间抓走明文。
  let saving;
  try {
    saving = invoke('save_config', { patch });
  } finally {
    clearSettingSecrets();
  }
  try {
    await saving;
    const name = $('f-creator').value.trim();
    if (name) {
      const saved = await invoke('set_creator', { name });
      chipCreator.textContent = '创作者 ' + saved;
      chipCreator.className = 'chip ok';
    }
    modal.classList.remove('on');
    await refreshBoot();
    addMsg('sys', '', '设置已保存，正在重新验证环境');
    runEnvironmentDoctor(true);
  } catch (e) {
    addMsg('sys', '', '保存失败：' + String(e).slice(0, 160));
  }
};

/* 音色 */
const voiceSel = $('voiceSel');
for (const [id, name] of VOICES) {
  const o = document.createElement('option');
  o.value = id; o.textContent = name;
  voiceSel.appendChild(o);
}
voiceSel.onchange = () => {
  voiceId = voiceSel.value;
  invoke('save_config', { patch: { voiceId } }).catch(() => {});
  speak('嗯…换成这个声音，你还听得习惯吗？', null, 'warm');
};

/* ============ 启动 ============ */
async function refreshBoot() {
  BOOT = await invoke('boot');
  // 只拿“是否可用”这一位；TTS key 留在 Rust 进程里，绝不回给 JavaScript。
  TTS = !!BOOT.ttsConfigured;
  voiceId = BOOT.voiceId || VOICES[0][0];
  if (!VOICES.some(v => v[0] === voiceId)) voiceId = VOICES[0][0];
  voiceSel.value = voiceId;
  $('cfgpath').textContent = '本机加密配置 · ' + BOOT.configPath;

  if (BOOT.configured) {
    chipModel.textContent = `模型 ${BOOT.model}`; chipModel.className = 'chip ok';
  } else {
    chipModel.textContent = '模型 未配置'; chipModel.className = 'chip bad';
  }
  const name = await invoke('get_creator').catch(() => '');
  chipCreator.textContent = name ? '创作者 ' + name : '创作者 未填';
  chipCreator.className = 'chip ' + (name ? 'ok' : 'warn');
}

function applyCloudCapabilities(caps) {
  CLOUD = caps;
  cloudChecked = true;
  const ok = !!(caps && caps.publish && caps.image);
  chipCloud.textContent = ok ? '云端 就绪' : '云端 部分就绪';
  chipCloud.className = 'chip ' + (ok ? 'ok' : 'warn');
  chipCloud.title = ok
    ? `发布、R2/D1、生图已就绪 · ${caps.imageModel || 'Workers AI'}`
    : 'Cloudflare 发布或生图能力未完整启用';
  updateGo();
}

async function probeCloud() {
  CLOUD = null;
  cloudChecked = false;
  chipCloud.textContent = '云端 …';
  chipCloud.className = 'chip';
  chipCloud.title = BOOT && BOOT.cloudStatus ? BOOT.cloudStatus : '正在联网检查发布与生图能力';
  updateGo();
  try {
    if (BOOT && BOOT.cloudConfigured === false) throw new Error(BOOT.cloudStatus || '受控安装包未装入发布凭据');
    const caps = await invoke('cloud_capabilities');
    applyCloudCapabilities(caps);
  } catch (e) {
    CLOUD = null;
    chipCloud.textContent = BOOT && BOOT.cloudConfigured === false ? '云端 未配置' : '云端 点击重试';
    chipCloud.className = 'chip bad';
    chipCloud.title = (BOOT && BOOT.cloudConfigured === false ? '' : '点击重新检查 · ') + String(e).slice(0, 220);
    addMsg('sys', '', '云端发布/生图不可用：' + String(e).slice(0, 180));
  } finally {
    cloudChecked = true;
    updateGo();
  }
}

function refreshCloud() {
  if (!cloudRefreshPromise) {
    cloudRefreshPromise = probeCloud().finally(() => { cloudRefreshPromise = null; });
  }
  return cloudRefreshPromise;
}

const DOCTOR_CHECKS = [
  ['platform', '系统与架构'],
  ['storage', '本地目录读写'],
  ['config', '模型与语音配置'],
  ['webview', '系统 WebView 安全设置'],
  ['preview', '本地预览服务'],
  ['cloud', 'Cloudflare 发布能力'],
  ['model', '模型 API 真实请求'],
  ['tts', 'MiniMax 语音真实请求'],
  ['image', 'Workers AI 真实生图'],
];
const doctorGate = $('doctor-gate'), doctorList = $('doctor-list');
let doctorSeq = 0;

function resetDoctorRows() {
  doctorList.innerHTML = '';
  for (const [id, label] of DOCTOR_CHECKS) {
    const row = document.createElement('div');
    row.className = 'doctor-item waiting';
    row.dataset.check = id;
    const state = document.createElement('span'); state.className = 'state';
    const title = document.createElement('span'); title.className = 'label'; title.textContent = label;
    const detail = document.createElement('span'); detail.className = 'detail'; detail.textContent = '等待检查';
    row.append(state, title, detail);
    doctorList.appendChild(row);
  }
}

function renderDoctorCheck(check) {
  if (!check || !check.id) return;
  let row = doctorList.querySelector(`[data-check="${CSS.escape(check.id)}"]`);
  if (!row) {
    row = document.createElement('div');
    row.className = 'doctor-item'; row.dataset.check = check.id;
    const state = document.createElement('span'); state.className = 'state';
    const title = document.createElement('span'); title.className = 'label';
    const detail = document.createElement('span'); detail.className = 'detail';
    row.append(state, title, detail); doctorList.appendChild(row);
  }
  const status = ['waiting', 'running', 'pass', 'fail', 'skipped'].includes(check.status)
    ? check.status : 'waiting';
  row.className = 'doctor-item ' + status;
  row.querySelector('.label').textContent = check.label || check.id;
  const elapsed = check.elapsedMs ? ` · ${(check.elapsedMs / 1000).toFixed(1)}s` : '';
  row.querySelector('.detail').textContent = (check.detail || '') + elapsed;
}

const doctorListenReady = listen('doctor:progress', event => {
  try { renderDoctorCheck(event.payload); }
  catch (error) { $('doctor-summary').textContent = '环境医生界面更新失败：' + String(error).slice(0, 100); }
});

async function runEnvironmentDoctor(forceDeep) {
  const seq = ++doctorSeq;
  doctorGate.classList.add('on');
  doctorGate.classList.remove('success');
  $('doctor-actions').classList.remove('on');
  $('doctor-summary').textContent = forceDeep
    ? '正在重新执行最小真实 API 验证，请稍候…'
    : '正在确认这台电脑能完整运行模型、语音、生图与上线功能…';
  $('doctor-note').textContent = '首次启动会做最小真实 API 验证；通过后 7 天内只做快速检查，不重复产生费用。';
  resetDoctorRows();
  try {
    await doctorListenReady;
    const report = await invoke('environment_doctor', { forceDeep: !!forceDeep });
    if (seq !== doctorSeq) return report;
    for (const check of report.checks || []) renderDoctorCheck(check);
    $('doctor-summary').textContent = report.summary || (report.ready ? '检查通过' : '检查未通过');
    $('doctor-note').textContent = report.cached
      ? '真实模型、语音和生图检查命中 7 天安全缓存；本次仍重新验证了本机目录、WebView、预览与 Cloudflare。'
      : report.deep ? '本次已向模型、MiniMax TTS 和 Workers AI 发出最小真实请求。'
      : '本次只执行快速检查。';
    if (report.capabilities) applyCloudCapabilities(report.capabilities);
    else {
      CLOUD = null; cloudChecked = true;
      chipCloud.textContent = BOOT && BOOT.cloudConfigured === false ? '云端 未配置' : '云端 点击重试';
      chipCloud.className = 'chip bad';
      chipCloud.title = report.summary || '环境医生未通过 Cloudflare 检查';
      updateGo();
    }
    if (report.ready) {
      doctorGate.classList.add('success');
      setTimeout(() => { if (seq === doctorSeq) doctorGate.classList.remove('on'); }, 700);
    } else {
      $('doctor-actions').classList.add('on');
    }
    return report;
  } catch (error) {
    if (seq !== doctorSeq) return null;
    $('doctor-summary').textContent = '环境医生无法完成：' + String(error).slice(0, 160);
    $('doctor-note').textContent = '可以重试、打开设置，或先以功能受限模式进入；程序不会停在白屏。';
    $('doctor-actions').classList.add('on');
    CLOUD = null; cloudChecked = true; updateGo();
    return null;
  }
}

$('doctor-retry').onclick = () => runEnvironmentDoctor(true);
$('doctor-settings').onclick = () => $('btn-setting').click();
$('doctor-limited').onclick = () => {
  doctorSeq++;
  doctorGate.classList.remove('on');
  addMsg('sys', '', '已功能受限进入；未通过的模型、生图或上线能力仍会被安全闸拦下。');
  updateGo();
};

function retryCloudFromUi() {
  if (preparing || generating) return;
  refreshCloud().catch(() => {});
}
chipCloud.setAttribute('role', 'button');
chipCloud.tabIndex = 0;
chipCloud.onclick = retryCloudFromUi;
chipCloud.onkeydown = e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    retryCloudFromUi();
  }
};

(async function boot() {
  // autocomplete=off 挡不住所有恢复路径，这里再清一次：现场是一个人接一个人上来用，
  // 输入框里留着上一位写的那句话，接手的人很可能没看清就按了生成。
  $('oneline').value = '';
  try {
    await refreshBoot();
    await runEnvironmentDoctor(false);
  } catch (e) {
    addMsg('sys', '', '启动异常：' + String(e));
    return;
  }
  layoutMouth();
  try { previewUrl = await invoke('preview_root'); pvurl.textContent = previewUrl; } catch {}

  addMsg('her', '真昼', BOOT.opening);
  history.push({ role: 'assistant', content: JSON.stringify({
    spokenText: BOOT.opening, subtitleText: BOOT.opening, emotion: 'warm', requirement: {}, ready: false }) });

  if (!BOOT.configured) {
    addMsg('sys', '', '还没配模型密钥，点右上角「设置」填一下。');
  } else {
    addMsg('sys', '', '点一下画面，真昼就会开口。');
  }
  updateGo();
})();

/* 自动播放策略：AudioContext 必须等一次用户手势才能出声。
   顺手用这次手势把开场白念出来 —— 除非用户一上手就在输入框里打字。 */
let openingDone = false;
function unlockAudio(e) {
  initAudio();
  if (openingDone) return;
  openingDone = true;
  // .oneshot / .gobar 也要排除：按生成的那一下同时是音频解锁手势，
  // 念开场白会和紧接着的"我先把它理成需求单"撞车（后者 stopAudio 会把它掐掉，
  // 听起来像真昼说了半句被打断）。
  const inRow = e && e.target && e.target.closest
    && e.target.closest('.inputrow, .chips, .modal, .oneshot, .gobar');
  if (!inRow && BOOT) speak(BOOT.opening, BOOT.opening, 'warm');
}
document.addEventListener('pointerdown', unlockAudio, { once: true });
document.addEventListener('keydown', unlockAudio, { once: true });
