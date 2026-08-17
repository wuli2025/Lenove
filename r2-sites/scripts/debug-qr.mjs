import { qrMatrix } from '../src/qr.js';

const text = process.argv[2] || 'HELLO';
const { size, version, modules } = qrMatrix(text);
console.log(`text=${JSON.stringify(text)}  V${version}  ${size}x${size}\n`);

// 列标尺
let head = '    ';
for (let c = 0; c < size; c++) head += (c % 10);
console.log(head);
for (let r = 0; r < size; r++) {
  let line = String(r).padStart(3) + ' ';
  for (let c = 0; c < size; c++) line += modules[r][c] ? '█' : '·';
  console.log(line);
}

// 结构自检
const chk = [];
const isFinder = (r0, c0) => {
  for (let r = 0; r < 7; r++)
    for (let c = 0; c < 7; c++) {
      const want = (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) ? 1 : 0;
      if (modules[r0 + r][c0 + c] !== want) return false;
    }
  return true;
};
chk.push(['定位图形 左上', isFinder(0, 0)]);
chk.push(['定位图形 右上', isFinder(0, size - 7)]);
chk.push(['定位图形 左下', isFinder(size - 7, 0)]);

let timingOk = true;
for (let i = 8; i < size - 8; i++) {
  if (modules[6][i] !== (i % 2 === 0 ? 1 : 0)) timingOk = false;
  if (modules[i][6] !== (i % 2 === 0 ? 1 : 0)) timingOk = false;
}
chk.push(['定时图形', timingOk]);
chk.push(['固定暗模块 (size-8,8)', modules[size - 8][8] === 1]);

console.log('');
for (const [k, v] of chk) console.log(`  ${v ? 'OK  ' : 'BAD '} ${k}`);
