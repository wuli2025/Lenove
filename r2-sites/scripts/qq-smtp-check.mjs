/**
 * QQ SMTP 登录探针（本机诊断用，不进 Worker）。
 * 用法: node scripts/qq-smtp-check.mjs <邮箱> <授权码>
 * 只走到 AUTH 这一步（+一次 NOOP），不真发信。
 * 用来区分三种失败：
 *   A. 本机就连不上 465      → 运营商封端口（走 Worker 反而没事）
 *   B. 本机 535 / Worker 535 → 授权码错或 SMTP 服务没开
 *   C. 本机 235 / Worker 535 → QQ 对 Cloudflare 机房 IP 风控
 */
import tls from 'node:tls';

const [user, pass] = process.argv.slice(2);
if (!user || !pass) {
  console.error('用法: node scripts/qq-smtp-check.mjs <邮箱> <授权码>');
  process.exit(2);
}

const sock = tls.connect({ host: 'smtp.qq.com', port: 465, servername: 'smtp.qq.com' });
sock.setTimeout(15000);

let buf = '';
const lines = [];
sock.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\r\n')) >= 0) {
    lines.push(buf.slice(0, i));
    buf = buf.slice(i + 2);
  }
});

const waitLine = (pred) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = lines.findIndex(pred);
      if (hit >= 0) return resolve(lines.splice(0, hit + 1).join(' | '));
      if (Date.now() - t0 > 12000) return reject(new Error('等待回包超时'));
      setTimeout(tick, 50);
    };
    tick();
  });

const finalReply = () => waitLine((l) => /^\d{3} /.test(l));
const cmd = async (s, hide) => {
  sock.write(s + '\r\n');
  const r = await finalReply();
  console.log(`>> ${hide ?? s}\n<< ${r}`);
  return r;
};

try {
  await new Promise((res, rej) => {
    sock.once('secureConnect', res);
    sock.once('error', rej);
    sock.once('timeout', () => rej(new Error('TCP/TLS 连接超时（本机到 smtp.qq.com:465 不通）')));
  });
  console.log('<< TLS 已连接');
  console.log('<<', await finalReply());

  await cmd('EHLO qq-smtp-check.local');
  await cmd('AUTH LOGIN');
  await cmd(Buffer.from(user).toString('base64'), 'AUTH 用户名(base64)');
  const auth = await cmd(Buffer.from(pass).toString('base64'), 'AUTH 授权码(base64)');

  if (auth.startsWith('235')) {
    console.log('\n结论 C：本机登录成功（235）。Worker 那边 535 就是 QQ 对 Cloudflare IP 风控。');
    await cmd('QUIT');
  } else {
    console.log('\n结论 B：本机也 535 —— 授权码不对，或这个号的 SMTP 服务根本没开。');
    console.log('检查：QQ邮箱网页版 → 设置 → 账号 → POP3/IMAP/SMTP... → 开启服务 → 重新生成授权码。');
  }
} catch (e) {
  console.log('\n结论 A / 连接层失败：', e.message);
} finally {
  sock.destroy();
}
