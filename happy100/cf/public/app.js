/* ===================================================================
   幸福小事 · 主逻辑
   =================================================================== */
(function () {
'use strict';

/* ───────── 小工具 ───────── */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const WK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const randHex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
const fmtSize = n => n < 1024 ? n + ' B'
                   : n < 1048576 ? Math.round(n / 1024) + ' KB'
                   : (n / 1048576).toFixed(1) + ' MB';
const fmtDur = s => { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ':' + pad(s % 60); };

function parseKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function mondayOf(d = new Date()) { const x = new Date(d); const w = x.getDay() || 7; return addDays(x, 1 - w); }
function diffDays(a, b) { return Math.round((parseKey(a) - parseKey(b)) / 864e5); }

const P = 'happy100:v2:';
// 会参与云同步的键；syncCode / lastOpen 只属于这台设备，不上传
const SYNCED = k => /^(day:|fired:|journal$|custom$|meta$|settings$|profile$|mdel$)/.test(k);

const store = {
  get(k, fb) { try { const v = localStorage.getItem(P + k); return v == null ? fb : JSON.parse(v); } catch { return fb; } },
  set(k, v) {
    try { localStorage.setItem(P + k, JSON.stringify(v)); } catch {}
    if (SYNCED(k)) SYNC.touch();
  },
  setQuiet(k, v) { try { localStorage.setItem(P + k, JSON.stringify(v)); } catch {} },
  del(k) { localStorage.removeItem(P + k); },
  keys() { return Object.keys(localStorage).filter(k => k.startsWith(P)); },
};

let toastTimer;
function toast(msg, ms = 1900) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ───────── 彩纸屑特效 ───────── */
const FX = {
  cv: null, cx: null, parts: [], raf: 0, dpr: 1,
  COLORS: ['#F0A582', '#A6C69C', '#F2CE86', '#E7ADB4', '#BCA9D4', '#9CB9D2'],
  init() {
    this.cv = $('#fx'); this.cx = this.cv.getContext('2d');
    const fit = () => {
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.cv.width = innerWidth * this.dpr;
      this.cv.height = innerHeight * this.dpr;
      this.cx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    };
    fit(); addEventListener('resize', fit);
  },
  burst(x, y, n = 22, power = 1) {
    if (!S.settings.fxOn) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (2 + Math.random() * 5.5) * power;
      this.parts.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 3.2 * power,
        g: 0.17 + Math.random() * 0.11,
        w: 4 + Math.random() * 6,
        h: 4 + Math.random() * 8,
        rot: Math.random() * 6.28,
        vr: (Math.random() - 0.5) * 0.34,
        c: this.COLORS[(Math.random() * this.COLORS.length) | 0],
        life: 1,
        decay: 0.008 + Math.random() * 0.009,
        round: Math.random() < 0.35,
      });
    }
    if (!this.raf) this.loop();
  },
  loop() {
    const { cx } = this;
    cx.clearRect(0, 0, innerWidth, innerHeight);
    this.parts = this.parts.filter(p => {
      p.vy += p.g; p.vx *= 0.992; p.x += p.vx; p.y += p.vy;
      p.rot += p.vr; p.life -= p.decay;
      if (p.life <= 0 || p.y > innerHeight + 40) return false;
      cx.save();
      cx.globalAlpha = Math.max(0, Math.min(1, p.life));
      cx.translate(p.x, p.y); cx.rotate(p.rot);
      cx.fillStyle = p.c;
      if (p.round) { cx.beginPath(); cx.arc(0, 0, p.w / 2, 0, 6.29); cx.fill(); }
      else { cx.beginPath(); cx.roundRect(-p.w / 2, -p.h / 2, p.w, p.h, 2); cx.fill(); }
      cx.restore();
      return true;
    });
    if (this.parts.length) this.raf = requestAnimationFrame(() => this.loop());
    else { cx.clearRect(0, 0, innerWidth, innerHeight); this.raf = 0; }
  },
  rain(n = 90) {
    if (!S.settings.fxOn) return;
    for (let i = 0; i < n; i++) {
      this.parts.push({
        x: Math.random() * innerWidth, y: -20 - Math.random() * 220,
        vx: (Math.random() - 0.5) * 1.6, vy: 1.6 + Math.random() * 2.6,
        g: 0.035, w: 5 + Math.random() * 7, h: 5 + Math.random() * 10,
        rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.2,
        c: this.COLORS[(Math.random() * this.COLORS.length) | 0],
        life: 1, decay: 0.0042, round: Math.random() < 0.35,
      });
    }
    if (!this.raf) this.loop();
  },
};

/* ───────── 状态 ───────── */
const S = {
  today: dayKey(),
  day: { checked: [], points: 0, notes: {} },
  journal: {},
  mdel: {},              // 删掉的照片视频：id → 删除时间。不记一笔的话，另一台设备会把它合回来
  custom: [],
  meta: { totalPoints: 0, streak: { days: 0, last: null }, badges: [] },
  settings: { workdays: [1, 2, 3, 4, 5], weather: 'sunny', override: null, remindTime: '20:30', remindOn: false, fxOn: true },
  profile: { nick: '', avatar: '🌻', ts: 0 },
  cat: 'all',
  screen: 'today',
  repTab: 'daily',
  mood: null,
  noteTarget: null,
  customCat: 'emotion',
  rec: null,
  viewer: null,          // 大图/视频查看器：{ day, i }
};

function allTasks() { return TASKS.concat(S.custom); }
function taskById(id) { return allTasks().find(t => t.id === Number(id)); }
function catOf(id) { return CATEGORIES.find(c => c.id === id) || CATEGORIES[0]; }
function isDone(id) { return S.day.checked.includes(Number(id)); }
function dayOf(k) { return store.get('day:' + k, { checked: [], points: 0, notes: {} }); }

/* ───────── 初始化 ───────── */
function init() {
  FX.init();
  S.settings = Object.assign(S.settings, store.get('settings', {}));
  S.journal  = store.get('journal', {});
  S.mdel     = store.get('mdel', {});
  S.custom   = store.get('custom', []);
  S.meta     = Object.assign(S.meta, store.get('meta', {}));
  S.profile  = Object.assign(S.profile, store.get('profile', {}));
  S.day      = dayOf(S.today);
  if (!S.day.notes) S.day.notes = {};

  rollover();
  renderHeader();
  renderCatStrip();
  renderTasks();
  renderProgress();
  renderModeUI();
  renderMoodRow();
  renderMe();
  bind();
  scheduleRollover();
  registerSW();
  SYNC.boot();

  // 从后台切回前台时顺手拉一次，保证多设备是最新的
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') SYNC.pullMerge();
  });
}

/* 跨日：把昨天的成绩结算进连续天数 */
function rollover() {
  const last = store.get('lastOpen', null);
  if (last && last !== S.today) {
    const prev = dayOf(last);
    if ((prev.checked || []).length > 0) {
      const st = S.meta.streak;
      if (!st.last) st.days = 1;
      else {
        const d = diffDays(last, st.last);
        if (d === 1) st.days += 1;
        else if (d > 1) st.days = 1;
      }
      st.last = last;
      store.set('meta', S.meta);
    }
  }
  store.set('lastOpen', S.today);
}
function scheduleRollover() {
  setInterval(() => { if (dayKey() !== S.today) location.reload(); }, 30000);
}

function persistDay() { S.day.ts = Date.now(); store.set('day:' + S.today, S.day); }
function persistMeta() { store.set('meta', S.meta); }
function persistSettings() { S.settings.ts = Date.now(); store.set('settings', S.settings); }

/* ───────── 顶部 ───────── */
function renderHeader() {
  const d = new Date();
  $('#hero-weekday').textContent = WK[d.getDay()];
  $('#hero-day').textContent = `${d.getMonth() + 1}月${d.getDate()}日`;
  const idx = Math.floor(parseKey(S.today).getTime() / 864e5) % DAILY_QUOTES.length;
  $('#quote-text').textContent = DAILY_QUOTES[idx];
}

function renderProgress() {
  const n = S.day.checked.length;
  const total = allTasks().length;   // 88 内置 + 你自己加的
  $('#done-count').textContent = n;
  $('#total-count').textContent = '/ ' + total;
  const C = 2 * Math.PI * 50;
  $('#ring-fg').style.strokeDashoffset = String(C - C * Math.min(1, n / total));
  $('#chip-streak').textContent = S.meta.streak.days;
  $('#chip-points').textContent = S.meta.totalPoints;

  const msgs = [
    ['今天才刚开始', '随便挑一件，做了就算'],
    ['起了个好头', '不用急，慢慢来就好'],
    ['状态不错呀', '今天的你在好好生活'],
    ['很有节奏了', '这样的一天很值得'],
    ['今天超厉害', '把日子过得闪闪发光'],
  ];
  const i = n === 0 ? 0 : n < 3 ? 1 : n < 8 ? 2 : n < 15 ? 3 : 4;
  $('#progress-title').textContent = msgs[i][0];
  $('#progress-sub').textContent = msgs[i][1];
}

function isWorkday() {
  if (S.settings.override && S.settings.override.date === S.today) return S.settings.override.val === 'work';
  return S.settings.workdays.includes(new Date().getDay());
}
function renderModeUI() {
  const seg = $('#seg-day');
  const work = isWorkday();
  seg.dataset.i = work ? '0' : '1';
  $$('#seg-day .seg-btn').forEach((b, i) => b.classList.toggle('is-on', i === (work ? 0 : 1)));
  $$('#weather-pick .wbtn').forEach(b => b.classList.toggle('is-on', b.dataset.weather === S.settings.weather));
}

/* ───────── 分类条 ───────── */
function renderCatStrip() {
  const nav = $('#cat-strip');
  const cnt = id => allTasks().filter(t => t.cat === id).length;
  const doneIn = id => allTasks().filter(t => t.cat === id && isDone(t.id)).length;
  nav.innerHTML =
    `<button class="cat-btn ${S.cat === 'all' ? 'is-on' : ''}" data-cat="all"><i>🌈</i>全部<small>${S.day.checked.length}/${allTasks().length}</small></button>` +
    CATEGORIES.map(c =>
      `<button class="cat-btn ${S.cat === c.id ? 'is-on' : ''}" data-cat="${c.id}"><i>${c.icon}</i>${c.short}<small>${doneIn(c.id)}/${cnt(c.id)}</small></button>`
    ).join('');
}

/* ───────── 任务列表 ───────── */
function sortTasks(list) {
  const work = isWorkday();
  return list.slice().sort((a, b) => {
    const ad = isDone(a.id), bd = isDone(b.id);
    if (ad !== bd) return ad ? 1 : -1;
    const hot = t => (S.settings.weather === 'sunny' && t.weather === 'outdoor') ||
                     (S.settings.weather === 'rainy' && t.weather === 'indoor') ? 0 : 1;
    const ha = hot(a), hb = hot(b);
    if (ha !== hb) return ha - hb;
    const pr = t => (work ? t.type === 'work' : t.type === 'life') ? 0 : 1;
    const pa = pr(a), pb = pr(b);
    if (pa !== pb) return pa - pb;
    return a.id - b.id;
  });
}

