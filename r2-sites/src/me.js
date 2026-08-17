/**
 * 个人中心 + 登录页。
 *
 * 版式参考「有戏剧场」个人主页：横幅 + 骑在横幅上的资料卡（左，sticky）+ 作品陈列（右）。
 * 只借它的「作品陈列 + 个人信息」这套语言；工作空间那一套（继续创作 / 新建项目）
 * 不抄 —— 这个产品的创作入口在首页数字人访谈，个人中心只负责「我是谁 + 我做过什么」。
 *
 * 数据从哪来：index.js 只会传 user 进来（页面路由拿不到作品），
 * 所以作品列表由页面内联 JS 去 GET /api/me/works 填充。
 * 预览脚本可以直接 meHtml({user, preload}) 把数据塞进来，走的是同一套渲染代码，
 * 截出来的图和线上真实渲染一致。
 */
import { page } from './layout.js';
import { BRAND, ACCENTS, esc } from './brand.js';

// 把 currentUser 的实现留在 auth.js（会话逻辑只应该有一份），这里只做转出，
// 保持 index.js 里 `import { meHtml, currentUser } from './me.js'` 不用改。
export { currentUser } from './auth.js';

/**
 * 内联到 <script> 里的 JSON。
 * 标题是用户输入，一个 `</script>` 就能把页面劈开，所以 `<` 一律转义；
 * U+2028/2029 在 JSON 里合法、在 JS 源码里却算换行符，也要一起转掉。
 */
const safeJson = (v) =>
  JSON.stringify(v ?? null)
    .replace(/</g, '\\u003c')
    .replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16));

