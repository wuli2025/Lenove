import puppeteer from 'puppeteer-core';
const SITE = 'https://happy.llmwiki.cloud/';
const OUT = 'C:/Users/mi/AppData/Local/Temp/claude/D--polaris---------/917d202a-b746-4f0d-9112-26ee1d902543/scratchpad/shots';
const wait = ms => new Promise(r => setTimeout(r, ms));
const t = Date.now();
const MAIL1 = `u${t}@example.com`, MAIL2 = `u${t}.new@example.com`;
const PW = 'userSystem123';

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] });
const errs = [];
async function device(label) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: 400, height: 900, deviceScaleFactor: 1 });
  p.on('pageerror', e => errs.push(`${label}: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error') errs.push(`${label}: ${m.text()}`); });
  p.on('dialog', async d => { await d.accept(); });
  await p.goto(SITE, { waitUntil: 'networkidle0' }); await wait(1500);
  return p;
}
const tap = async (p, s) => {
  await p.evaluate(x => document.querySelector(x)?.scrollIntoView({ block: 'center' }), s);
  await wait(150); await p.evaluate(x => document.querySelector(x).click(), s);
};
const fill = async (p, s, v) => {
  await p.evaluate(x => { const e = document.querySelector(x); e.scrollIntoView({ block: 'center' }); e.value = ''; e.focus(); }, s);
  await wait(100); await p.type(s, v);
};
const txt = (p, s) => p.$eval(s, e => e.textContent.trim());
const res = [];
const check = (n, v) => { res.push([n, v]); console.log(`  ${v ? '✓' : '✗'} ${n}`); };

// ── 1. 未登录态的用户卡片 ──
console.log('【1】未登录状态');
const A = await device('A');
await tap(A, '.tab[data-screen="me"]'); await wait(800);
check('未登录显示"还没登录"', (await txt(A, '#user-card')).includes('还没登录'));
await A.screenshot({ path: `${OUT}/70-guest.png` });

// ── 2. 从用户卡片注册 ──
console.log('\n【2】注册');
await tap(A, '#uc-register'); await wait(700);
await fill(A, '#auth-reg-email', MAIL1);
await fill(A, '#auth-reg-pw', PW);
await fill(A, '#auth-reg-pw2', PW);
await tap(A, '#auth-reg-go'); await wait(9000);
const rec1 = await txt(A, '#auth-code-box');
console.log('  恢复码1:', rec1);
await tap(A, '#auth-code-ack'); await wait(200);
await tap(A, '#auth-code-done'); await wait(1200);
check('注册后用户卡片显示邮箱', (await txt(A, '#user-card')).includes(MAIL1));

// ── 3. 改昵称 + 头像 ──
console.log('\n【3】改资料');
await tap(A, '#uc-open'); await wait(800);
await fill(A, '#mgr-nick-input', '小太阳');
await tap(A, '#mgr-save-profile'); await wait(900);
await tap(A, '[data-av="🐱"]'); await wait(700);
await A.screenshot({ path: `${OUT}/71-manage.png` });
await tap(A, '#modal-auth .auth-view[data-view="manage"] .primary-btn[data-close]'); await wait(700);
const cardTxt = await txt(A, '#user-card');
check('昵称显示在卡片上', cardTxt.includes('小太阳'));
check('头像已换成猫', (await A.$eval('#user-card .uc-avatar', e => e.textContent.trim())) === '🐱');
await A.screenshot({ path: `${OUT}/72-usercard.png` });

// ── 4. 打卡产生数据 ──
console.log('\n【4】打卡 3 件');
await tap(A, '.tab[data-screen="today"]'); await wait(600);
await A.evaluate(() => scrollTo(0, 600)); await wait(300);
for (let i = 0; i < 3; i++) {
  const ts = await A.$$('.task:not(.done) .tick');
  await ts[0].click(); await wait(550);
  const m = await A.$('#modal-reward:not([hidden]) .primary-btn');
  if (m) { await m.click(); await wait(350); }
  await A.evaluate(() => scrollTo(0, 600)); await wait(180);
}
const aDone = await A.evaluate(() => +document.querySelector('#done-count').textContent);
await wait(5000);
console.log('  A 完成', aDone, '件');

// ── 5. 换邮箱 ──
console.log('\n【5】换绑邮箱');
await tap(A, '.tab[data-screen="me"]'); await wait(600);
await tap(A, '#uc-open'); await wait(700);
await tap(A, '#mgr-email-btn'); await wait(600);
await fill(A, '#ce-email', MAIL2);
await fill(A, '#ce-pw', 'wrongPass000');
await tap(A, '#ce-go'); await wait(7000);
check('错误密码换绑被拒', (await txt(A, '#ce-err')).includes('密码不对'));
await fill(A, '#ce-pw', PW);
await tap(A, '#ce-go'); await wait(9000);
check('换绑后显示新邮箱', (await txt(A, '#mgr-email')) === MAIL2);

// ── 6. 重置恢复码 ──
console.log('\n【6】重置恢复码');
await tap(A, '#mgr-rec'); await wait(8000);
const rec2 = await txt(A, '#auth-code-box');
console.log('  恢复码2:', rec2);
check('生成了不同的新恢复码', /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/.test(rec2) && rec2 !== rec1);
await tap(A, '#auth-code-ack'); await wait(200);
await tap(A, '#auth-code-done'); await wait(1500);

// ── 7. 新设备用新邮箱登录，数据要在 ──
console.log('\n【7】设备 B 用新邮箱登录');
const B = await device('B');
await tap(B, '.tab[data-screen="me"]'); await wait(600);
await tap(B, '#uc-login'); await wait(700);
await fill(B, '#auth-login-email', MAIL2);
await fill(B, '#auth-login-pw', PW);
await tap(B, '#auth-login-go'); await wait(10000);
const bDone = await B.evaluate(() => +document.querySelector('#done-count').textContent);
await tap(B, '.tab[data-screen="me"]'); await wait(700);
const bCard = await txt(B, '#user-card');
check('B 拿到打卡数据', bDone === aDone);
check('B 同步到了昵称和头像', bCard.includes('小太阳'));

// ── 8. 旧恢复码应失效，新的可用 ──
console.log('\n【8】恢复码新旧验证');
const C = await device('C');
await tap(C, '.tab[data-screen="me"]'); await wait(600);
await tap(C, '#uc-login'); await wait(600);
await tap(C, '#modal-auth [data-goto="recover"]'); await wait(500);
await fill(C, '#auth-rec-code', rec1);
await tap(C, '#auth-rec-go'); await wait(8000);
check('旧恢复码已失效', (await txt(C, '#auth-rec-err')).length > 0);
await fill(C, '#auth-rec-code', rec2);
await tap(C, '#auth-rec-go'); await wait(10000);
const cDone = await C.evaluate(() => +document.querySelector('#done-count').textContent);
check('新恢复码可用且数据完整', cDone === aDone);

// ── 9. 注销账号 ──
console.log('\n【9】注销账号');
await tap(B, '#uc-open'); await wait(700);
await tap(B, '#mgr-delete'); await wait(600);
await fill(B, '#del-pw', PW);
await fill(B, '#del-confirm', '随便打的');
await tap(B, '#del-go'); await wait(3000);
check('确认文字不对被拦住', (await txt(B, '#del-err')).includes('一字不差'));
await fill(B, '#del-confirm', '删除我的账号');
await tap(B, '#del-go'); await wait(10000);
await wait(1500);
check('注销后回到未登录态', (await txt(B, '#user-card')).includes('还没登录'));

// 云端确实被删
const D = await device('D');
await tap(D, '.tab[data-screen="me"]'); await wait(600);
await tap(D, '#uc-login'); await wait(600);
await fill(D, '#auth-login-email', MAIL2);
await fill(D, '#auth-login-pw', PW);
await tap(D, '#auth-login-go'); await wait(9000);
check('注销后无法再登录', (await txt(D, '#auth-login-err')).length > 0);

console.log('\n───── 汇总 ─────');
const bad = res.filter(r => !r[1]);
console.log(`${res.length - bad.length}/${res.length} 通过`);
bad.forEach(b => console.log('  失败:', b[0]));
console.log('页面错误数:', errs.length);
errs.slice(0, 8).forEach(e => console.log('  !!', e));
await browser.close();