function taskHTML(t) {
  const c = catOf(t.cat);
  const done = isDone(t.id);
  const note = S.day.notes[t.id];
  const hot = (S.settings.weather === 'sunny' && t.weather === 'outdoor') ||
              (S.settings.weather === 'rainy' && t.weather === 'indoor');
  return `<article class="task ${done ? 'done' : ''} ${hot && !done ? 'is-hot' : ''}" data-id="${t.id}" style="--tone:hsl(${c.hue} 42% 66%)">
    <button class="tick" aria-label="${done ? '取消完成' : '完成'}">
      <svg viewBox="0 0 24 24"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>
    </button>
    <div class="task-body">
      <div class="task-text">${esc(t.text)}</div>
      ${t.tip ? `<div class="task-tip">${esc(t.tip)}</div>` : ''}
      <div class="task-meta">
        ${t.mins ? `<span class="tag mins">约 ${t.mins} 分钟</span>` : ''}
        <span class="tag">${t.weather === 'outdoor' ? '🌳 户外' : '🏠 室内'}</span>
        ${t.own ? `<span class="tag own">我加的</span>` : ''}
        ${done ? `<button class="note-btn"><svg viewBox="0 0 24 24" class="ico"><path d="M3 17.2V21h3.8L17.9 9.9l-3.8-3.8L3 17.2zM20.7 7.1a1 1 0 000-1.4l-2.4-2.4a1 1 0 00-1.4 0l-1.8 1.8 3.8 3.8 1.8-1.8z"/></svg>${note ? '改感悟' : '写感悟'}</button>` : ''}
        ${t.own ? '' : `<span class="task-num">#${t.id}</span>`}
      </div>
      ${note ? `<div class="task-note"><b>我的感悟</b>${esc(note)}</div>` : ''}
    </div>
  </article>`;
}

function renderTasks() {
  const wrap = $('#task-list');
  const cats = S.cat === 'all' ? CATEGORIES : CATEGORIES.filter(c => c.id === S.cat);
  let html = '';
  cats.forEach(c => {
    const list = sortTasks(allTasks().filter(t => t.cat === c.id));
    if (!list.length) return;
    const done = list.filter(t => isDone(t.id)).length;
    html += `<section class="cat-block">
      <div class="cat-block-head">
        <img class="cat-thumb" src="art/cat-${c.id}.jpg" alt="" loading="lazy"/>
        <div><h4>${c.name}</h4><p>${c.desc}</p></div>
        <span class="cnt">${done}/${list.length}</span>
      </div>
      ${list.map(taskHTML).join('')}
    </section>`;
  });
  wrap.innerHTML = html || `<div class="empty"><img src="art/empty.jpg" alt=""/><p>这个分类还是空的</p></div>`;

  const left = allTasks().length - S.day.checked.length;
  $('#list-foot').textContent = S.day.checked.length === 0
    ? '往下滑滑看，挑一件顺眼的 ✨'
    : `还有 ${left} 件可以做，不做也没关系 🌿`;
}

/* ───────── 打卡 ───────── */
function toggle(id, el) {
  id = Number(id);
  const t = taskById(id);
  if (!t) return;
  const was = isDone(id);

  if (was) {
    S.day.checked = S.day.checked.filter(x => x !== id);
    S.day.points = Math.max(0, S.day.points - 1);
    S.meta.totalPoints = Math.max(0, S.meta.totalPoints - 1);
  } else {
    S.day.checked.push(id);
    S.day.points += 1;
    S.meta.totalPoints += 1;
    // 特效
    if (el) {
      const r = el.getBoundingClientRect();
      FX.burst(r.left + r.width / 2, r.top + r.height / 2, 18, 1);
      const rip = document.createElement('span');
      rip.className = 'ripple';
      el.closest('.task').appendChild(rip);
      setTimeout(() => rip.remove(), 700);
    }
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch {} }
  }

  persistDay(); persistMeta();
  const card = el && el.closest('.task');
  renderTasks(); renderProgress(); renderCatStrip(); renderMe();

  if (!was) {
    const fresh = $(`.task[data-id="${id}"]`);
    if (fresh) { fresh.classList.add('just-done'); setTimeout(() => fresh.classList.remove('just-done'), 460); }
    checkMilestone();
  }
}

function checkMilestone() {
  const n = S.day.checked.length;
  const fired = store.get('fired:' + S.today, []);
  const ms = MILESTONES.find(m => m.count === n && !fired.includes(m.count));
  if (!ms) return;
  fired.push(ms.count); store.set('fired:' + S.today, fired);
  S.day.points += ms.points; S.meta.totalPoints += ms.points;
  if (!S.meta.badges.includes(ms.count)) S.meta.badges.push(ms.count);
  persistDay(); persistMeta(); renderProgress(); renderMe();

  $('#reward-icon').textContent = ms.icon;
  $('#reward-title').textContent = ms.title;
  $('#reward-desc').textContent = ms.desc;
  $('#reward-points').textContent = ms.points;
  openModal('#modal-reward');
  setTimeout(() => FX.rain(110), 180);
}

/* ───────── 感悟 ───────── */
function openNote(id) {
  S.noteTarget = Number(id);
  const t = taskById(id);
  $('#note-task-title').textContent = t ? t.text : '写点感悟';
  $('#note-input').value = S.day.notes[id] || '';
  openModal('#modal-note');
  setTimeout(() => $('#note-input').focus(), 320);
}
function saveNote() {
  const v = $('#note-input').value.trim();
  if (v) S.day.notes[S.noteTarget] = v;
  else delete S.day.notes[S.noteTarget];
  persistDay();
  closeModal('#modal-note');
  renderTasks();
  toast(v ? '感悟收好了 🌱' : '已清空');
}

/* ───────── 心情记录 ───────── */
function renderMoodRow() {
  const cur = S.journal[S.today];
  const sel = S.mood || (cur && cur.mood);
  $('#mood-row').innerHTML = MOOD_OPTIONS.map(m =>
    `<button class="mood-opt ${sel === m.emoji ? 'is-on' : ''}" data-mood="${m.emoji}">
      <span>${m.emoji}</span><small>${m.label}</small>
    </button>`).join('');
  $('#mood-input').value = (cur && cur.text) || '';
  updateNoteCount();
  renderMediaStrip();
}
function updateNoteCount() { $('#note-count').textContent = $('#mood-input').value.length + ' 字'; }

function renderJournal() {
  const keys = Object.keys(S.journal).sort().reverse();
  $('#journal-count').textContent = keys.length + ' 篇';
  const list = $('#journal-list');
  if (!keys.length) {
    list.innerHTML = `<div class="empty"><img src="art/empty.jpg" alt=""/><p>还没有写过，今天开个头吧～</p></div>`;
    return;
  }
  list.innerHTML = keys.map(k => {
    const j = S.journal[k];
    const d = dayOf(k);
    const notes = Object.entries(d.notes || {});
    const media = j.media || [];
    const dt = parseKey(k);
    return `<article class="jcard" data-date="${k}">
      <button class="jcard-del" aria-label="删除">×</button>
      <div class="jcard-head">
        <span class="jcard-emoji">${j.mood || '😊'}</span>
        <span class="jcard-date">${dt.getMonth() + 1}月${dt.getDate()}日 ${WK[dt.getDay()]}</span>
        <span class="jcard-badge">完成 ${(d.checked || []).length} 件</span>
      </div>
      ${j.text ? `<div class="jcard-text">${esc(j.text)}</div>` : ''}
      ${media.length ? `<div class="mgrid">
        ${media.slice(0, 6).map(m => mediaTile(m, `data-day="${k}"`)).join('')}
        ${media.length > 6 ? `<span class="mgrid-more">+${media.length - 6}</span>` : ''}
      </div>` : ''}
      ${notes.length ? `<div class="jcard-notes">${notes.slice(0, 3).map(([id, tx]) => {
        const t = taskById(id);
        return `<div class="jcard-note"><b>${t ? esc(t.text.slice(0, 12)) + '…' : '小事'}</b>${esc(tx)}</div>`;
      }).join('')}${notes.length > 3 ? `<div class="jcard-note">…还有 ${notes.length - 3} 条感悟</div>` : ''}</div>` : ''}
    </article>`;
  }).join('');
  hydrateMedia(list);
}

function saveMood() {
  const text = $('#mood-input').value.trim();
  const cur = S.journal[S.today] || {};
  const mood = S.mood || cur.mood;
  const media = cur.media || [];
  if (!mood && !text && !media.length) { toast('选个心情，或者写两句、放张照片都行'); return; }
  const first = !cur.mood && !cur.text;
  S.journal[S.today] = { mood: mood || '😊', text, ts: Date.now(), ...(media.length ? { media } : {}) };
  store.set('journal', S.journal);
  if (first) {
    S.day.points += 5; S.meta.totalPoints += 5;
    persistDay(); persistMeta(); renderProgress(); renderMe();
    toast('今天存好了，+5 颗糖 🍬', 2300);
  } else toast('更新好了 💛');
  const r = $('#btn-save-mood').getBoundingClientRect();
  FX.burst(r.left + r.width / 2, r.top, 24, 1.1);
  S.mood = null;
  renderMoodRow(); renderJournal();
}

/* ───────── 语音输入 ───────── */
function initRec() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.lang = 'zh-CN'; r.continuous = false; r.interimResults = true;
  let base = '';
  r.onstart = () => {
    base = $('#mood-input').value;
    $('#btn-voice').classList.add('rec');
    const h = $('#voice-hint'); h.hidden = false; h.textContent = '🎙 在听着呢，慢慢说…';
  };
  r.onresult = e => {
    let tx = '';
    for (let i = 0; i < e.results.length; i++) tx += e.results[i][0].transcript;
    $('#mood-input').value = base + (base && !base.endsWith('\n') ? ' ' : '') + tx;
    updateNoteCount();
  };
  r.onerror = () => { $('#voice-hint').textContent = '没听清，直接打字也行～'; setTimeout(() => { $('#voice-hint').hidden = true; }, 2200); $('#btn-voice').classList.remove('rec'); };
  r.onend = () => { $('#btn-voice').classList.remove('rec'); setTimeout(() => { $('#voice-hint').hidden = true; }, 1400); };
  return r;
}
function toggleVoice() {
  if (!S.rec) { S.rec = initRec(); if (!S.rec) { toast('这个设备不支持语音，打字吧～'); return; } }
  if ($('#btn-voice').classList.contains('rec')) S.rec.stop();
  else { try { S.rec.start(); } catch { toast('稍等一下再试'); } }
}

/* ═══════════════ 照片 / 视频 ═══════════════
   ─────────────────────────────────────────────────────────────────
   原图不上传：照片先在本机压到长边 1600，另外单独存一张 360 的缩略图，
   翻记录的时候只下缩略图，省流量也快。视频没法在浏览器里转码，
   所以只截一帧当封面，并且限制大小。

   两样东西都先落到本机 IndexedDB —— 拍完立刻就能看，没网也不耽误，
   然后由 flush() 一个个加密（AES-GCM，和文字用同一把主密钥）传到 R2。
   服务器全程只见到密文，和它存你的日记是一样的待遇。
   ───────────────────────────────────────────────────────────────── */
const MEDIA = {
  MAX_VID: 25 * 1024 * 1024,      // 视频上限，再大就传不动了
  MAX_PICK: 9,                    // 一次最多选 9 个
  EDGE_FULL: 1600,
  EDGE_THUMB: 360,

  _db: null,
  _inflight: new Map(),
  urls: new Map(),                // id → objectURL
  pend: new Set(),                // 还没传上云的主文件 id
  flushing: false,

  /* ── 本机仓库（IndexedDB）── */
  db() {
    if (this._db) return this._db;
    this._db = new Promise((res, rej) => {
      let rq;
      try { rq = indexedDB.open('happy100-media', 1); }
      catch (e) { rej(e); return; }
      rq.onupgradeneeded = () => {
        const d = rq.result;
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'id' });
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error || new Error('本机相册打不开'));
    });
    return this._db;
  },
  tx(mode, fn) {
    return this.db().then(d => new Promise((res, rej) => {
      const t = d.transaction('blobs', mode);
      let rq;
      try { rq = fn(t.objectStore('blobs')); } catch (e) { rej(e); return; }
      t.oncomplete = () => res(rq ? rq.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    }));
  },
  local(id)    { return this.tx('readonly',  st => st.get(id)); },
  save(rec)    { return this.tx('readwrite', st => st.put(rec)); },
  drop(id)     { return this.tx('readwrite', st => st.delete(id)); },
  allLocal()   { return this.tx('readonly',  st => st.getAll()); },
  clearLocal() { return this.tx('readwrite', st => st.clear()); },

  async init() {
    try {
      (await this.allLocal() || []).forEach(r => {
        if (!r.up && !r.id.endsWith('.t')) this.pend.add(r.id);
      });
    } catch {}
    if (this.pend.size) renderMediaStrip();     // 把「还没传上去」的小沙漏补上
    addEventListener('online', () => this.flush());
  },

  /* ── 挑文件 ── */
  async add(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const over = files.length > this.MAX_PICK;
    const day = S.today;
    let ok = 0;

    toast(files.length > 1 ? `正在处理 ${Math.min(files.length, this.MAX_PICK)} 个文件…` : '正在处理…', 6000);
    for (const f of files.slice(0, this.MAX_PICK)) {
      if (!f || !f.size) continue;
      try {
        const item = await this.prepare(f);
        if (!item) continue;
        this.attach(day, item);
        ok++;
        renderMediaStrip();
      } catch (e) {
        toast(`「${f.name}」没读出来，换一个试试`, 2800);
      }
    }
    if (!ok) return;

    renderMediaStrip();
    if (S.screen === 'journal') renderJournal();
    if (S.screen === 'report') renderReport();

    if (!window.HappySync || !HappySync.on) {
      toast(`存好了 ${ok} 个 📷 目前只在这台设备上，登录账号才会传到云端`, 3600);
    } else {
      toast(`存好了 ${ok} 个 📷 正在传到云端…`, 2400);
      this.flush();
    }
    if (over) toast(`一次最多 ${this.MAX_PICK} 个，剩下的分几次传吧`, 3200);
  },

  /** 压缩 / 截封面，存进本机仓库，返回一条元信息 */
  async prepare(file) {
    const isVid = /^video\//.test(file.type);
    const isImg = /^image\//.test(file.type);
    const isAud = /^audio\//.test(file.type);
    if (!isImg && !isVid && !isAud) { toast('只能放照片、视频和录音哦', 2600); return null; }
    if (!isImg && file.size > this.MAX_VID) {
      toast(`这个有 ${fmtSize(file.size)}，超过 25MB 了，短一点再传～`, 3800);
      return null;
    }

    const id = randHex(16);
    const now = Date.now();
    let main, thumb = null, w = 0, h = 0, dur = 0, mime;

    if (isImg) {
      const full = await shrinkImage(file, this.EDGE_FULL, 0.82);
      main = full.blob; w = full.w; h = full.h; mime = 'image/jpeg';
      const t = await shrinkImage(file, this.EDGE_THUMB, 0.7).catch(() => null);
      if (t) thumb = t.blob;
    } else if (isVid) {
      main = file; mime = file.type || 'video/mp4';
      const p = await videoPoster(file);
      if (p) { thumb = p.blob; w = p.w; h = p.h; dur = p.dur; }
    } else {
      main = file; mime = file.type || 'audio/mpeg';
      dur = await clipDuration(file, 'audio');       // 录音没有封面，列表里用图标顶上
    }

    await this.save({ id, blob: main, up: 0, ts: now });
    if (thumb) await this.save({ id: id + '.t', blob: thumb, up: 0, ts: now });
    this.pend.add(id);

    return {
      id, kind: isVid ? 'video' : isAud ? 'audio' : 'image', mime,
      size: main.size, w, h, dur: Math.round(dur), thumb: !!thumb, ts: now,
    };
  },

  /** 现场录完的一段声音，直接收下（时长按录制计时算，比读文件元数据准） */
  async addRecorded(blob, dur, mime) {
    if (blob.size > this.MAX_VID) { toast('这段录太长了，超过 25MB 存不下', 3400); return; }
    const id = randHex(16);
    const now = Date.now();
    await this.save({ id, blob, up: 0, ts: now });
    this.pend.add(id);
    this.attach(S.today, {
      id, kind: 'audio', mime: mime || blob.type || 'audio/webm',
      size: blob.size, w: 0, h: 0, dur: Math.round(dur), thumb: false, ts: now,
    });
    renderMediaStrip();
    if (S.screen === 'journal') renderJournal();
    if (S.screen === 'report') renderReport();
    if (window.HappySync && HappySync.on) { toast('录好了 🎙 正在传到云端…', 2400); this.flush(); }
    else toast('录好了 🎙 目前只在这台设备上，登录账号才会传到云端', 3600);
  },

  /** 挂到某一天的记录上（没有记录就顺手建一条） */
  attach(day, item) {
    const j = S.journal[day] || { mood: '', text: '' };
    j.media = [...(j.media || []), item];
    j.ts = Date.now();
    S.journal[day] = j;
    store.set('journal', S.journal);
  },

  /* ── 上传 ── */
  async flush() {
    if (this.flushing || !window.HappySync || !HappySync.on) return;
    let list = [];
    try { list = (await this.allLocal() || []).filter(r => !r.up); } catch { return; }
    if (!list.length) return;

    this.flushing = true;
    let done = 0, pushedOnce = false;
    try {
      for (const rec of list) {
        try {
          await HappySync.putMedia(rec.id, rec.blob);
        } catch (e) {
          // 云端还没有这个账号的快照，先推一次再重试一遍
          if (e.code === 'no_account' && !pushedOnce) {
            pushedOnce = true;
            try { await SYNC.push(); await HappySync.putMedia(rec.id, rec.blob); }
            catch { continue; }
          } else {
            if (e.code === 'rate_limit')   { toast('今天传得有点多，剩下的明天接着传', 3400); break; }
            if (e.code === 'global_limit') { toast('今天全站的上传额度用完了，明天再传', 3400); break; }
            if (e.code === 'too_large')    { await this.save({ ...rec, up: 2 }); }
            continue;
          }
        }
        await this.save({ ...rec, up: 1 }).catch(() => {});
        if (!rec.id.endsWith('.t')) { this.pend.delete(rec.id); done++; }
      }
    } finally { this.flushing = false; }

    if (done) {
      renderMediaStrip();
      if (S.screen === 'journal') renderJournal();
      if (S.screen === 'report')  renderReport();
    }
  },

  /* ── 读 ── */
  url(id, mime) {
    if (this.urls.has(id)) return Promise.resolve(this.urls.get(id));
    if (this._inflight.has(id)) return this._inflight.get(id);
    const p = this._load(id, mime).finally(() => this._inflight.delete(id));
    this._inflight.set(id, p);
    return p;
  },
  async _load(id, mime) {
    let blob = null;
    try { const rec = await this.local(id); if (rec && rec.blob) blob = rec.blob; } catch {}
    if (!blob) {
      if (!window.HappySync || !HappySync.on) return null;
      try { const bytes = await HappySync.getMedia(id); if (bytes) blob = new Blob([bytes], { type: mime || 'application/octet-stream' }); }
      catch { return null; }
      if (!blob) return null;
      this.save({ id, blob, up: 1, ts: Date.now() }).catch(() => {});
    }
    const u = URL.createObjectURL(blob);
    this.urls.set(id, u);
    return u;
  },
  forget(id) {
    [id, id + '.t'].forEach(k => {
      const u = this.urls.get(k);
      if (u) { try { URL.revokeObjectURL(u); } catch {} this.urls.delete(k); }
    });
  },

  /* ── 删 ── */
  async purge(id) {
    this.forget(id);
    this.pend.delete(id);
    S.mdel[id] = Date.now();          // 立块碑，同步的时候好告诉别的设备「这个是真删了」
    store.set('mdel', S.mdel);
    await this.drop(id).catch(() => {});
    await this.drop(id + '.t').catch(() => {});
    if (window.HappySync && HappySync.on) HappySync.delMedia(id).catch(() => {});
  },
  async remove(day, id) {
    const j = S.journal[day];
    if (j && j.media) {
      j.media = j.media.filter(m => m.id !== id);
      if (!j.media.length) delete j.media;
      j.ts = Date.now();
      // 这天本来就只有照片，删光了就别留个空卡片
      if (!j.media && !j.mood && !j.text) delete S.journal[day];
      store.set('journal', S.journal);
    }
    await this.purge(id);
  },

  /** 同步回来发现某些东西已经被别的设备删了，本机的副本也清掉 */
  async reap() {
    const tomb = S.mdel || {};
    if (!Object.keys(tomb).length) return;
    let have = [];
    try { have = (await this.allLocal() || []).map(r => r.id); } catch { return; }
    for (const key of have) {
      const base = key.endsWith('.t') ? key.slice(0, -2) : key;
      if (!tomb[base]) continue;
      this.forget(base);
      this.pend.delete(base);
      await this.drop(key).catch(() => {});
    }
  },
  /** 整天删掉时，把那天的照片视频一起带走 */
  async removeDay(day) {
    const j = S.journal[day];
    for (const m of (j && j.media) || []) await this.purge(m.id);
  },
};

/* 图片压缩：EXIF 方向能读就读，读不出来退回普通 <img> */
async function shrinkImage(file, maxEdge, quality) {
  const src = await loadBitmap(file);
  const sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight;
  if (!sw || !sh) throw new Error('这张图读不出尺寸');
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d');
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(src, 0, 0, w, h);
  if (src.close) src.close();
  const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', quality));
  if (!blob) throw new Error('这张图处理不了');
  return { blob, w, h };
}
function loadBitmap(file) {
  if (window.createImageBitmap) {
    return createImageBitmap(file, { imageOrientation: 'from-image' })
      .catch(() => createImageBitmap(file))
      .catch(() => loadViaImg(file));
  }
  return loadViaImg(file);
}
function loadViaImg(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload  = () => { URL.revokeObjectURL(url); res(im); };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('读不出这张图')); };
    im.src = url;
  });
}

/* 视频封面：跳到大约 1/3 处截一帧。截不到就算了，用占位图标 */
function videoPoster(file) {
  return new Promise(resolve => {
    let settled = false;
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata'; v.muted = true; v.playsInline = true;
    v.setAttribute('playsinline', '');

    const finish = r => { if (settled) return; settled = true; try { URL.revokeObjectURL(url); } catch {} resolve(r); };
    const timer = setTimeout(() => finish(null), 8000);

    function draw() {
      clearTimeout(timer);
      try {
        const vw = v.videoWidth, vh = v.videoHeight;
        if (!vw || !vh) return finish(null);
        const scale = Math.min(1, MEDIA.EDGE_THUMB / Math.max(vw, vh));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(vw * scale));
        cv.height = Math.max(1, Math.round(vh * scale));
        cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
        cv.toBlob(b => finish(b ? { blob: b, w: vw, h: vh, dur: v.duration || 0 } : null), 'image/jpeg', 0.78);
      } catch { finish(null); }
    }

    v.onloadeddata = () => {
      const t = Math.min(0.8, (v.duration || 1) / 3);
      if (t > 0.05) { try { v.currentTime = t; return; } catch {} }
      draw();
    };
    v.onseeked = draw;
    v.onerror = () => finish(null);
    v.src = url;
  });
}

/* 读一段音频/视频有多长。读不出来就当 0，不影响存 */
function clipDuration(file, tag) {
  return new Promise(resolve => {
    let settled = false;
    const url = URL.createObjectURL(file);
    const el = document.createElement(tag);
    el.preload = 'metadata';
    const finish = d => { if (settled) return; settled = true; try { URL.revokeObjectURL(url); } catch {} resolve(d); };
    const timer = setTimeout(() => finish(0), 6000);
    el.onloadedmetadata = () => {
      clearTimeout(timer);
      // 有些 webm 元数据里的 duration 是 Infinity，得先拖一下才拿得到真值
      if (el.duration === Infinity) {
        el.currentTime = 1e101;
        el.ontimeupdate = () => { el.ontimeupdate = null; finish(isFinite(el.duration) ? el.duration : 0); };
        setTimeout(() => finish(0), 3000);
      } else finish(isFinite(el.duration) ? el.duration : 0);
    };
    el.onerror = () => { clearTimeout(timer); finish(0); };
    el.src = url;
  });
}

/* ───────── 录一段声音 ─────────
   直接用 MediaRecorder 录，格式挑浏览器支持的（Chrome/Android 给 webm-opus，
   Safari 给 mp4-aac）。时长按秒表算，比事后读元数据可靠。 */
const REC = {
  mr: null, chunks: [], t0: 0, timer: null, stream: null, mime: '',
  MAX_SEC: 300,

  supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  },
  pickMime() {
    const want = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/ogg;codecs=opus'];
    return want.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || '';
  },

  async toggle() {
    if (this.mr) { this.stop(); return; }
    if (!this.supported()) { toast('这个设备/浏览器录不了音，可以用「相册」放一段已有的录音', 3600); return; }

    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) {
      toast(e && e.name === 'NotAllowedError'
        ? '没拿到麦克风权限，去浏览器/系统设置里允许一下'
        : '打不开麦克风，换个方式试试', 3600);
      return;
    }

    this.stream = stream;
    this.mime = this.pickMime();
    this.chunks = [];
    try { this.mr = new MediaRecorder(stream, this.mime ? { mimeType: this.mime } : undefined); }
    catch { this.mr = new MediaRecorder(stream); }

    this.mr.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.mr.onstop = () => this.finish();
    this.mr.start();
    this.t0 = Date.now();
    this.paint();
    this.timer = setInterval(() => {
      this.paint();
      if ((Date.now() - this.t0) / 1000 >= this.MAX_SEC) { toast('录满 5 分钟啦，先存下来', 3000); this.stop(); }
    }, 250);
  },

  stop() { try { this.mr && this.mr.state !== 'inactive' && this.mr.stop(); } catch { this.cleanup(); } },
  cancel() { this.dropped = true; this.stop(); },

  async finish() {
    const secs = (Date.now() - this.t0) / 1000;
    const chunks = this.chunks, mime = this.mime || (chunks[0] && chunks[0].type) || 'audio/webm';
    const dropped = this.dropped;
    this.cleanup();
    if (dropped) { toast('那就不录了 🌿'); return; }
    if (!chunks.length || secs < 0.6) { toast('太短了，没录进去'); return; }
    await MEDIA.addRecorded(new Blob(chunks, { type: mime }), secs, mime);
  },

  cleanup() {
    clearInterval(this.timer); this.timer = null;
    try { (this.stream ? this.stream.getTracks() : []).forEach(t => t.stop()); } catch {}
    this.mr = null; this.stream = null; this.chunks = []; this.dropped = false;
    this.paint();
  },

  paint() {
    const btn = $('#btn-record'), hint = $('#rec-hint'), label = $('#rec-label');
    if (!btn) return;
    if (!this.mr) {
      btn.classList.remove('rec');
      if (label) label.textContent = '录一段';
      if (hint) { hint.hidden = true; hint.innerHTML = ''; }
      return;
    }
    btn.classList.add('rec');
    const secs = Math.floor((Date.now() - this.t0) / 1000);
    if (label) label.textContent = '停下来';
    if (hint) {
      hint.hidden = false;
      hint.innerHTML = `<span class="rec-dot"></span>正在录… <b>${fmtDur(secs)}</b>
        <button class="rec-cancel" id="rec-cancel">不录了</button>`;
      const c = $('#rec-cancel');
      if (c) c.onclick = e => { e.stopPropagation(); REC.cancel(); };
    }
  },
};

/* ── 缩略图小方块（记录卡片、编辑区、报告都用它）── */
const KIND_ICON = { video: '🎬', audio: '🎙', image: '🖼' };

function mediaTile(m, extra = '') {
  const tid   = m.thumb ? m.id + '.t' : m.id;
  const tmime = m.thumb ? 'image/jpeg' : m.mime;
  return `<button class="mtile ${m.kind === 'audio' ? 'is-audio' : ''}" data-mid="${m.id}" ${extra}>
    ${m.thumb ? `<img data-mfill="${tid}" data-mmime="${tmime}" alt="" loading="lazy"/>`
              : `<span class="mtile-icon">${KIND_ICON[m.kind] || '🖼'}</span>`}
    ${m.kind === 'video' ? '<span class="mtile-play">▶</span>' : ''}
    ${m.kind !== 'image' && m.dur ? `<span class="mtile-dur">${fmtDur(m.dur)}</span>` : ''}
    ${MEDIA.pend.has(m.id) ? '<span class="mtile-up" title="还没传到云端">⏳</span>' : ''}
  </button>`;
}

/* 一堆照片/视频/录音的分类计数，报告和邮件都用它说人话 */
function mediaTally(list) {
  const n = { image: 0, video: 0, audio: 0 };
  (list || []).forEach(m => { if (n[m.kind] != null) n[m.kind]++; });
  return n;
}
const tallyText = (n, short = false) => [
  n.image ? n.image + (short ? ' 张' : ' 张照片') : '',
  n.video ? n.video + ' 段视频' : '',
  n.audio ? n.audio + ' 段录音' : '',
].filter(Boolean).join('、');

/** 把刚渲染出来的缩略图逐个填上真正的图（本机没有就去云端解密取） */
function hydrateMedia(root) {
  $$('img[data-mfill]', root || document).forEach(el => {
    if (el.dataset.mdone) return;
    el.dataset.mdone = '1';
    MEDIA.url(el.dataset.mfill, el.dataset.mmime).then(u => {
      if (u) el.src = u;
      else {
        const box = el.closest('.mtile');
        if (box) box.classList.add('m-miss');
      }
    }).catch(() => {});
  });
}

/* ── 编辑区里的那一条 ── */
function renderMediaStrip() {
  const box = $('#media-strip');
  if (!box) return;
  const list = (S.journal[S.today] || {}).media || [];
  box.hidden = !list.length;
  box.innerHTML = list.map(m => `<div class="mslot">
      ${mediaTile(m, `data-day="${S.today}"`)}
      <button class="mslot-del" data-mdel="${m.id}" aria-label="删掉这个">×</button>
    </div>`).join('');
  hydrateMedia(box);
}

/* ── 点开看大图 / 放视频 ── */
function openViewer(day, id) {
  const list = ((S.journal[day] || {}).media) || [];
  const i = list.findIndex(m => m.id === id);
  if (i < 0) return;
  S.viewer = { day, i };
  openModal('#modal-media');
  renderViewer();
}
const closeViewer = () => closeModal('#modal-media');
function renderViewer() {
  const v = S.viewer;
  if (!v) return;
  const list = ((S.journal[v.day] || {}).media) || [];
  if (!list.length) { closeViewer(); return; }

  v.i = Math.max(0, Math.min(v.i, list.length - 1));
  const day = v.day, idx = v.i;          // 存下来，等下取回文件时用它对一下还是不是同一张
  const m = list[idx];
  const d = parseKey(day);
  const bits = [`${d.getMonth() + 1}月${d.getDate()}日`, `${idx + 1}/${list.length}`];
  if (m.size) bits.push(fmtSize(m.size));
  $('#mv-meta').textContent = bits.join(' · ');
  $('#mv-prev').disabled = idx === 0;
  $('#mv-next').disabled = idx === list.length - 1;

  const stage = $('#mv-stage');
  stage.innerHTML = '<div class="mv-note">正在打开…</div>';
  MEDIA.url(m.id, m.mime).then(u => {
    if (!S.viewer || S.viewer.day !== day || S.viewer.i !== idx) return;
    if (!u) {
      stage.innerHTML = `<div class="mv-note">${MEDIA.pend.has(m.id)
        ? '这个还没传上云端，换台设备暂时看不到'
        : '打不开了，可能已经被删掉'}</div>`;
      return;
    }
    stage.innerHTML =
      m.kind === 'video' ? `<video src="${u}" controls playsinline preload="metadata"></video>` :
      m.kind === 'audio' ? `<div class="mv-audio"><span class="mv-audio-ico">🎙</span>
                              <audio src="${u}" controls preload="metadata"></audio></div>` :
      `<img src="${u}" alt=""/>`;
  });
}
async function saveViewerFile() {
  const v = S.viewer; if (!v) return;
  const m = (((S.journal[v.day] || {}).media) || [])[v.i];
  if (!m) return;
  const u = await MEDIA.url(m.id, m.mime);
  if (!u) { toast('这个还取不到，等它传完再试'); return; }
  const ext = m.kind === 'image' ? 'jpg'
            : (String(m.mime).split(';')[0].split('/')[1] || (m.kind === 'video' ? 'mp4' : 'webm'))
                .replace('quicktime', 'mov').replace('mpeg', 'mp3');
  const a = document.createElement('a');
  a.href = u;
  a.download = `幸福小事-${v.day}-${m.id.slice(0, 6)}.${ext}`;
  a.click();
  toast('存下来了 ⬇');
}

/* ═══════════════ 报告 ═══════════════ */
function statsFor(k) {
  const d = dayOf(k);
  const checked = d.checked || [];
  const byCat = {};
  CATEGORIES.forEach(c => byCat[c.id] = 0);
  checked.forEach(id => { const t = taskById(id); if (t) byCat[t.cat] = (byCat[t.cat] || 0) + 1; });
  return { key: k, count: checked.length, points: d.points || 0, notes: d.notes || {}, byCat, checked };
}

function renderDaily() {
  const s = statsFor(S.today);
  const j = S.journal[S.today];
  const d = new Date();
  const maxCat = Math.max(1, ...Object.values(s.byCat));
  const topCat = CATEGORIES.reduce((a, c) => s.byCat[c.id] > (s.byCat[a.id] || 0) ? c : a, CATEGORIES[0]);

  const verdict =
    s.count === 0 ? '今天还没开始也没关系，明天的你会接住今天的你。' :
    s.count < 3   ? `完成了 ${s.count} 件。别小看它，今天你确实往前走了一点。` :
    s.count < 8   ? `${s.count} 件小事，这一天被你好好地过了一遍。` :
    s.count < 15  ? `${s.count} 件！今天的节奏很稳，也别忘了休息。` :
                    `${s.count} 件，今天你把生活抱得很紧，辛苦啦。`;

  const noteList = Object.entries(s.notes);
  const shots = (j && j.media) || [];

  $('#report-body').innerHTML = `
    <div class="report-hero">
      <img src="art/report.jpg" alt=""/>
      <div class="report-hero-mask"></div>
      <div class="report-hero-txt">
        <h3>${d.getMonth() + 1}月${d.getDate()}日 日报</h3>
        <p>${WK[d.getDay()]} · ${isWorkday() ? '忙碌的一天' : '松弛的一天'}</p>
      </div>
    </div>

    <div class="paper-card">
      <div class="big-num"><b>${s.count}</b><span>件小事</span></div>
      <div class="kv-row">
        <div class="kv"><b>${s.points}</b><span>今日糖果</span></div>
        <div class="kv"><b>${j ? j.mood : '—'}</b><span>今日心情</span></div>
        <div class="kv"><b>${noteList.length}</b><span>条感悟</span></div>
      </div>
      <div class="quote-block">${verdict}</div>
    </div>

    ${s.count ? `<div class="paper-card">
      <div class="section-title" style="margin:0 0 12px"><h3>今天做了什么</h3></div>
      ${CATEGORIES.filter(c => s.byCat[c.id]).map(c => `
        <div class="dist-row" style="--tone:hsl(${c.hue} 42% 68%)">
          <img src="art/cat-${c.id}.jpg" alt=""/>
          <span class="dist-name">${c.short}</span>
          <div class="dist-bar"><div class="dist-fill" style="width:${(s.byCat[c.id] / maxCat) * 100}%"></div></div>
          <span class="dist-n">${s.byCat[c.id]}</span>
        </div>`).join('')}
      <div class="quote-block" style="margin-top:14px">今天你最照顾的是「${topCat.name}」这一块 ${topCat.icon}</div>
    </div>` : ''}

    ${noteList.length ? `<div class="paper-card">
      <div class="section-title" style="margin:0 0 12px"><h3>今天的感悟</h3></div>
      ${noteList.map(([id, tx]) => {
        const t = taskById(id);
        return `<div class="note-quote"><b>${t ? esc(t.text) : '小事'}</b>${esc(tx)}</div>`;
      }).join('')}
    </div>` : ''}

    ${j && j.text ? `<div class="paper-card">
      <div class="section-title" style="margin:0 0 12px"><h3>今天的心情</h3></div>
      <div class="jcard-text">${esc(j.text)}</div>
    </div>` : ''}

    ${shots.length ? `<div class="paper-card">
      <div class="section-title" style="margin:0 0 12px"><h3>今天的画面</h3><span class="pill">${shots.length} 个</span></div>
      <div class="mgrid">${shots.map(m => mediaTile(m, `data-day="${S.today}"`)).join('')}</div>
    </div>` : ''}

    <div class="report-actions">
      <button class="ghost-btn" id="rep-copy">📋 复制日报</button>
      <button class="ghost-btn" id="rep-goto-journal">✎ 补一段心情</button>
    </div>`;

  hydrateMedia($('#report-body'));
  $('#rep-copy').onclick = () => copyText(dailyText(s, j, verdict));
  $('#rep-goto-journal').onclick = () => go('journal');
}

function dailyText(s, j, verdict) {
  const d = parseKey(s.key);
  let out = `【${d.getMonth() + 1}月${d.getDate()}日 · 幸福小事日报】\n\n`;
  out += `完成 ${s.count} 件小事，收获 ${s.points} 颗糖\n`;
  if (j) out += `今日心情：${j.mood}\n`;
  out += `\n${verdict}\n`;
  if (s.checked.length) {
    out += `\n— 今天做了 —\n`;
    s.checked.forEach(id => { const t = taskById(id); if (t) out += `· ${t.text}\n`; });
  }
  const nl = Object.entries(s.notes);
  if (nl.length) {
    out += `\n— 感悟 —\n`;
    nl.forEach(([id, tx]) => { const t = taskById(id); out += `· ${t ? t.text : ''}\n  ${tx}\n`; });
  }
  if (j && j.text) out += `\n— 心情随笔 —\n${j.text}\n`;
  const ms = (j && j.media) || [];
  if (ms.length) out += `\n— 今天的画面 —\n${tallyText(mediaTally(ms))}（都存在 App 里）\n`;
  return out;
}

function renderWeekly() {
  const mon = mondayOf();
  const days = Array.from({ length: 7 }, (_, i) => dayKey(addDays(mon, i)));
  const st = days.map(statsFor);
  const total = st.reduce((a, b) => a + b.count, 0);
  const pts = st.reduce((a, b) => a + b.points, 0);
  const active = st.filter(s => s.count > 0).length;
  const avg = active ? Math.round(total / active) : 0;
  const best = st.reduce((a, b, i) => b.count > a.c ? { c: b.count, i } : a, { c: -1, i: -1 });
  const maxBar = Math.max(1, ...st.map(s => s.count));
  const todayIdx = days.indexOf(S.today);

  const byCat = {}; CATEGORIES.forEach(c => byCat[c.id] = 0);
  st.forEach(s => CATEGORIES.forEach(c => byCat[c.id] += s.byCat[c.id] || 0));
  const maxCat = Math.max(1, ...Object.values(byCat));

  const moodCnt = {}; MOOD_OPTIONS.forEach(m => moodCnt[m.emoji] = 0);
  days.forEach(k => { const j = S.journal[k]; if (j && moodCnt[j.mood] != null) moodCnt[j.mood]++; });
  const maxMood = Math.max(1, ...Object.values(moodCnt));

  const allNotes = [];
  days.forEach(k => Object.entries(dayOf(k).notes || {}).forEach(([id, tx]) => allNotes.push({ k, id, tx })));

  const shots = [];
  days.forEach(k => ((S.journal[k] || {}).media || []).forEach(m => shots.push({ k, m })));
  const shotTally = mediaTally(shots.map(s => s.m));

  const summary =
    total === 0 ? '这一周还没有记录。没关系，随时都可以重新开始。' :
    active <= 2 ? `这周活跃了 ${active} 天，一共 ${total} 件。少不代表不好，你只是把力气用在了别处。` :
    active <= 4 ? `这周有 ${active} 天在好好照顾自己，一共 ${total} 件小事。这个节奏刚刚好。` :
                  `这周 ${active} 天都在坚持，累计 ${total} 件！你把这一周过得很有生活感。`;

  const m1 = mondayOf(), m2 = addDays(m1, 6);

  $('#report-body').innerHTML = `
    <div class="report-hero">
      <img src="art/hero.jpg" alt=""/>
      <div class="report-hero-mask"></div>
      <div class="report-hero-txt">
        <h3>本周周报</h3>
        <p>${m1.getMonth() + 1}/${m1.getDate()} — ${m2.getMonth() + 1}/${m2.getDate()}</p>
      </div>
    </div>

    <div class="paper-card">
      <div class="big-num"><b>${total}</b><span>件小事</span></div>
      <div class="kv-row">
        <div class="kv"><b>${active}<small style="font-size:12px;color:var(--ink-3)">/7</small></b><span>活跃天数</span></div>
        <div class="kv"><b>${avg}</b><span>日均完成</span></div>
        <div class="kv"><b>${pts}</b><span>本周糖果</span></div>
      </div>
      <div class="quote-block">${summary}</div>
    </div>

    <div class="paper-card">
      <div class="section-title" style="margin:0 0 18px"><h3>每天的样子</h3></div>
      <div class="bars">
        ${st.map((s, i) => `<div class="bar-col ${i === todayIdx ? 'is-today' : ''}">
          <div class="bar" style="height:${Math.max(5, (s.count / maxBar) * 108)}px">
            ${s.count ? `<span class="bar-n">${s.count}</span>` : ''}
          </div>
          <span class="bar-l">${['一', '二', '三', '四', '五', '六', '日'][i]}</span>
        </div>`).join('')}
      </div>
      ${best.c > 0 ? `<div class="quote-block" style="margin-top:16px">🏆 本周最佳是<b>周${['一', '二', '三', '四', '五', '六', '日'][best.i]}</b>，那天你完成了 ${best.c} 件。</div>` : ''}
    </div>

    ${total ? `<div class="paper-card">
      <div class="section-title" style="margin:0 0 12px"><h3>照顾了哪些方面</h3></div>
      ${CATEGORIES.map(c => `
        <div class="dist-row" style="--tone:hsl(${c.hue} 42% 68%)">
          <img src="art/cat-${c.id}.jpg" alt=""/>
          <span class="dist-name">${c.short}</span>
          <div class="dist-bar"><div class="dist-fill" style="width:${(byCat[c.id] / maxCat) * 100}%"></div></div>
          <span class="dist-n">${byCat[c.id]}</span>
        </div>`).join('')}
    </div>` : ''}

    <div class="paper-card">
      <div class="section-title" style="margin:0 0 14px"><h3>这周的心情</h3></div>
      <div class="mood-bars">
        ${MOOD_OPTIONS.map(m => `<div class="mood-bar">
          <div class="mb-track"><div class="mb-fill" style="height:${(moodCnt[m.emoji] / maxMood) * 100}%;background:hsl(${m.hue} 46% 76%)"></div></div>
          <em>${m.emoji}</em><small>${moodCnt[m.emoji]}</small>
        </div>`).join('')}
      </div>
    </div>

    ${shots.length ? `<div class="paper-card">
      <div class="section-title" style="margin:0 0 12px"><h3>本周的画面</h3>
        <span class="pill">${tallyText(shotTally, true)}</span>
      </div>
      <div class="mgrid">
        ${shots.slice(-12).map(s => mediaTile(s.m, `data-day="${s.k}"`)).join('')}
        ${shots.length > 12 ? `<span class="mgrid-more">+${shots.length - 12}</span>` : ''}
      </div>
    </div>` : ''}

    ${allNotes.length ? `<div class="paper-card">
      <div class="section-title" style="margin:0 0 12px"><h3>本周感悟集</h3><span class="pill">${allNotes.length} 条</span></div>
      ${allNotes.slice(-8).reverse().map(n => {
        const t = taskById(n.id); const dd = parseKey(n.k);
        return `<div class="note-quote"><b>${dd.getMonth() + 1}/${dd.getDate()} · ${t ? esc(t.text) : '小事'}</b>${esc(n.tx)}</div>`;
      }).join('')}
    </div>` : ''}

    <div class="report-actions">
      <button class="ghost-btn" id="rep-copy-w">📋 复制周报</button>
      <button class="ghost-btn" id="rep-mail-w">📮 发到我邮箱</button>
    </div>`;

  hydrateMedia($('#report-body'));

  $('#rep-mail-w').onclick = async () => {
    const b = $('#rep-mail-w'); const old = b.textContent;
    b.disabled = true; b.textContent = '发送中…';
    await mailWeekly(mondayOf());
    b.disabled = false; b.textContent = old;
  };

  $('#rep-copy-w').onclick = () => {
    let out = `【幸福小事 · 本周周报】\n${m1.getMonth() + 1}/${m1.getDate()} — ${m2.getMonth() + 1}/${m2.getDate()}\n\n`;
    out += `共完成 ${total} 件小事，活跃 ${active}/7 天，日均 ${avg} 件，收获 ${pts} 颗糖\n\n${summary}\n`;
    out += `\n— 每日 —\n${st.map((s, i) => `周${['一', '二', '三', '四', '五', '六', '日'][i]}：${s.count} 件`).join('\n')}\n`;
    if (shots.length) out += `\n— 本周的画面 —\n${tallyText(shotTally)}\n`;
    if (allNotes.length) {
      out += `\n— 本周感悟 —\n`;
      allNotes.forEach(n => { const t = taskById(n.id); const dd = parseKey(n.k); out += `· ${dd.getMonth() + 1}/${dd.getDate()} ${t ? t.text : ''}\n  ${n.tx}\n`; });
    }
    copyText(out);
  };
}

/* ───────── 周报文字版（发邮件 / 复制都用它） ───────── */
function weeklyReportText(monday) {
  const days = Array.from({ length: 7 }, (_, i) => dayKey(addDays(monday, i)));
  const st = days.map(statsFor);
  const total = st.reduce((a, b) => a + b.count, 0);
  const pts = st.reduce((a, b) => a + b.points, 0);
  const active = st.filter(s => s.count > 0).length;
  const avg = active ? Math.round(total / active) : 0;
  const best = st.reduce((a, b, i) => b.count > a.c ? { c: b.count, i } : a, { c: -1, i: -1 });
  const WN = ['一', '二', '三', '四', '五', '六', '日'];
  const m2 = addDays(monday, 6);

  const byCat = {}; CATEGORIES.forEach(c => byCat[c.id] = 0);
  st.forEach(s => CATEGORIES.forEach(c => byCat[c.id] += s.byCat[c.id] || 0));

  const notes = [];
  days.forEach(k => Object.entries(dayOf(k).notes || {}).forEach(([id, tx]) => notes.push({ k, id, tx })));

  const moods = days.map(k => S.journal[k]).filter(Boolean);

  const summary =
    total === 0 ? '这一周没有记录。没关系，随时都可以重新开始。' :
    active <= 2 ? `这周活跃了 ${active} 天，一共 ${total} 件。少不代表不好，你只是把力气用在了别处。` :
    active <= 4 ? `这周有 ${active} 天在好好照顾自己，一共 ${total} 件小事。这个节奏刚刚好。` :
                  `这周 ${active} 天都在坚持，累计 ${total} 件！你把这一周过得很有生活感。`;

  let out = `幸福小事 · 周报\n${monday.getMonth() + 1}月${monday.getDate()}日 — ${m2.getMonth() + 1}月${m2.getDate()}日\n`;
  out += `${'─'.repeat(28)}\n\n`;
  out += `完成 ${total} 件小事，活跃 ${active}/7 天，日均 ${avg} 件，收获 ${pts} 颗糖\n\n${summary}\n\n`;

  out += `【每天的样子】\n`;
  st.forEach((s, i) => {
    const bar = '▇'.repeat(Math.min(20, s.count)) || '·';
    out += `  周${WN[i]}  ${String(s.count).padStart(2)} 件  ${bar}\n`;
  });
  if (best.c > 0) out += `\n  本周最佳：周${WN[best.i]}，完成了 ${best.c} 件。\n`;

  const catLines = CATEGORIES.filter(c => byCat[c.id] > 0);
  if (catLines.length) {
    out += `\n【照顾了哪些方面】\n`;
    catLines.forEach(c => { out += `  ${c.icon} ${c.name}　${byCat[c.id]} 次\n`; });
  }

  if (moods.length) {
    out += `\n【这周的心情】\n`;
    days.forEach(k => {
      const j = S.journal[k];
      if (!j) return;
      const d = parseKey(k);
      out += `  ${d.getMonth() + 1}/${d.getDate()} ${j.mood}${j.text ? '　' + j.text : ''}\n`;
    });
  }

  if (notes.length) {
    out += `\n【本周感悟】\n`;
    notes.forEach(n => {
      const t = taskById(n.id); const d = parseKey(n.k);
      out += `  ${d.getMonth() + 1}/${d.getDate()}　${t ? t.text : '小事'}\n      ${n.tx}\n`;
    });
  }

  // 照片和视频本身是加密的，服务器解不开，也就没法塞进邮件 —— 只报个数，人回 App 里看
  const shots = [];
  days.forEach(k => ((S.journal[k] || {}).media || []).forEach(m => shots.push({ k, m })));
  if (shots.length) {
    out += `\n【本周的画面】\n`;
    out += `  这周留下了 ${tallyText(mediaTally(shots.map(s => s.m)))}\n`;
    days.forEach(k => {
      const ms = (S.journal[k] || {}).media || [];
      if (!ms.length) return;
      const d = parseKey(k);
      out += `  ${d.getMonth() + 1}/${d.getDate()}　${tallyText(mediaTally(ms))}\n`;
    });
    out += `  它们是加密存着的，邮件里放不了，打开 App 就能翻。\n`;
  }

  out += `\n${'─'.repeat(28)}\n下周也慢慢来，不用赶。\nhttps://happy.llmwiki.cloud\n`;
  // hasAny：这一周到底有没有东西可报（打卡、心情、照片都算）
  return { text: out, total, hasAny: total + shots.length + moods.length > 0, monday: dayKey(monday) };
}