const CSS = `
body{background-image:radial-gradient(900px 520px at 80% -10%,rgba(102,217,232,.10),transparent 62%)}
.wrap{max-width:1240px;margin:0 auto;padding:0 20px 90px}

/* ── 未登录：登录卡 ── */
.gate{min-height:calc(100vh - 72px);display:flex;align-items:center;justify-content:center;padding:40px 20px}
.gate-card{width:100%;max-width:412px;border:1px solid var(--line);border-radius:16px;
  background:rgba(12,19,30,.76);padding:34px 30px 28px}
.gate-card h1{font-size:23px;font-weight:750;letter-spacing:.01em;margin-bottom:8px}
.gate-card .lead{color:var(--muted);font-size:13.5px;line-height:1.8;margin-bottom:24px}
.field{margin-bottom:14px}
.field label{display:block;font-size:12px;color:var(--dim);margin-bottom:7px;letter-spacing:.04em}
.field input{width:100%;height:44px;padding:0 14px;border-radius:10px;color:var(--text);font-size:14px;
  border:1px solid var(--line);background:rgba(255,255,255,.03);outline:none;font-family:inherit}
.field input:focus{border-color:var(--line-strong);background:rgba(255,255,255,.05)}
.field input[readonly]{color:var(--muted);background:rgba(255,255,255,.015)}
#code{font-family:var(--mono);font-size:20px;letter-spacing:.42em;text-align:center}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:44px;padding:0 18px;
  border:1px solid var(--line);border-radius:10px;background:rgba(255,255,255,.04);color:var(--text);
  font-size:13.5px;font-weight:600;cursor:pointer;transition:160ms ease;font-family:inherit}
.btn:hover{border-color:var(--line-strong)}
.btn.primary{background:var(--acid);border-color:var(--acid);color:#04070d;font-weight:700}
.btn.primary:hover{filter:brightness(1.08)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn.wide{width:100%}
.btn.sm{height:32px;padding:0 12px;font-size:12px;border-radius:8px}
.msg{min-height:20px;margin-top:12px;font-size:12.5px;line-height:1.7;color:var(--gold)}
.msg.ok{color:var(--acid)}
.hint{margin-top:16px;padding-top:14px;border-top:1px solid var(--line);
  font-size:11.5px;color:var(--dim);line-height:1.9}
.step{display:none}.step.on{display:block}
.back{background:0;border:0;color:var(--dim);font:inherit;font-size:12px;cursor:pointer;padding:0;margin-top:12px}
.back:hover{color:var(--muted)}

/* ── 已登录：横幅 + 资料卡 + 作品陈列 ── */
.banner{height:178px;margin-top:20px;border-radius:16px;border:1px solid var(--line);
  background:radial-gradient(130% 190% at 16% -10%,#123244,#0c1622 56%,#070b12 100%);position:relative;overflow:hidden}
.banner::after{content:"";position:absolute;inset:0;
  background-image:linear-gradient(rgba(217,226,234,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(217,226,234,.05) 1px,transparent 1px);
  background-size:34px 34px;mask-image:linear-gradient(180deg,rgba(0,0,0,.7),transparent)}
.lay{display:grid;grid-template-columns:308px 1fr;gap:24px;align-items:start;margin-top:18px}
.card{border:1px solid var(--line);border-radius:16px;background:rgba(12,19,30,.82);
  padding:26px 22px 22px;text-align:center;position:sticky;top:92px;margin-top:-112px}
.ava{width:112px;height:112px;border-radius:50%;margin:0 auto 15px;overflow:hidden;display:grid;place-items:center;
  font-size:40px;font-weight:800;color:#04070d;background:linear-gradient(140deg,#66d9e8,#b58ae0 62%,#f0d08a);
  box-shadow:0 0 0 4px rgba(7,11,18,.85)}
.ava img{width:100%;height:100%;object-fit:cover}
.card h2{font-size:20px;font-weight:700;word-break:break-all;margin-bottom:6px}
.card .mail{font-family:var(--mono);font-size:11.5px;color:var(--dim);word-break:break-all}
.stats{display:flex;margin:20px 0 18px}
.stats>div{flex:1;position:relative}
.stats>div+div::before{content:"";position:absolute;left:0;top:5px;bottom:5px;width:1px;background:var(--line)}
.stats b{display:block;font-size:19px;font-weight:750;font-family:var(--mono);color:var(--acid)}
.stats span{display:block;font-size:11.5px;color:var(--dim);margin-top:4px}
.acts{display:flex;flex-direction:column;gap:9px}
.acts .btn{width:100%}
.edit{margin-top:4px;text-align:left;display:none}
.edit.on{display:block}
.col{min-width:0}
.sec-hd{display:flex;align-items:baseline;gap:11px;margin:0 0 14px}
.sec-hd h3{font-size:17px;font-weight:650;letter-spacing:.02em}
.sec-hd .cnt{font-size:12px;color:var(--dim)}
.sec{margin-bottom:34px}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}
.w{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:rgba(12,19,30,.72);
  transition:border-color .18s,transform .18s}
.w:hover{border-color:var(--line-strong);transform:translateY(-2px)}
.w .th{aspect-ratio:16/10;background:#0b111b;border-bottom:1px solid var(--line);overflow:hidden;display:block;position:relative}
.w .th img{width:100%;height:100%;object-fit:cover;object-position:top center;display:block}
.w .th .ph{width:100%;height:100%;display:grid;place-items:center;font-size:34px;font-weight:800;color:rgba(7,11,18,.62)}
.w .in{padding:12px 14px 14px}
.w .t{font-size:14.5px;font-weight:650;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.w .sub{font-size:12px;color:var(--dim);height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.w .mt{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:11.5px;color:var(--dim)}
.w .hits{font-family:var(--mono);color:var(--gold)}
.w .off{margin-left:auto;border:1px solid rgba(240,208,138,.4);border-radius:5px;padding:1px 7px;color:var(--gold)}
.w .links{display:flex;gap:8px;margin-top:11px;padding-top:11px;border-top:1px solid var(--line)}
.w .links a{font-size:11.5px;color:var(--muted);border:1px solid var(--line);border-radius:7px;padding:4px 9px}
.w .links a:hover{color:var(--text);border-color:var(--line-strong)}
.urls{border:1px solid var(--line);border-radius:12px;background:rgba(12,19,30,.6);overflow:hidden}
.u{display:flex;align-items:center;gap:12px;padding:12px 15px;border-top:1px solid var(--line)}
.u:first-child{border-top:0}
.u .nm{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34%}
.u code{font-family:var(--mono);font-size:11.5px;color:var(--acid);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.u .btn{margin-left:auto;flex:none}
.empty{border:1px dashed rgba(102,217,232,.26);border-radius:14px;padding:44px 24px;text-align:center;
  background:rgba(102,217,232,.035)}
.empty b{display:block;font-size:16px;margin-bottom:9px}
.empty span{color:var(--muted);font-size:13px;line-height:1.9}
.note{font-size:11.5px;color:var(--dim);line-height:1.9;margin-top:12px}
@media(max-width:1000px){
  .lay{grid-template-columns:1fr}
  .card{position:static;margin-top:-86px}
  .grid{grid-template-columns:1fr}
}`;

