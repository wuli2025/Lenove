/**
 * SMTP 登录探测 —— 只做认证握手，不发信。
 * 用来判断「这个邮箱能不能当验证码发送方」。
 *
 *   node scripts/smtp-probe.mjs <host> <port> <user> <pass>
 *
 * 密码只用于握手，不打印、不落盘。
 */
import net from 'node:net';
import tls from 'node:tls';

const [host, portStr, user, pass] = process.argv.slice(2);
if (!host || !portStr || !user || !pass) {
  console.error('用法: node scripts/smtp-probe.mjs <host> <port> <user> <pass>');
  process.exit(2);
}
const port = Number(portStr);

function makeConv(sock, label) {
  let buf = '';
  const waiters = [];
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    buf += d;
    // SMTP 多行响应以 "NNN " (空格) 结尾
    const lines = buf.split('\r\n').filter(Boolean);
    const last = lines[lines.length - 1];
    if (last && /^\d{3} /.test(last)) {
      const resp = buf;
      buf = '';
      const w = waiters.shift();
      if (w) w(resp.trim());
    }
  });
  return {
    // 必须带超时：国内到 587 端口常常是「TCP 能连、SMTP 不通」，
    // 中间设备把连接接下来但不转发，不设超时就永远挂在这里。
    expect: (ms = 12000) =>
      new Promise((res, rej) => {
        const t = setTimeout(() => {
          const i = waiters.indexOf(wrapped);
          if (i >= 0) waiters.splice(i, 1);
          rej(new Error(`等待响应超时（${ms}ms）；已收到的原始内容: ${JSON.stringify(buf)}`));
        }, ms);
        const wrapped = (r) => { clearTimeout(t); res(r); };
        waiters.push(wrapped);
      }),
    send: (line, redact) => {
      console.log(`  → ${redact ? '<已隐去>' : line}`);
      sock.write(line + '\r\n');
    },
  };
}

const show = (r) => r.split('\r\n').forEach((l) => console.log(`  ← ${l}`));

try {
  console.log(`连接 ${host}:${port} …`);
  const plain = net.connect({ host, port });
  await new Promise((res, rej) => {
    plain.once('connect', res);
    plain.once('error', rej);
    plain.setTimeout(15000, () => rej(new Error('连接超时')));
  });

  let c = makeConv(plain);
  show(await c.expect());

  c.send('EHLO probe.local');
  const ehlo1 = await c.expect();
  show(ehlo1);

  if (!/STARTTLS/i.test(ehlo1)) {
    console.log('\n结论: 服务器未声明 STARTTLS，无法安全认证。');
    process.exit(1);
  }

  c.send('STARTTLS');
  show(await c.expect());

  console.log('升级到 TLS …');
  const sec = tls.connect({ socket: plain, servername: host, rejectUnauthorized: true });
  await new Promise((res, rej) => {
    sec.once('secureConnect', res);
    sec.once('error', rej);
  });
  console.log(`  TLS 已建立: ${sec.getProtocol()}`);

  c = makeConv(sec);
  c.send('EHLO probe.local');
  const ehlo2 = await c.expect();
  show(ehlo2);

  const authLine = (ehlo2.split('\r\n').find((l) => /AUTH /i.test(l)) || '').trim();
  console.log(`\n服务器支持的认证方式: ${authLine || '（未声明 AUTH）'}`);

  if (!/LOGIN|PLAIN/i.test(authLine)) {
    console.log('\n结论: 服务器不接受用户名口令认证（只剩 OAuth2 之类），这个账号无法用密码直连发信。');
    sec.end();
    process.exit(1);
  }

  c.send('AUTH LOGIN');
  show(await c.expect());
  c.send(Buffer.from(user).toString('base64'));
  show(await c.expect());
  c.send(Buffer.from(pass).toString('base64'), true);
  const authResp = await c.expect();
  show(authResp);

  const ok = /^235/.test(authResp);
  console.log(`\n结论: ${ok ? '认证成功 —— 可以用作发信账号' : '认证失败'}`);
  sec.end();
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.log(`\n出错: ${e.message}`);
  process.exit(1);
}