/* ───────── 周报发到邮箱 ───────── */
async function mailWeekly(monday, opts = {}) {
  if (!window.HappySync || !HappySync.on || !HappySync.dataId) {
    if (!opts.silent) toast('先注册或登录账号才能发邮件');
    return false;
  }
  const to = (S.settings.mailTo || HappySync.email || '').trim();
  if (!to) { if (!opts.silent) toast('还没有可发送的邮箱地址'); return false; }

  const rep = weeklyReportText(monday);
  if (!rep.hasAny && opts.silent) return false;      // 空白的一周就不打扰了

  const m2 = addDays(monday, 6);
  const subject = `幸福小事 · ${monday.getMonth() + 1}/${monday.getDate()}-${m2.getMonth() + 1}/${m2.getDate()} 周报`;

  try {
    const r = await fetch(HappySync.apiBase + '/api/mail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataId: HappySync.dataId, to, subject, text: rep.text }),
    });
    const j = await r.json();
    if (!j.ok) {
      const msg = { rate_limit: '今天发得有点多，明天再试', global_limit: '今天全站发信额度用完了',
                    no_account: '云端还没有你的数据，先同步一次', smtp_failed: '发信失败：' + (j.detail || '') }[j.error]
                || ('发送失败：' + (j.error || ''));
      if (!opts.silent) toast(msg, 3200);
      return false;
    }
    store.setQuiet('mailedWeek:' + rep.monday, Date.now());
    if (!opts.silent) toast('周报已发到 ' + to + ' 📮', 2600);
    return true;
  } catch (e) {
    if (!opts.silent) toast('发送失败：' + (e.message || '网络问题'));
    return false;
  }
}

