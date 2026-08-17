/**
 * 认证纯函数单测 —— 直接 node scripts/verify-auth.mjs
 *
 * 只测不依赖 env / Response / D1 的那部分：邮箱格式、验证码判定（过期 / 次数 / 比对）、
 * 60 秒重发、IP 每小时上限、Cookie 序列化。这几段是登录流程里最容易改错、
 * 又最难在浏览器里复现的地方（要等 10 分钟才过期，要连点 5 次才超限）。
 *
 * D1 相关的分支（建号、写会话）没有 mock，属于本脚本覆盖不到的部分，见结尾提示。
 */
import {
  normalizeEmail, isValidEmail, validateName, defaultNameFromEmail,
  genCode, timingEqual, evaluateCode, resendState, ipQuotaState,
  parseCookies, sessionCookie, clearCookie, sha256Hex,
  CODE_TTL_MS, MAX_ATTEMPTS, RESEND_COOLDOWN_MS, IP_HOURLY_LIMIT, COOKIE_NAME,
} from '../src/auth.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? '  → ' + extra : ''}`); }
};
const sec = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 52 - s.length))}`);

// ───────────────────────── 邮箱 ─────────────────────────
sec('邮箱格式与归一化');
t('去空白 + 转小写', normalizeEmail('  Foo.Bar@Example.COM  ') === 'foo.bar@example.com');
t('null 不炸', normalizeEmail(null) === '' && normalizeEmail(undefined) === '');
for (const good of ['a@b.cn', 'foo.bar+tag@example.com', 'user_1@mail.co.uk', 'x-y@sub.domain.org']) {
  t(`合法：${good}`, isValidEmail(good));
}
for (const bad of ['', 'abc', 'a@b', '@example.com', 'a@@b.com', 'a b@c.com', 'a@b.', 'a@-b.com',
                   'a@b.com,c@d.com', '<a@b.com>', 'a@b.com\n', 'x'.repeat(250) + '@example.com']) {
  t(`拒绝：${JSON.stringify(bad).slice(0, 34)}`, !isValidEmail(bad));
}
t('非字符串输入', !isValidEmail(null) && !isValidEmail(123) && !isValidEmail({}));

// ───────────────────────── 昵称 ─────────────────────────
sec('昵称规则（1–24 字）');
t('空 → 拒绝', validateName('   ').ok === false);
t('压缩连续空白', validateName('  张  三  ').value === '张 三');
t('24 字放行', validateName('字'.repeat(24)).ok === true);
t('25 字拒绝', validateName('字'.repeat(25)).ok === false);
t('尖括号拒绝', validateName('<script>').ok === false);
t('emoji 按码点算长度', validateName('😀'.repeat(24)).ok === true && validateName('😀'.repeat(25)).ok === false);
t('默认昵称取 @ 前', defaultNameFromEmail('zhangsan@example.com') === 'zhangsan');
t('默认昵称兜底', defaultNameFromEmail('中文@example.com') === '创作者');

// ───────────────────────── 验证码生成 ─────────────────────────
sec('验证码生成');
{
  const codes = Array.from({ length: 3000 }, genCode);
  t('永远 6 位数字', codes.every((c) => /^\d{6}$/.test(c)));
  t('会出现前导零的码（说明没被当数字截断）', codes.some((c) => c[0] === '0'), '3000 次都没出 0 开头则可疑');
  t('不重复率 > 95%', new Set(codes).size / codes.length > 0.95, `实际 ${new Set(codes).size}/3000`);
}
t('timingEqual 相等', timingEqual('abc123', 'abc123'));
t('timingEqual 不等', !timingEqual('abc123', 'abc124') && !timingEqual('abc', 'abcd'));

// ───────────────────────── 验证码判定 ─────────────────────────
sec('验证码判定：过期 / 次数 / 比对');
const NOW = 1_700_000_000_000;
const row = (over = {}) => ({ code_hash: 'H', expires_at: NOW + CODE_TTL_MS, attempts: 0, ...over });

t('没请求过验证码 → none', evaluateCode(null, 'H', NOW).reason === 'none');
t('正确码 → ok', evaluateCode(row(), 'H', NOW).ok === true);
t('刚好 10 分钟整仍有效（边界含等号）', evaluateCode(row(), 'H', NOW + CODE_TTL_MS).ok === true);
t('过 10 分钟 1 毫秒 → expired', evaluateCode(row(), 'H', NOW + CODE_TTL_MS + 1).reason === 'expired');
t('过期时不返回 ok', evaluateCode(row(), 'H', NOW + CODE_TTL_MS + 1).ok === false);
t('过期优先于次数（过期码不该再吃 attempts）',
  evaluateCode(row({ attempts: MAX_ATTEMPTS }), 'H', NOW + CODE_TTL_MS + 1).reason === 'expired');
t(`试满 ${MAX_ATTEMPTS} 次 → too_many`, evaluateCode(row({ attempts: MAX_ATTEMPTS }), 'H', NOW).reason === 'too_many');
t('too_many 返回 429', evaluateCode(row({ attempts: MAX_ATTEMPTS }), 'H', NOW).status === 429);
t('第 5 次（attempts=4）还允许试', evaluateCode(row({ attempts: 4 }), 'H', NOW).ok === true);
t('第 5 次错了也算 mismatch，不是 too_many', evaluateCode(row({ attempts: 4 }), 'X', NOW).reason === 'mismatch');
t('剩余次数递减：0→4 / 4→0',
  evaluateCode(row({ attempts: 0 }), 'X', NOW).left === 4 && evaluateCode(row({ attempts: 4 }), 'X', NOW).left === 0);
t('错码不会误判成 ok', evaluateCode(row(), 'WRONG', NOW).ok === false);
// 连错 5 次的完整轨迹：前 5 次是 mismatch，第 6 次才被拒
{
  const seq = [0, 1, 2, 3, 4, 5].map((a) => evaluateCode(row({ attempts: a }), 'X', NOW).reason);
  t('连错轨迹 = 5×mismatch + too_many',
    JSON.stringify(seq) === JSON.stringify(['mismatch', 'mismatch', 'mismatch', 'mismatch', 'mismatch', 'too_many']),
    JSON.stringify(seq));
}

// ───────────────────────── 限流 ─────────────────────────
sec('限流：60 秒重发 / IP 每小时上限');
t('从没发过 → 放行', resendState(null, NOW).ok === true);
t('刚发完 1 秒 → 拒绝', resendState(NOW - 1000, NOW).ok === false);
t('拒绝时给出剩余秒数', Math.ceil(resendState(NOW - 1000, NOW).waitMs / 1000) === 59);
t('第 59.999 秒仍拒绝', resendState(NOW - (RESEND_COOLDOWN_MS - 1), NOW).ok === false);
t('整 60 秒放行', resendState(NOW - RESEND_COOLDOWN_MS, NOW).ok === true);
t('61 秒放行且 waitMs=0',
  resendState(NOW - 61000, NOW).ok === true && resendState(NOW - 61000, NOW).waitMs === 0);
t('IP 0 次 → 放行', ipQuotaState(0).ok === true);
t(`IP ${IP_HOURLY_LIMIT - 1} 次 → 放行（第 ${IP_HOURLY_LIMIT} 次是最后一次）`, ipQuotaState(IP_HOURLY_LIMIT - 1).ok === true);
t(`IP ${IP_HOURLY_LIMIT} 次 → 拒绝`, ipQuotaState(IP_HOURLY_LIMIT).ok === false);
t('IP 计数脏数据（undefined/NaN）当 0 处理', ipQuotaState(undefined).ok === true && ipQuotaState(NaN).ok === true);

// ───────────────────────── Cookie ─────────────────────────
sec('Cookie');
{
  const c = sessionCookie('deadbeef');
  t('HttpOnly', c.includes('HttpOnly'));
  t('Secure', c.includes('Secure'));
  t('SameSite=Lax', c.includes('SameSite=Lax'));
  t('Path=/', c.includes('Path=/'));
  t('30 天 Max-Age', c.includes('Max-Age=2592000'));
  t('清除用 Max-Age=0', clearCookie().includes('Max-Age=0'));
  const jar = parseCookies(`a=1; ${COOKIE_NAME}=tok%3Dvalue; b=2`);
  t('解析多个 Cookie', jar.a === '1' && jar.b === '2');
  t('解析 + 解码会话 token', jar[COOKIE_NAME] === 'tok=value');
  t('空头不炸', Object.keys(parseCookies('')).length === 0 && Object.keys(parseCookies(null)).length === 0);
}

// ───────────────────────── 哈希 ─────────────────────────
sec('哈希');
{
  const a = await sha256Hex('abc');
  t('SHA-256 结果与标准值一致', a === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', a);
  t('同输入同输出', a === (await sha256Hex('abc')));
  t('不同输入不同输出', a !== (await sha256Hex('abd')));
  t('哈希长度 64', a.length === 64);
}

console.log(`\n${'='.repeat(58)}\n通过 ${pass} · 失败 ${fail}`);
console.log('未覆盖（需要 D1，本脚本不 mock）：首次登录建号、会话写入与过期清理、发信通道分发。');
process.exit(fail ? 1 : 0);