/** 未登录：一张登录卡，两步（填邮箱 → 填验证码） */
function gateBody() {
  return `<main class="gate"><div class="gate-card">
  <h1>登录 / 注册</h1>
  <p class="lead">输入邮箱，我们会发一个 6 位验证码给你。<br>没有账号的话，验证通过就自动创建，不用另外注册。</p>

  <div class="step on" id="s1">
    <div class="field">
      <label for="email">邮箱</label>
      <input id="email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" spellcheck="false">
    </div>
    <button class="btn primary wide" id="send">获取验证码</button>
  </div>

  <div class="step" id="s2">
    <div class="field">
      <label for="mailShow">邮箱</label>
      <input id="mailShow" readonly>
    </div>
    <div class="field">
      <label for="code">验证码（10 分钟内有效）</label>
      <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="······">
    </div>
    <button class="btn primary wide" id="verify">登录</button>
    <button class="back" id="again">换个邮箱 / 重新获取</button>
  </div>

  <div class="msg" id="msg"></div>
  <div class="hint">同一邮箱 60 秒内只能获取一次；一个验证码最多试 5 次。</div>
</div></main>`;
}

/** 已登录：横幅 + 资料卡 + 作品陈列 */
function homeBody(user) {
  const initial = esc(String(user.name || '?').trim().slice(0, 1).toUpperCase());
  const avatar = user.avatar
    ? `<img src="/r2/${esc(user.avatar)}" alt="${esc(user.name)}">`
    : initial;
  return `<main class="wrap">
  <div class="banner"></div>
  <div class="lay">
    <aside class="card">
      <!-- 头像先用首字母渐变块；上传位留着，等 R2 头像前缀和裁剪定了再接 -->
      <div class="ava" id="ava">${avatar}</div>
      <h2 id="uname">${esc(user.name)}</h2>
      <div class="mail">${esc(user.email)}</div>

      <div class="stats">
        <div><b id="stWorks">–</b><span>作品</span></div>
        <div><b id="stHits">–</b><span>被点开</span></div>
        <div><b id="stDays">–</b><span>加入天数</span></div>
      </div>

      <div class="acts">
        <button class="btn" id="editBtn">编辑资料</button>
        <button class="btn" id="logout">退出登录</button>
      </div>

      <div class="edit" id="editBox">
        <div class="field" style="margin-top:14px">
          <label for="nameInput">昵称（1–24 字）</label>
          <input id="nameInput" maxlength="24" value="${esc(user.name)}">
        </div>
        <div class="field">
          <label for="mailRo">邮箱（不可修改）</label>
          <input id="mailRo" readonly value="${esc(user.email)}">
        </div>
        <button class="btn primary wide sm" id="saveName" style="height:38px">保存</button>
        <div class="msg" id="pmsg"></div>
      </div>
    </aside>

    <div class="col">
      <section class="sec">
        <div class="sec-hd"><h3>我的作品</h3><span class="cnt" id="wcnt">加载中…</span></div>
        <div id="works"><div class="empty"><b>正在读取</b><span>稍等一下。</span></div></div>
        <div class="note" id="matchNote"></div>
      </section>

      <section class="sec">
        <div class="sec-hd"><h3>我的网址</h3><span class="cnt">发给谁都能直接打开</span></div>
        <div id="urls"></div>
      </section>
    </div>
  </div>
</main>`;
}