/* 每周自动补发上一周的周报（开了开关、且这周还没发过） */
async function autoWeeklyMail() {
  if (!S.settings.weeklyMail) return;
  if (!window.HappySync || !HappySync.on) return;
  const lastMon = addDays(mondayOf(), -7);
  const key = dayKey(lastMon);
  if (store.get('mailedWeek:' + key, null)) return;
  const ok = await mailWeekly(lastMon, { silent: true });
  if (ok) toast('上周的周报已经发到你邮箱了 📮', 3000);
}

function copyText(t) {
  const done = () => toast('已复制，去粘贴吧 📋');
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(t).then(done).catch(() => fallback());
  } else fallback();
  function fallback() {
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch { toast('复制失败，长按选中试试'); }
    ta.remove();
  }
}

function renderReport() {
  const seg = $('#seg-report');
  seg.dataset.i = S.repTab === 'daily' ? '0' : '1';
  $$('#seg-report .seg-btn').forEach(b => b.classList.toggle('is-on', b.dataset.rep === S.repTab));
  if (S.repTab === 'daily') renderDaily(); else renderWeekly();
}

/* ═══════════════ 我的 ═══════════════ */
function renderMe() {
  const days = store.keys().filter(k => k.startsWith(P + 'day:'));
  let totalTasks = 0, activeDays = 0;
  days.forEach(k => {
    try {
      const d = JSON.parse(localStorage.getItem(k));
      const n = (d.checked || []).length;
      totalTasks += n; if (n > 0) activeDays++;
    } catch {}
  });
  $('#st-days').textContent = activeDays;
  $('#st-tasks').textContent = totalTasks;
  $('#st-streak').textContent = S.meta.streak.days;
  $('#st-points').textContent = S.meta.totalPoints;

  // 自定义小事
  const slots = TARGET_TOTAL - BUILTIN_COUNT;
  const left = Math.max(0, slots - S.custom.length);
  $('#slot-left').textContent = left;
  const cl = $('#custom-list');
  cl.innerHTML = S.custom.map(t => `<div class="cust" data-id="${t.id}">
      <span class="cust-txt">${esc(t.text)}</span>
      <span class="cust-cat">${catOf(t.cat).short}</span>
      <button class="cust-del" aria-label="删除">×</button>
    </div>`).join('') +
    (left > 0 ? `<div class="slot">+ 还有 ${left} 个空位等着你</div>` : '');

  // 徽章
  $('#badge-wall').innerHTML = MILESTONES.map(m =>
    `<div class="badge ${S.meta.badges.includes(m.count) ? 'got' : ''}">
      <em>${m.icon}</em><small>${m.title}</small>
    </div>`).join('');

  renderUserCard();
  renderSync();
}

