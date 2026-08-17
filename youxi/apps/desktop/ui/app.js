"use strict";
/* 一句话生成 · 桌面端前端
 *
 * 口型引擎与 T2A 流水线整段沿用《真昼·口袋版》——那套东西已经在真机上跑熟了
 * （分句 + 边放边合成 + 串行闸 + RPM 退避 + 双模型降级 + 波形驱动口型），
 * 规划书第 03 节的判断是「原样保留、不用动」，这里照办，只把密钥来源
 * 从内嵌常量换成向 Rust 要。
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
const mouthClosed = $('mouthClosed'), mouthHalf = $('mouthHalf'), mouthOpen = $('mouthOpen');
const reqcard = $('reqcard'), goBtn = $('go');
const pvframe = $('pvframe'), pvurl = $('pvurl'), pvwait = $('pvwait');

let BOOT = null, TTS = null;
let requirement = null, ready = false;
let siteId = null, previewUrl = null;
let generating = false, finished = false;
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
async function ttsFetch(text, emo, model) {
  const ctrl = new AbortController(); inflightTts.add(ctrl);
  try {
    const r = await fetch(TTS.url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'Authorization': 'Bearer ' + TTS.key },
      body: JSON.stringify({
        model, text, stream: false, language_boost: 'Chinese',
        voice_setting: { voice_id: voiceId, speed: emo.speed, vol: 1.0, pitch: emo.pitch, emotion: emo.e },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
      }),
    });
    if (!r.ok) throw new Error(`T2A HTTP ${r.status}`);
    const j = await r.json();
    const sc = j && j.base_resp ? j.base_resp.status_code : -1;
    if (sc !== 0) { const e = new Error(`T2A ${sc} ${(j.base_resp && j.base_resp.status_msg) || ''}`.trim()); e.code = sc; throw e; }
    const hex = j.data && j.data.audio;
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
          const bytes = await serialize(() => ttsFetch(text, emo, model));
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
  if (!TTS || !TTS.key) { setTimeout(() => { if (seq === playSeq) subtitle.textContent = ''; }, 7000); return; }
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

function updateGo() {
  const ok = ready && !generating && requirement
    && fieldText(requirement, 'title') && fieldText(requirement, 'content');
  goBtn.disabled = !ok;
  goBtn.textContent = ok ? '就这样，开始做' : '再聊两句，让真昼问清楚';
}

/* ============ 访谈 ============ */
const history = [];
let inflight = false, thinkStart = 0, latTimer = null;

async function sendText() {
  const t = textin.value.trim();
  if (!t || inflight || generating) return;
  textin.value = '';
  addMsg('me', '你', t);
  history.push({ role: 'user', content: t });

  inflight = true;
  thinkingEl.classList.add('on');
  statusEl.textContent = '思考中…';
  thinkStart = performance.now();
  latTimer = setInterval(() => {
    latEl.textContent = `等待回应 ${((performance.now() - thinkStart) / 1000).toFixed(0)}s`;
  }, 500);

  try {
    const reply = await invoke('interview_turn', { history });
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
    statusEl.textContent = '';
    latEl.textContent = '';
    chipModel.textContent = '模型 异常'; chipModel.className = 'chip bad';
    addMsg('sys', '', String(e).slice(0, 160));
  } finally {
    inflight = false;
    thinkingEl.classList.remove('on');
    clearInterval(latTimer);
  }
}

/* ============ 生成演出 ============
   规划书第 01 节：十分钟里屏幕上必须一直有东西在动、在长出来。
   真昼在旁边当引导员讲解「现在在做什么」——旁白是本地固定台词，
   不再调模型：省 token，也不会因为网络抖动让讲解迟到。 */