const GATE_JS = `
const $=(s)=>document.querySelector(s);
const msg=(t,ok)=>{const m=$('#msg');m.textContent=t||'';m.className='msg'+(ok?' ok':'');};
let mail='';
async function post(url,body){
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),credentials:'same-origin'});
  let d={};try{d=await r.json()}catch(e){}
  return {ok:r.ok&&d.ok,data:d};
}
$('#send').onclick=async()=>{
  const v=$('#email').value.trim().toLowerCase();
  if(!v){msg('请先填邮箱');return}
  $('#send').disabled=true;msg('发送中…',true);
  const {ok,data}=await post('/api/auth/request-code',{email:v});
  $('#send').disabled=false;
  if(!ok){msg(data.error||'发送失败');return}
  mail=data.email||v;
  $('#mailShow').value=mail;
  $('#s1').classList.remove('on');$('#s2').classList.add('on');
  // MAIL_DEBUG=1 时后端会把码带回来，联调不用翻日志；线上这个字段永远没有
  msg(data.debugCode?('联调模式：验证码 '+data.debugCode):'验证码已发送，请查收邮箱（含垃圾箱）',true);
  $('#code').focus();
};
$('#verify').onclick=async()=>{
  const c=$('#code').value.trim();
  if(!/^\\d{6}$/.test(c)){msg('验证码是 6 位数字');return}
  $('#verify').disabled=true;msg('验证中…',true);
  const {ok,data}=await post('/api/auth/verify',{email:mail,code:c});
  $('#verify').disabled=false;
  if(!ok){msg(data.error||'验证失败');return}
  msg('登录成功，正在进入…',true);
  location.href='/me';
};
$('#again').onclick=()=>{$('#s2').classList.remove('on');$('#s1').classList.add('on');msg('');$('#code').value=''};
$('#code').addEventListener('keydown',(e)=>{if(e.key==='Enter')$('#verify').click()});
$('#email').addEventListener('keydown',(e)=>{if(e.key==='Enter')$('#send').click()});
`;