function addCustom() {
  const text = $('#custom-text').value.trim();
  if (!text) { toast('写点什么吧～'); return; }
  if (S.custom.length >= TARGET_TOTAL - BUILTIN_COUNT) { toast('12 个位置都满啦'); return; }
  const id = 1000 + (S.custom.reduce((a, t) => Math.max(a, t.id - 1000), 0) + 1);
  S.custom.push({ id, cat: S.customCat, text, type: 'life', weather: 'indoor', mins: null, own: true });
  store.set('custom', S.custom);
  $('#custom-text').value = '';
  closeModal('#modal-custom');
  renderMe(); renderTasks(); renderCatStrip(); renderProgress();
  toast('加好啦，去今天看看 🌟');
  const r = $('#btn-add-custom').getBoundingClientRect();
  FX.burst(r.left + r.width / 2, r.top, 20, 1);
}

function delCustom(id) {
  id = Number(id);
  if (!confirm('要删掉这件小事吗？')) return;
  S.custom = S.custom.filter(t => t.id !== id);
  S.day.checked = S.day.checked.filter(x => x !== id);
  delete S.day.notes[id];
  store.set('custom', S.custom); persistDay();
  renderMe(); renderTasks(); renderCatStrip(); renderProgress();
}

/* ───────── 设置 ───────── */
function openSettings() {
  $('#wd-row').innerHTML = [1, 2, 3, 4, 5, 6, 0].map(d =>
    `<button class="wd ${S.settings.workdays.includes(d) ? 'is-on' : ''}" data-wd="${d}">${WK[d][1]}</button>`).join('');
  $('#remind-time').value = S.settings.remindTime;
  $('#remind-on').checked = !!S.settings.remindOn;
  $('#fx-on').checked = S.settings.fxOn !== false;
  $('#weekly-mail').checked = !!S.settings.weeklyMail;
  $('#mail-to').value = S.settings.mailTo || (window.HappySync && HappySync.email) || '';
  openModal('#modal-settings');
}
function saveSettings() {
  S.settings.workdays = $$('#wd-row .wd.is-on').map(b => Number(b.dataset.wd));
  S.settings.remindTime = $('#remind-time').value || '20:30';
  S.settings.fxOn = $('#fx-on').checked;
  S.settings.weeklyMail = $('#weekly-mail').checked;
  S.settings.mailTo = ($('#mail-to').value || '').trim();
  if (S.settings.weeklyMail && !S.settings.mailTo && window.HappySync && HappySync.email) {
    S.settings.mailTo = HappySync.email;
  }
  const wantRemind = $('#remind-on').checked;
  persistSettings();
  closeModal('#modal-settings');
  renderModeUI(); renderTasks();

  if (wantRemind && !S.settings.remindOn) {
    if ('Notification' in window) {
      Notification.requestPermission().then(p => {
        S.settings.remindOn = p === 'granted';
        persistSettings();
        scheduleRemind();
        toast(p === 'granted' ? '提醒开好了 🔔' : '没拿到通知权限，可以去系统设置里开');
      });
    } else { toast('这个环境不支持通知'); }
  } else {
    S.settings.remindOn = wantRemind;
    persistSettings();
    scheduleRemind();
    toast('保存好了 ✅');
  }
}

