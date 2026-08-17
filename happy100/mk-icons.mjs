import sharp from 'sharp';
import fs from 'node:fs';

const ROOT = 'D:/polaris/个人网站创作平台/happy100';
const ART  = `${ROOT}/www/art`;
const ASSETS = `${ROOT}/assets`;
fs.mkdirSync(ASSETS, { recursive: true });

const CREAM = { r: 0xFB, g: 0xF6, b: 0xEE, alpha: 1 };
const src = `${ART}/icon.jpg`;

// 1024 主图标（裁掉外围留白，让太阳更饱满）
const base = await sharp(src)
  .extract({ left: 40, top: 40, width: 944, height: 944 })
  .resize(1024, 1024, { fit: 'cover' })
  .png()
  .toBuffer();
fs.writeFileSync(`${ASSETS}/icon.png`, base);

// PWA / Apple 图标
for (const size of [32, 180, 192, 512]) {
  await sharp(base).resize(size, size).png().toFile(`${ART}/icon-${size}.png`);
}

// maskable：内容缩到 62%，四周补奶油底（安全区）
const inner = await sharp(base).resize(636, 636).png().toBuffer();
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: CREAM } })
  .composite([{ input: inner, gravity: 'center' }])
  .png().toFile(`${ART}/icon-maskable-512.png`);

// 启动图 2732x2732：奶油底 + 居中太阳
const splashIcon = await sharp(base).resize(760, 760).png().toBuffer();
await sharp({ create: { width: 2732, height: 2732, channels: 4, background: CREAM } })
  .composite([{ input: splashIcon, gravity: 'center' }])
  .png().toFile(`${ASSETS}/splash.png`);
fs.copyFileSync(`${ASSETS}/splash.png`, `${ASSETS}/splash-dark.png`);

// 顺手把大图压一压，减小包体
for (const n of ['hero', 'report', 'splash', 'celebrate', 'empty',
                 'cat-morning','cat-brain','cat-body','cat-emotion','cat-social','cat-home','cat-night']) {
  const p = `${ART}/${n}.jpg`;
  if (!fs.existsSync(p)) continue;
  const inBuf = fs.readFileSync(p);
  const buf = await sharp(inBuf).resize({ width: 900, withoutEnlargement: true }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
  fs.writeFileSync(p, buf);
}
fs.rmSync(`${ART}/icon.jpg`, { force: true });

console.log('icons + splash done');
for (const f of fs.readdirSync(ART)) {
  console.log(' ', f, (fs.statSync(`${ART}/${f}`).size / 1024).toFixed(0) + 'KB');
}