const HOME_JS = `
const $=(s)=>document.querySelector(s);
const esc=(s)=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmt=(n)=>n>=10000?(n/10000).toFixed(1)+'w':String(n);
const AC=window.__ACCENTS__;

function card(w){
  const a=AC[(w.accent||0)%AC.length];
  const th=w.coverUrl
    ? '<img src="'+esc(w.coverUrl)+'" alt="" loading="lazy">'
    : '<div class="ph" style="background:linear-gradient(140deg,'+a.a+','+a.b+')">'+esc((w.title||'?').trim().slice(0,1))+'</div>';
  return '<div class="w">'
    +'<a class="th" href="'+esc(w.siteUrl)+'" target="_blank" rel="noopener">'+th+'</a>'
    +'<div class="in">'
      +'<div class="t">'+esc(w.title)+'</div>'
      +'<div class="sub">'+esc(w.tagline||'　')+'</div>'
      +'<div class="mt"><span class="hits">'+fmt(w.hits||0)+'</span><span>次点开</span>'
        +(w.status!=='public'?'<span class="off">已下架</span>':'')+'</div>'
      +'<div class="links">'
        +'<a href="'+esc(w.siteUrl)+'" target="_blank" rel="noopener">专属网址</a>'
        +'<a href="'+esc(w.posterUrl)+'" target="_blank" rel="noopener">分享海报</a>'
      +'</div>'
    +'</div></div>';
}

function urlRow(w){
  return '<div class="u"><span class="nm">'+esc(w.title)+'</span>'
    +'<code>/u/'+esc(w.slug)+'/</code>'
    +'<button class="btn sm" data-copy="'+esc(w.siteUrl)+'">复制</button></div>';
}

function render(d){
  const ws=d.works||[];
  $('#stWorks').textContent=ws.length;
  $('#stHits').textContent=fmt(d.stats?d.stats.hits:0);
  $('#stDays').textContent=d.stats?d.stats.days:'–';
  $('#wcnt').textContent=ws.length?(ws.length+' 个'):'还没有';
  $('#works').innerHTML=ws.length
    ? '<div class="grid">'+ws.map(card).join('')+'</div>'
    : '<div class="empty"><b>还没有作品</b><span>回首页说一句你想要什么样的网站，十分钟后它就会出现在这里。</span></div>';
  $('#urls').innerHTML=ws.length
    ? '<div class="urls">'+ws.map(urlRow).join('')+'</div>'
    : '<div class="empty"><b>暂无网址</b><span>发布第一个作品后，这里会列出它的专属网址。</span></div>';
  $('#matchNote').textContent=d.matchedBy==='creator-name'
    ? '作品目前按「创作者姓名 = 昵称」匹配（临时方案）。如果这里少了作品，多半是发布时填的姓名和当前昵称不一致。'
    : '';
}

document.addEventListener('click',async (e)=>{
  const b=e.target.closest('[data-copy]');
  if(!b)return;
  try{await navigator.clipboard.writeText(b.dataset.copy);b.textContent='已复制';setTimeout(()=>b.textContent='复制',1400)}catch(err){}
});

$('#editBtn').onclick=()=>$('#editBox').classList.toggle('on');
$('#saveName').onclick=async()=>{
  const m=$('#pmsg');const v=$('#nameInput').value.trim();
  m.className='msg';m.textContent='保存中…';
  const r=await fetch('/api/auth/profile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:v}),credentials:'same-origin'});
  let d={};try{d=await r.json()}catch(err){}
  if(!r.ok||!d.ok){m.textContent=d.error||'保存失败';return}
  m.className='msg ok';m.textContent=d.notice||'已保存';
  $('#uname').textContent=d.user.name;
  if(!$('#ava').querySelector('img'))$('#ava').textContent=(d.user.name||'?').trim().slice(0,1).toUpperCase();
  load();
};
$('#logout').onclick=async()=>{
  await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'});
  location.href='/';
};

async function load(){
  try{
    const r=await fetch('/api/me/works',{credentials:'same-origin'});
    const d=await r.json();
    if(!r.ok||!d.ok)throw new Error(d.error||'读取失败');
    render(d);
  }catch(e){
    $('#wcnt').textContent='读取失败';
    $('#works').innerHTML='<div class="empty"><b>没读到作品</b><span>'+esc(e.message)+'<br>刷新一下试试。</span></div>';
  }
}
// 预览脚本会预置 __PRELOAD__，走同一套 render，截图和线上一致
if(window.__PRELOAD__)render(window.__PRELOAD__);else load();
`;

/**
 * @param {{user:object|null, preload?:object}} opts
 *   preload 只给本地预览用（scripts/preview-me.mjs），线上不会传
 */
export function meHtml({ user, preload = null }) {
  const loggedIn = !!user;
  const script = loggedIn
    ? `window.__ACCENTS__=${safeJson(ACCENTS)};window.__PRELOAD__=${safeJson(preload)};${HOME_JS}`
    : GATE_JS;

  return page({
    title: loggedIn ? `${user.name} · 个人中心 · ${BRAND.name}` : `登录 · ${BRAND.name}`,
    desc: loggedIn ? `${user.name} 的作品与专属网址` : `用邮箱验证码登录 ${BRAND.name}`,
    active: 'me',
    user,
    css: CSS,
    body: loggedIn ? homeBody(user) : gateBody(),
    script,
  });
}