let remindTimer;
function scheduleRemind() {
  clearTimeout(remindTimer);
  if (!S.settings.remindOn || !('Notification' in window) || Notification.permission !== 'granted') return;
  const [h, m] = S.settings.remindTime.split(':').map(Number);
  const now = new Date();
  const t = new Date(now); t.setHours(h, m, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  remindTimer = setTimeout(() => {
    try {
      new Notification('幸福小事', { body: '今天有做点让自己开心的小事吗？🌿', icon: 'art/icon-192.png' });
    } catch {}
    scheduleRemind();
  }, t - now);
}

/* ───────── 数据导入导出 ───────── */
function exportData() {
  const dump = { app: 'happy100', version: 2, exportedAt: new Date().toISOString(), data: {} };
  store.keys().forEach(k => { dump.data[k.slice(P.length)] = JSON.parse(localStorage.getItem(k)); });
  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `幸福小事-备份-${S.today}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  toast('导出好啦 📤 照片和视频太大没放进去，它们在云端', 3200);
}
function importData(file) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const j = JSON.parse(fr.result);
      if (j.app !== 'happy100' || !j.data) throw 0;
      if (!confirm('导入会覆盖当前的记录，确定吗？')) return;
      Object.entries(j.data).forEach(([k, v]) => store.set(k, v));
      toast('导入成功，正在刷新…');
      setTimeout(() => location.reload(), 900);
    } catch { toast('这个文件读不出来，换一个试试'); }
  };
  fr.readAsText(file);
}
async function clearAll() {
  if (!confirm('⚠️ 会清空所有打卡、心情、感悟、照片视频和糖果，无法恢复。确定吗？')) return;
  if (!confirm('真的确定？建议先导出备份。')) return;
  if (window.HappySync && HappySync.on) {
    if (confirm('云端那份也一起删掉吗？\n\n选「确定」= 云端也清空（照片和视频一起）。\n选「取消」= 只清这台设备，云端保留（下次登录还能拉回来）。')) {
      try { await HappySync.wipeRemote(); } catch {}
    }
  }
  try { await MEDIA.clearLocal(); } catch {}
  store.keys().forEach(k => localStorage.removeItem(k));
  location.reload();
}

/* ═══════════════ 云同步 ═══════════════ */
const SYNC = {
  ready: false, timer: null, busy: false, state: 'off', note: '',

  /* 任何一次数据写入都会走到这里，攒 2.5 秒再上传 */
  touch() {
    if (!this.ready || !window.HappySync || !HappySync.on) return;
    clearTimeout(this.timer);
    this.setState('pending');
    this.timer = setTimeout(() => this.push(), 2500);
  },

  setState(s, note = '') {
    this.state = s; this.note = note;
    const el = $('#sync-status');
    if (!el) return;
    const map = {
      off:     ['未开启', ''],
      pending: ['有改动待上传', 'warn'],
      syncing: ['同步中…', 'warn'],
      ok:      ['已同步', 'ok'],
      err:     ['同步失败', 'err'],
    };
    const [txt, cls] = map[s] || map.off;
    el.textContent = note ? `${txt} · ${note}` : txt;
    el.className = 'pill ' + (cls ? 'pill-' + cls : '');
  },

  /* 把本机所有会同步的数据打成一份快照 */
  snapshot() {
    const days = {}, fired = {};
    store.keys().forEach(k => {
      const short = k.slice(P.length);
      let v; try { v = JSON.parse(localStorage.getItem(k)); } catch { return; }
      if (short.startsWith('day:')) days[short.slice(4)] = v;
      else if (short.startsWith('fired:')) fired[short.slice(6)] = v;
    });
    return {
      v: 2, ts: Date.now(), days, fired,
      journal:  store.get('journal', {}),
      mdel:     store.get('mdel', {}),
      custom:   store.get('custom', []),
      meta:     store.get('meta', {}),
      settings: store.get('settings', {}),
      profile:  store.get('profile', {}),
    };
  },

  /* 合并两份快照。原则：宁可多留，不可弄丢 —— 感悟和心情永远合并，不覆盖 */
  merge(L, R) {
    if (!R) return L;
    const out = { v: 2, ts: Date.now(), days: {}, fired: {}, journal: {}, mdel: {}, custom: [], meta: {}, settings: {} };

    // 删掉的照片视频先立好碑，半年后自动清理掉这些记号
    const cut = Date.now() - 180 * 864e5;
    Object.entries({ ...(R.mdel || {}), ...(L.mdel || {}) }).forEach(([id, ts]) => {
      if (Number(ts) > cut) out.mdel[id] = Number(ts);
    });

    // 每天的打卡
    new Set([...Object.keys(L.days || {}), ...Object.keys(R.days || {})]).forEach(k => {
      const a = (L.days || {})[k], b = (R.days || {})[k];
      if (!a || !b) { out.days[k] = a || b; return; }
      const at = a.ts || 0, bt = b.ts || 0;
      const decided = at && bt && at !== bt;
      const base = decided ? (at > bt ? a : b) : null;
      out.days[k] = {
        checked: base ? (base.checked || [])
                      : [...new Set([...(a.checked || []), ...(b.checked || [])])],
        points:  base ? (base.points || 0) : Math.max(a.points || 0, b.points || 0),
        notes:   { ...(b.notes || {}), ...(a.notes || {}) },   // 感悟合并，本机优先
        ts: Math.max(at, bt),
      };
    });

    // 已触发过的里程碑：取并集，避免换设备后重复弹窗
    new Set([...Object.keys(L.fired || {}), ...Object.keys(R.fired || {})]).forEach(k => {
      out.fired[k] = [...new Set([...((L.fired || {})[k] || []), ...((R.fired || {})[k] || [])])];
    });

    // 心情随笔：文字取时间戳新的那份；照片视频两边合并，谁也别弄丢
    new Set([...Object.keys(L.journal || {}), ...Object.keys(R.journal || {})]).forEach(k => {
      const a = (L.journal || {})[k], b = (R.journal || {})[k];
      if (!a || !b) { out.journal[k] = a || b; return; }
      const win = (a.ts || 0) >= (b.ts || 0) ? a : b;
      const mm = new Map();
      [...(b.media || []), ...(a.media || [])].forEach(m => { if (m && m.id) mm.set(m.id, m); });
      out.journal[k] = mm.size
        ? { ...win, media: [...mm.values()].sort((x, y) => (x.ts || 0) - (y.ts || 0)) }
        : win;
    });

    // 已经立过碑的，谁也别想合回来
    Object.keys(out.journal).forEach(k => {
      const j = out.journal[k];
      if (!j || !j.media) return;
      const keep = j.media.filter(m => !out.mdel[m.id]);
      if (keep.length === j.media.length) return;
      const next = { ...j };
      if (keep.length) next.media = keep; else delete next.media;
      if (!next.media && !next.mood && !next.text) delete out.journal[k];
      else out.journal[k] = next;
    });

    // 自己加的小事：按 id 取并集，本机优先
    const cm = new Map();
    (R.custom || []).forEach(t => cm.set(t.id, t));
    (L.custom || []).forEach(t => cm.set(t.id, t));
    out.custom = [...cm.values()].sort((x, y) => x.id - y.id);

    // 徽章并集、连续天数取大的、糖果按合并后的每日重算
    const lm = L.meta || {}, rm = R.meta || {};
    out.meta = {
      badges: [...new Set([...(lm.badges || []), ...(rm.badges || [])])].sort((a, b) => a - b),
      streak: ((lm.streak || {}).days || 0) >= ((rm.streak || {}).days || 0)
                ? (lm.streak || { days: 0, last: null }) : rm.streak,
      totalPoints: Object.values(out.days).reduce((s, d) => s + (d.points || 0), 0),
    };

    // 设置和个人资料：时间戳新的说了算
    out.settings = ((L.settings || {}).ts || 0) >= ((R.settings || {}).ts || 0)
      ? (L.settings || {}) : (R.settings || {});
    out.profile = ((L.profile || {}).ts || 0) >= ((R.profile || {}).ts || 0)
      ? (L.profile || {}) : (R.profile || {});

    return out;
  },

  applySnapshot(s) {
    store.keys().forEach(k => {
      const short = k.slice(P.length);
      if (short.startsWith('day:') || short.startsWith('fired:')) localStorage.removeItem(k);
    });
    Object.entries(s.days  || {}).forEach(([k, v]) => store.setQuiet('day:' + k, v));
    Object.entries(s.fired || {}).forEach(([k, v]) => store.setQuiet('fired:' + k, v));
    store.setQuiet('journal',  s.journal  || {});
    store.setQuiet('mdel',     s.mdel     || {});
    store.setQuiet('custom',   s.custom   || []);
    store.setQuiet('meta',     s.meta     || {});
    store.setQuiet('settings', s.settings || {});
    store.setQuiet('profile',  s.profile  || {});
  },

  async boot() {
    await MEDIA.init();
    if (!window.HappySync) { this.ready = true; return; }
    let on = false;
    try { on = await HappySync.boot(); } catch {}
    this.ready = true;
    renderSync();
    if (on) { await this.pullMerge(); autoWeeklyMail(); }
    else this.setState('off');
  },

  async pullMerge(loud = false) {
    if (!window.HappySync || !HappySync.on || this.busy) return;
    this.busy = true; this.setState('syncing');
    try {
      const remote = await HappySync.pull();
      const merged = this.merge(this.snapshot(), remote);
      this.applySnapshot(merged);
      reloadState();
      await HappySync.push(merged);
      store.setQuiet('lastSync', Date.now());
      this.setState('ok');
      renderUserCard();
      if (loud) toast(remote ? '已经和云端对上了 ☁️' : '已上传到云端 ☁️');
    } catch (e) {
      this.setState('err', e.message || '');
      if (loud) toast('同步没成功：' + (e.message || '网络问题'));
    } finally { this.busy = false; renderSync(); MEDIA.flush(); }
  },

  async push() {
    if (!window.HappySync || !HappySync.on || this.busy) return;
    this.busy = true; this.setState('syncing');
    try {
      await HappySync.push(this.snapshot());
      store.setQuiet('lastSync', Date.now());
      this.setState('ok');
      if (S.screen === 'me') renderUserCard();
    } catch (e) { this.setState('err', e.message || ''); }
    finally { this.busy = false; }
  },
};

/* 同步合并之后，把状态重新读进来并整页重绘 */
function reloadState() {
  const def = { workdays: [1, 2, 3, 4, 5], weather: 'sunny', override: null, remindTime: '20:30', remindOn: false, fxOn: true };
  S.settings = Object.assign({}, def, store.get('settings', {}));
  S.journal  = store.get('journal', {});
  S.mdel     = store.get('mdel', {});
  S.custom   = store.get('custom', []);
  MEDIA.reap();
  S.meta     = Object.assign({ totalPoints: 0, streak: { days: 0, last: null }, badges: [] }, store.get('meta', {}));
  S.profile  = Object.assign({ nick: '', avatar: '🌻', ts: 0 }, store.get('profile', {}));
  S.day      = dayOf(S.today);
  if (!S.day.notes) S.day.notes = {};
  renderHeader(); renderCatStrip(); renderTasks(); renderProgress();
  renderModeUI(); renderMoodRow(); renderMe();
  if (S.screen === 'journal') renderJournal();
  if (S.screen === 'report')  renderReport();
}

/* ───────── 用户中心 ───────── */
const AVATARS = ['🌻', '🌿', '🐱', '🐰', '🍰', '☕️', '🌙', '⭐️', '🍋', '🐣', '🧸', '🌈'];

function relTime(ts) {
  if (!ts) return '';
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 60) return '刚刚';
  if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
  if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
  return Math.floor(d / 86400) + ' 天前';
}

function renderUserCard() {
  const box = $('#user-card');
  if (!box) return;
  const on = window.HappySync && HappySync.on;
  const nick = S.profile.nick || (on ? (HappySync.email || '').split('@')[0] : '');
  const av = S.profile.avatar || '🌻';

  if (!on) {
    box.innerHTML = `
      <div class="uc-main">
        <div class="uc-avatar guest">${av}</div>
        <div class="uc-info">
          <b>还没登录</b>
          <span>注册一个账号，数据就能跨设备了</span>
        </div>
      </div>
      <div class="uc-actions">
        <button class="primary-btn" id="uc-register">注册</button>
        <button class="ghost-btn" id="uc-login">登录</button>
      </div>`;
    $('#uc-register').onclick = () => openAuth('register');
    $('#uc-login').onclick = () => openAuth('login');
    return;
  }

  const last = store.get('lastSync', 0);
  const stateTxt = { ok: '已同步', syncing: '同步中…', pending: '待上传', err: '同步失败' }[SYNC.state] || '已连接';
  const dotCls = SYNC.state === 'err' ? 'bad' : (SYNC.state === 'syncing' || SYNC.state === 'pending') ? 'busy' : '';
  box.innerHTML = `
    <button class="uc-main" id="uc-open">
      <div class="uc-avatar">${av}<i class="uc-dot ${dotCls}"></i></div>
      <div class="uc-info">
        <b>${esc(nick || '起个名字吧')}</b>
        <span>${esc(HappySync.email || '同步码模式')}</span>
        <span class="uc-sync ${SYNC.state === 'err' ? 'bad' : ''}">
          ☁️ ${stateTxt}${last ? ' · ' + relTime(last) : ''}
        </span>
      </div>
      <i class="uc-arrow">›</i>
    </button>`;
  $('#uc-open').onclick = () => openAuth('manage');
}

function renderManage() {
  if (!window.HappySync || !HappySync.on) return;
  const nick = S.profile.nick || '';
  const av = S.profile.avatar || '🌻';
  $('#mgr-avatar').textContent = av;
  $('#mgr-nick').textContent = nick || '还没起名字';
  $('#mgr-email').textContent = HappySync.email || '同步码模式';
  const c = HappySync.createdAt;
  $('#mgr-since').textContent = c ? `${new Date(c).getFullYear()}年${new Date(c).getMonth() + 1}月加入` : '';
  $('#mgr-nick-input').value = nick;
  $('#avatar-pick').innerHTML = AVATARS.map(a =>
    `<button data-av="${a}" class="${a === av ? 'is-on' : ''}">${a}</button>`).join('');
}

function saveProfile() {
  S.profile.nick = ($('#mgr-nick-input').value || '').trim();
  S.profile.ts = Date.now();
  store.set('profile', S.profile);
  renderManage(); renderUserCard();
  toast('资料保存好了 🌻');
}

/* ───────── 同步卡片 UI ───────── */
function renderSync() {
  const box = $('#sync-card');
  if (!box) return;
  const on = window.HappySync && HappySync.on;

  if (!on) {
    box.innerHTML = `
      <p class="sync-intro">登录之后，打卡记录、心情和感悟会存一份到云端。
        换手机、清了浏览器数据都能拿回来，<b>下次打开自动登录</b>，不用反复输密码。<br>
        数据在你设备上<b>加密之后才上传</b>，云端存的是密文——我们看不到你写了什么。</p>`;
    return;
  }

  const last = store.get('lastSync', 0);
  box.innerHTML = `
    <p class="sync-intro">改动后过两秒自动上传，每次打开或从后台切回来自动拉取。
      同一个账号在几台设备上会自动合并，<b>感悟永远不会被覆盖掉</b>。</p>
    <div class="kv-row" style="margin-bottom:12px">
      <div class="kv"><b>${last ? relTime(last) : '—'}</b><span>上次同步</span></div>
      <div class="kv"><b>${Object.keys(S.journal).length}</b><span>心情记录</span></div>
      <div class="kv"><b>${S.custom.length}</b><span>自定义小事</span></div>
    </div>
    <div class="sync-actions">
      <button class="ghost-btn" id="sync-now">🔄 立即同步</button>
      <button class="ghost-btn" id="acct-manage">⚙️ 账号管理</button>
    </div>`;

  $('#sync-now').onclick = () => SYNC.pullMerge(true);
  $('#acct-manage').onclick = () => openAuth('manage');
}

/* ───────── 账号弹窗 ───────── */
let pendingRecovery = null;

/* 每个视图的标题、副标题、返回去向 */
const AUTH_META = {
  login:    { t: '欢迎回来', s: '登录之后，写下的每件小事都跟着你走' },
  register: { t: '开一个小窝', s: '一个邮箱、一个密码，几台设备自己对上' },
  recover:  { t: '用恢复码进去', s: '密码忘了没关系，恢复码也能开同一个盒子', back: 'login' },
  setpass:  { t: '设一个新密码', s: '身份已经验过了，数据都在' },
  showcode: { t: '把这串码收好', s: '它是你忘记密码时唯一的进门方式' },
  manage:   { t: '我的账号', s: '资料、安全和这台设备的同步都在这儿' },
  chemail:  { t: '更换邮箱', s: '换成一个你更常用的', back: 'manage' },
  delacct:  { t: '注销账号', s: '这一步没有后悔药', back: 'manage' },
};

function authView(name) {
  const meta = AUTH_META[name] || AUTH_META.login;
  $$('#modal-auth .auth-view').forEach(v => { v.hidden = v.dataset.view !== name; });
  $$('#modal-auth .auth-err').forEach(e => { e.hidden = true; });
  $$('#modal-auth .f-field').forEach(f => f.classList.remove('bad'));

  $('#auth-title').textContent = meta.t;
  $('#auth-tag').textContent = meta.s;

  // 登录/注册才显示切换条
  const isTab = name === 'login' || name === 'register';
  const seg = $('#auth-seg');
  seg.hidden = !isTab;
  seg.dataset.i = name === 'register' ? '1' : '0';
  $$('#auth-seg .auth-seg-btn').forEach(b =>
    b.classList.toggle('is-on', b.dataset.goto === name));

  // 有上级的视图给个返回箭头
  const back = $('#auth-back');
  back.hidden = !meta.back;
  back.dataset.to = meta.back || '';

  const shell = $('.auth-shell');
  if (shell) shell.scrollTop = 0;
}

function openAuth(view) {
  authView(view);
  if (view === 'setpass' && HappySync.email) $('#auth-sp-email').value = HappySync.email;
  if (view === 'manage') renderManage();
  openModal('#modal-auth');
  setTimeout(() => {
    const first = $(`#modal-auth .auth-view[data-view="${view}"] input:not([type=checkbox])`);
    if (first && !matchMedia('(hover: none)').matches) first.focus();
  }, 360);
}