const STAGES = [
  ['skeleton', '骨架先出来'],
  ['hero',     '首屏正在长出来'],
  ['content',  '内容区一屏一屏地填'],
  ['footer',   '补页脚与出口'],
  ['polish',   '配图与细节'],
  ['done',     '做好了'],
];
const NARRATION = {
  skeleton: ['先把页面的骨架搭出来，你会看到一个灰色的轮廓，那是它的结构。', 'neutral'],
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

async function startGeneration(isRegen) {
  if (generating || !requirement) return;
  generating = true; finished = false;
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

  try {
    const r = await invoke('start_generation', { requirement, regenerate: !!isRegen });
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
    clearInterval(tickTimer);
    document.body.classList.remove('performing');
    $('gobar').style.display = 'block';
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

/* ============ 完成后的动作 ============ */
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
    const r = await invoke('publish_site', {
      title: fieldText(requirement, 'title') || '我的网站',
      tagline: fieldText(requirement, 'tagline'),
    });
    addMsg('sys', '', `已上线：${r.site_url}（${r.uploaded_files} 个文件，通道 ${r.upload_mode}）`);
    speak('上线了，你的专属网址已经生效。', null, 'amused');
    pvurl.textContent = r.site_url;
    btn.textContent = '已上线';
  } catch (e) {
    btn.disabled = false; btn.textContent = '推上线，分配网址';
    addMsg('sys', '', '上线失败：' + String(e).slice(0, 240));
  }
};

/* ============ 交互绑定 ============ */
$('send').onclick = sendText;
textin.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); } };
$('stop').onclick = () => { stopAudio(); subtitle.textContent = ''; };
goBtn.onclick = () => startGeneration(false);

/* 设置面板 */
const modal = $('modal');
$('btn-setting').onclick = async () => {
  $('f-key').value = '';
  $('f-ttskey').value = '';
  $('f-url').value = BOOT.apiUrl || '';
  $('f-model').value = BOOT.model || '';
  $('f-hall').value = BOOT.hallUrl || '';
  $('f-creator').value = await invoke('get_creator').catch(() => '');
  modal.classList.add('on');
};
$('btn-cancel').onclick = () => modal.classList.remove('on');
$('btn-save').onclick = async () => {
  const patch = {
    apiUrl: $('f-url').value, model: $('f-model').value, hallUrl: $('f-hall').value,
  };
  const k = $('f-key').value.trim();
  if (k) patch.apiKey = k;
  const tk = $('f-ttskey').value.trim();
  if (tk) patch.ttsKey = tk;
  try {
    await invoke('save_config', { patch });
    const name = $('f-creator').value.trim();
    if (name) {
      const saved = await invoke('set_creator', { name });
      chipCreator.textContent = '创作者 ' + saved;
      chipCreator.className = 'chip ok';
    }
    modal.classList.remove('on');
    await refreshBoot();
    addMsg('sys', '', '设置已保存');
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
  TTS = await invoke('tts_cred');
  voiceId = BOOT.voiceId || VOICES[0][0];
  if (!VOICES.some(v => v[0] === voiceId)) voiceId = VOICES[0][0];
  voiceSel.value = voiceId;
  $('cfgpath').textContent = '配置文件 ' + BOOT.configPath;

  if (BOOT.configured) {
    chipModel.textContent = `模型 ${BOOT.model}`; chipModel.className = 'chip ok';
  } else {
    chipModel.textContent = '模型 未配置'; chipModel.className = 'chip bad';
  }
  const name = await invoke('get_creator').catch(() => '');
  chipCreator.textContent = name ? '创作者 ' + name : '创作者 未填';
  chipCreator.className = 'chip ' + (name ? 'ok' : 'warn');
}

(async function boot() {
  try {
    await refreshBoot();
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
  const inRow = e && e.target && e.target.closest && e.target.closest('.inputrow, .chips, .modal');
  if (!inRow && BOOT) speak(BOOT.opening, BOOT.opening, 'warm');
}
document.addEventListener('pointerdown', unlockAudio, { once: true });
document.addEventListener('keydown', unlockAudio, { once: true });