function authErr(id, msg) {
  const el = $(id);
  el.textContent = msg; el.hidden = false;
  // 重放抖动
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
}

/** 按钮忙碌态：保留内部 <span>，加转圈 */
function setBtn(btn, busy, txt) {
  btn.disabled = busy;
  btn.classList.toggle('is-busy', busy);
  const s = btn.querySelector('span');
  if (txt != null) { if (s) s.textContent = txt; else btn.textContent = txt; }
}

/** 0–4 档强度 + 一句人话 */
function pwScore(pw) {
  if (!pw) return { s: 0, txt: '' };
  if (pw.length < 8) return { s: 1, txt: `还差 ${8 - pw.length} 位，至少要 8 位` };
  let n = 0;
  if (/[a-z]/.test(pw)) n++;
  if (/[A-Z]/.test(pw)) n++;
  if (/[0-9]/.test(pw)) n++;
  if (/[^a-zA-Z0-9]/.test(pw)) n++;
  if (pw.length >= 14) n++;
  if (n <= 2) return { s: 2, txt: '有点简单。数据是用这个密码加密的，越弱越容易被猜开' };
  if (n === 3) return { s: 3, txt: '还行，够用了' };
  return { s: 4, txt: '很不错 👍' };
}
function pwStrength(pw) { return pwScore(pw).txt; }

/** 恢复码边打边分组成 XXXXX-XXXXX-… */
function formatCodeInput(el) {
  const start = el.selectionStart, before = el.value;
  const raw = before.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 20);
  const out = (raw.match(/.{1,5}/g) || []).join('-');
  if (out === before) return;
  el.value = out;
  // 光标尽量停在原来的位置附近
  const kept = before.slice(0, start).replace(/[^A-Za-z2-9]/g, '').length;
  const pos = kept + Math.floor(Math.max(0, kept - 1) / 5);
  el.setSelectionRange(pos, pos);
}

/** 标红某个输入框（下次输入自动消掉） */
function badField(sel) {
  const el = $(sel); if (!el) return;
  const f = el.closest('.f-field'); if (!f) return;
  f.classList.add('bad');
  el.focus();
}

async function doRegister() {
  const email = $('#auth-reg-email').value.trim();
  const pw = $('#auth-reg-pw').value;
  const pw2 = $('#auth-reg-pw2').value;
  const remember = $('#auth-reg-remember').checked;

  if (!HappySync.validEmail(email)) { badField('#auth-reg-email'); return authErr('#auth-reg-err', '邮箱格式看着不太对'); }
  if (pw.length < 8) { badField('#auth-reg-pw'); return authErr('#auth-reg-err', '密码至少 8 位'); }
  if (pw !== pw2) { badField('#auth-reg-pw2'); return authErr('#auth-reg-err', '两次输入的密码不一样'); }

  const btn = $('#auth-reg-go'); setBtn(btn, true);
  try {
    if (await HappySync.emailTaken(email)) {
      badField('#auth-reg-email');
      authErr('#auth-reg-err', '这个邮箱注册过了，直接登录吧');
      return;
    }
    const code = await HappySync.register(email, pw, remember);
    pendingRecovery = code;
    $('#auth-code-box').textContent = code;
    $('#auth-code-ack').checked = false;
    $('#auth-code-done').disabled = true;
    authView('showcode');
    await SYNC.pullMerge();
  } catch (e) {
    authErr('#auth-reg-err', e.message || '注册失败');
  } finally { setBtn(btn, false); }
}

async function doLogin() {
  const email = $('#auth-login-email').value.trim();
  const pw = $('#auth-login-pw').value;
  const remember = $('#auth-login-remember').checked;
  if (!email) { badField('#auth-login-email'); return authErr('#auth-login-err', '邮箱要填一下'); }
  if (!pw)    { badField('#auth-login-pw');    return authErr('#auth-login-err', '密码要填一下'); }

  const btn = $('#auth-login-go'); setBtn(btn, true);
  try {
    await HappySync.login(email, pw, remember);
    closeModal('#modal-auth');
    renderUserCard(); renderSync();
    toast('欢迎回来 🌿');
    await SYNC.pullMerge(true);
  } catch (e) {
    if (/密码/.test(e.message || '')) badField('#auth-login-pw');
    else badField('#auth-login-email');
    authErr('#auth-login-err', e.message || '登录失败');
  } finally { setBtn(btn, false); }
}

async function doRecover() {
  const code = $('#auth-rec-code').value;
  if (!code) { badField('#auth-rec-code'); return authErr('#auth-rec-err', '把恢复码填进来'); }
  const btn = $('#auth-rec-go'); setBtn(btn, true);
  try {
    await HappySync.recover(code, true);
    renderUserCard(); renderSync();
    await SYNC.pullMerge();
    toast('进来了，数据都在 🌿');
    authView('setpass');
  } catch (e) {
    badField('#auth-rec-code');
    authErr('#auth-rec-err', e.message || '恢复码不对');
  } finally { setBtn(btn, false); }
}

async function doSetPass() {
  const email = $('#auth-sp-email').value.trim();
  const pw = $('#auth-sp-pw').value, pw2 = $('#auth-sp-pw2').value;
  if (!HappySync.validEmail(email)) { badField('#auth-sp-email'); return authErr('#auth-sp-err', '邮箱格式看着不太对'); }
  if (pw.length < 8) { badField('#auth-sp-pw'); return authErr('#auth-sp-err', '密码至少 8 位'); }
  if (pw !== pw2) { badField('#auth-sp-pw2'); return authErr('#auth-sp-err', '两次输入的密码不一样'); }

  const btn = $('#auth-sp-go'); setBtn(btn, true);
  try {
    await HappySync.setPassword(email, pw);
    closeModal('#modal-auth');
    renderUserCard(); renderSync();
    toast('密码改好了 ✅');
  } catch (e) {
    authErr('#auth-sp-err', e.message || '保存失败');
  } finally { setBtn(btn, false); }
}

async function doChangeEmail() {
  const email = $('#ce-email').value.trim();
  const pw = $('#ce-pw').value;
  if (!HappySync.validEmail(email)) { badField('#ce-email'); return authErr('#ce-err', '新邮箱格式看着不太对'); }
  if (!pw) { badField('#ce-pw'); return authErr('#ce-err', '要输入当前密码确认身份'); }

  const btn = $('#ce-go'); setBtn(btn, true);
  try {
    await HappySync.changeEmail(email, pw);
    $('#ce-email').value = ''; $('#ce-pw').value = '';
    renderManage(); renderUserCard();
    authView('manage');
    toast('邮箱换好了，以后用新邮箱登录 ✉️', 2600);
  } catch (e) {
    if (/密码/.test(e.message || '')) badField('#ce-pw'); else badField('#ce-email');
    authErr('#ce-err', e.message || '换绑失败');
  } finally { setBtn(btn, false); }
}

async function doResetRecovery() {
  if (!confirm('会生成一串新的恢复码，旧的立刻失效。\n新的记得重新保存。\n\n继续吗？')) return;
  try {
    const code = await HappySync.resetRecovery();
    pendingRecovery = code;
    $('#auth-code-box').textContent = code;
    $('#auth-code-ack').checked = false;
    $('#auth-code-done').disabled = true;
    authView('showcode');
  } catch (e) { authErr('#mgr-err', e.message || '重置失败'); }
}

async function doDeleteAccount() {
  const pw = $('#del-pw').value;
  const cf = ($('#del-confirm').value || '').trim();
  if (!pw) { badField('#del-pw'); return authErr('#del-err', '要输入当前密码'); }
  if (cf !== '删除我的账号') { badField('#del-confirm'); return authErr('#del-err', '确认文字要一字不差地输入「删除我的账号」'); }

  const btn = $('#del-go'); setBtn(btn, true);
  try {
    await HappySync.deleteAccount(pw);
    closeModal('#modal-auth');
    SYNC.setState('off');
    store.del('lastSync');
    renderUserCard(); renderSync();
    toast('账号已注销，云端数据已全部删除', 3200);
  } catch (e) {
    badField('#del-pw');
    authErr('#del-err', e.message || '删除失败');
  } finally { setBtn(btn, false); }
}

function mailRecovery() {
  const to = ($('#auth-reg-email').value || HappySync.email || '').trim();
  const subject = '幸福小事 · 我的恢复码（请留着别删）';
  const body =
`这是「幸福小事」的账号恢复码：

${pendingRecovery}

忘记密码时用它进入账号，然后重设密码。
这串码没有任何备份 —— 服务器上只有加密后的密文，
连开发者都打不开。丢了就真的进不去了。

登录地址：https://happy.llmwiki.cloud
`;
  location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/* ───────── 导航 & 弹窗 ───────── */
function go(name) {
  S.screen = name;
  $$('.screen').forEach(s => s.classList.toggle('is-active', s.id === 'screen-' + name));
  $$('.tab').forEach(t => t.classList.toggle('is-active', t.dataset.screen === name));
  scrollTo({ top: 0, behavior: 'instant' });
  if (name === 'journal') { renderMoodRow(); renderJournal(); }
  if (name === 'report') renderReport();
  if (name === 'me') renderMe();
}
function openModal(sel) { $(sel).hidden = false; document.body.style.overflow = 'hidden'; }
function closeModal(sel) {
  $(sel).hidden = true;
  document.body.style.overflow = '';
  // 关掉查看器时把里面的视频一并卸掉，否则它会在后台继续放
  if (sel === '#modal-media') { const st = $('#mv-stage'); if (st) st.innerHTML = ''; S.viewer = null; }
}

/* ───────── 事件 ───────── */
function bind() {
  // 底部导航
  $$('.tab').forEach(t => t.onclick = () => go(t.dataset.screen));

  // 分类
  $('#cat-strip').onclick = e => {
    const b = e.target.closest('.cat-btn'); if (!b) return;
    S.cat = b.dataset.cat; renderCatStrip(); renderTasks();
  };

  // 任务
  $('#task-list').onclick = e => {
    const tick = e.target.closest('.tick');
    if (tick) { toggle(tick.closest('.task').dataset.id, tick); return; }
    const nb = e.target.closest('.note-btn');
    if (nb) { openNote(nb.closest('.task').dataset.id); return; }
  };

  // 模式 / 天气
  $('#seg-day').onclick = e => {
    const b = e.target.closest('.seg-btn'); if (!b) return;
    S.settings.override = { date: S.today, val: b.dataset.day };
    persistSettings();
    renderModeUI(); renderTasks();
    toast(b.dataset.day === 'work' ? '好，今天是忙碌模式 💼' : '好，今天松弛一点 🌿');
  };
  $('#weather-pick').onclick = e => {
    const b = e.target.closest('.wbtn'); if (!b) return;
    S.settings.weather = b.dataset.weather;
    persistSettings();
    renderModeUI(); renderTasks();
  };

  // 设置
  $('#btn-settings').onclick = openSettings;
  $('#settings-save').onclick = saveSettings;
  $('#wd-row').onclick = e => { const b = e.target.closest('.wd'); if (b) b.classList.toggle('is-on'); };

  // 心情
  $('#mood-row').onclick = e => {
    const b = e.target.closest('.mood-opt'); if (!b) return;
    S.mood = b.dataset.mood;
    $$('.mood-opt').forEach(x => x.classList.toggle('is-on', x === b));
  };
  $('#mood-input').oninput = updateNoteCount;
  $('#btn-voice').onclick = toggleVoice;
  $('#btn-save-mood').onclick = saveMood;
  $('#journal-list').onclick = async e => {
    const tile = e.target.closest('.mtile');
    if (tile) { openViewer(tile.dataset.day, tile.dataset.mid); return; }

    const d = e.target.closest('.jcard-del'); if (!d) return;
    const k = d.closest('.jcard').dataset.date;
    const n = ((S.journal[k] || {}).media || []).length;
    if (!confirm(n ? `删掉这天的心情记录吗？连同 ${n} 个照片/视频一起，云端也会删掉。（打卡记录会保留）`
                   : '删掉这天的心情记录吗？（打卡记录会保留）')) return;
    await MEDIA.removeDay(k);
    delete S.journal[k]; store.set('journal', S.journal); renderJournal();
  };

  // 照片 / 视频 / 录音
  // input 被 <label> 包着，点击是浏览器原生转过来的，这里只管收文件
  ['#file-media', '#file-shot'].forEach(sel => {
    const el = $(sel); if (!el) return;
    el.onchange = e => { MEDIA.add(e.target.files); e.target.value = ''; };
  });
  $('#btn-record').onclick = () => REC.toggle();
  $('#media-strip').onclick = async e => {
    const del = e.target.closest('[data-mdel]');
    if (del) {
      if (!confirm('删掉这个吗？云端那份也会一起删。')) return;
      await MEDIA.remove(S.today, del.dataset.mdel);
      renderMediaStrip();
      if (S.screen === 'journal') renderJournal();
      return;
    }
    const tile = e.target.closest('.mtile');
    if (tile) openViewer(tile.dataset.day, tile.dataset.mid);
  };
  $('#report-body').addEventListener('click', e => {
    const tile = e.target.closest('.mtile');
    if (tile) openViewer(tile.dataset.day, tile.dataset.mid);
  });

  // 大图 / 视频查看器
  $('#mv-prev').onclick = () => { if (S.viewer) { S.viewer.i--; renderViewer(); } };
  $('#mv-next').onclick = () => { if (S.viewer) { S.viewer.i++; renderViewer(); } };
  $('#mv-save').onclick = saveViewerFile;
  $('#mv-del').onclick = async () => {
    const v = S.viewer; if (!v) return;
    const m = (((S.journal[v.day] || {}).media) || [])[v.i];
    if (!m) return;
    if (!confirm('删掉这个吗？云端那份也会一起删。')) return;
    await MEDIA.remove(v.day, m.id);
    renderMediaStrip(); renderJournal();
    if (S.screen === 'report') renderReport();
    renderViewer();
  };

  // 感悟弹窗
  $('#note-save').onclick = saveNote;
  $('#note-skip').onclick = () => { closeModal('#modal-note'); toast('好，那就不写 🌿'); };

  // 报告
  $('#seg-report').onclick = e => {
    const b = e.target.closest('.seg-btn'); if (!b) return;
    S.repTab = b.dataset.rep; renderReport();
  };

  // 我的
  $('#btn-add-custom').onclick = () => {
    if (S.custom.length >= TARGET_TOTAL - BUILTIN_COUNT) { toast('12 个位置都满啦'); return; }
    $('#cat-choose').innerHTML = CATEGORIES.map(c =>
      `<button data-cat="${c.id}" class="${c.id === S.customCat ? 'is-on' : ''}">${c.icon} ${c.short}</button>`).join('');
    openModal('#modal-custom');
    setTimeout(() => $('#custom-text').focus(), 320);
  };
  $('#cat-choose').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    S.customCat = b.dataset.cat;
    $$('#cat-choose button').forEach(x => x.classList.toggle('is-on', x === b));
  };
  $('#custom-save').onclick = addCustom;
  $('#custom-list').onclick = e => {
    const d = e.target.closest('.cust-del'); if (!d) return;
    delCustom(d.closest('.cust').dataset.id);
  };
  $('#btn-export').onclick = exportData;
  $('#btn-import').onclick = () => $('#file-import').click();
  $('#file-import').onchange = e => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; };
  $('#btn-clear').onclick = clearAll;

  // 账号弹窗
  $('#auth-login-go').onclick = doLogin;
  $('#auth-reg-go').onclick   = doRegister;
  $('#auth-rec-go').onclick   = doRecover;
  $('#auth-sp-go').onclick    = doSetPass;
  $('#auth-sp-skip').onclick  = () => { closeModal('#modal-auth'); renderSync(); };
  $$('#modal-auth [data-goto]').forEach(b => b.onclick = () => authView(b.dataset.goto));
  $('#auth-back').onclick = e => authView(e.currentTarget.dataset.to || 'login');

  // 密码强度
  $('#auth-reg-pw').oninput = e => {
    const r = pwScore(e.target.value);
    $('#auth-pw-meter').dataset.s = String(r.s);
    $('#auth-pw-hint').textContent = r.txt;
  };

  // 显示 / 隐藏密码
  $$('#modal-auth .f-eye').forEach(b => {
    b.onclick = () => {
      const inp = $('#' + b.dataset.eye); if (!inp) return;
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      b.classList.toggle('is-on', show);
      b.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
    };
  });

  // 一开始打字就把红框收掉
  $$('#modal-auth .f-field input').forEach(inp => {
    inp.addEventListener('input', () => inp.closest('.f-field').classList.remove('bad'));
  });

  // 恢复码边打边分组
  $('#auth-rec-code').addEventListener('input', e => formatCodeInput(e.target));

  // 回车提交
  const ENTER = {
    '#auth-login-email': doLogin, '#auth-login-pw': doLogin,
    '#auth-reg-pw2': doRegister,
    '#auth-rec-code': doRecover,
    '#auth-sp-pw2': doSetPass,
    '#ce-pw': doChangeEmail,
  };
  Object.entries(ENTER).forEach(([sel, fn]) => {
    const el = $(sel); if (!el) return;
    el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); fn(); } });
  });
  $('#auth-code-copy').onclick = () => copyText(pendingRecovery || '');
  $('#auth-code-mail').onclick = mailRecovery;
  $('#auth-code-ack').onchange = e => { $('#auth-code-done').disabled = !e.target.checked; };
  $('#auth-code-done').onclick = () => {
    const wasReset = window.HappySync && HappySync.on && HappySync.createdAt &&
                     Date.now() - HappySync.createdAt > 60000;
    pendingRecovery = null;
    closeModal('#modal-auth');
    renderUserCard(); renderSync();
    toast(wasReset ? '新的恢复码已生效 🎫' : '账号建好了，以后自动登录 ☁️');
  };

  // 账号管理
  $('#mgr-save-profile').onclick = saveProfile;
  $('#avatar-pick').onclick = e => {
    const b = e.target.closest('button[data-av]'); if (!b) return;
    S.profile.avatar = b.dataset.av; S.profile.ts = Date.now();
    store.set('profile', S.profile);
    renderManage(); renderUserCard();
  };
  $('#mgr-pw').onclick        = () => openAuth('setpass');
  $('#mgr-email-btn').onclick = () => authView('chemail');
  $('#mgr-rec').onclick       = doResetRecovery;
  $('#mgr-sync').onclick      = async () => { closeModal('#modal-auth'); await SYNC.pullMerge(true); };
  $('#mgr-logout').onclick    = () => {
    if (!confirm('退出后这台设备就不再同步了。\n本机和云端的数据都会保留，用邮箱密码还能登回来。')) return;
    HappySync.logout();
    SYNC.setState('off');
    store.del('lastSync');
    closeModal('#modal-auth');
    renderUserCard(); renderSync();
    toast('已退出登录');
  };
  $('#mgr-delete').onclick = () => {
    $('#del-pw').value = ''; $('#del-confirm').value = '';
    authView('delacct');
  };
  $('#ce-go').onclick  = doChangeEmail;
  $('#del-go').onclick = doDeleteAccount;
  // 弹窗关闭
  document.addEventListener('click', e => {
    const c = e.target.closest('[data-close]');
    if (c) { const m = c.closest('.modal'); if (m) closeModal('#' + m.id); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { $$('.modal').forEach(m => { if (!m.hidden) closeModal('#' + m.id); }); return; }
    if (!S.viewer) return;
    if (e.key === 'ArrowLeft')  { S.viewer.i--; renderViewer(); }
    if (e.key === 'ArrowRight') { S.viewer.i++; renderViewer(); }
  });

  scheduleRemind();
}

/* ───────── Service Worker ───────── */
function registerSW() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

/* ───────── 启动 ───────── */
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
