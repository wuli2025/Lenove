/**
 * 零依赖 QR 码生成（byte 模式 · ECC Level M · Version 1–15）
 *
 * Worker 里不能装 npm 包，海报又必须带一个真能扫的二维码，所以自己实现。
 * 覆盖到 V15 = 415 字节数据，URL 场景绰绰有余（实际用到的都在 V3–V5）。
 *
 * 正确性不能靠"看起来像"——本模块配套 scripts/verify-qr.mjs，
 * 用 jsQR 真解码回来逐字比对。
 */

// ── ECC Level M 参数表 [每块EC码字, 组1块数, 组1数据码字, 组2块数, 组2数据码字] ──
const EC_M = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
  11: [30, 1, 50, 4, 51],
  12: [22, 6, 36, 2, 37],
  13: [22, 8, 37, 1, 38],
  14: [24, 4, 40, 5, 41],
  15: [24, 5, 41, 5, 42],
};

// ── 校正图形中心坐标 ──
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62],
  14: [6, 26, 46, 66], 15: [6, 26, 48, 70],
};

// ───────────────────── GF(256) 伽罗华域 ─────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // 本原多项式
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** 生成多项式 g(x) = ∏(x - α^i) */
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon 纠错码字 */
function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Uint8Array(data.length + ecLen);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = res[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      res[i + j] ^= gfMul(gen[j], factor);
    }
  }
  return res.slice(data.length);
}

// ───────────────────── BCH（格式信息 / 版本信息）─────────────────────
function bch(value, poly, bits) {
  let v = value << bits;
  const polyBits = 32 - Math.clz32(poly);
  while (32 - Math.clz32(v) >= polyBits) {
    v ^= poly << (32 - Math.clz32(v) - polyBits);
  }
  return (value << bits) | v;
}

// ───────────────────── 数据编码 ─────────────────────
class BitBuffer {
  constructor() {
    this.bytes = [];
    this.len = 0;
  }
  put(value, bits) {
    for (let i = bits - 1; i >= 0; i--) this.putBit(((value >>> i) & 1) === 1);
  }
  putBit(b) {
    const idx = this.len >>> 3;
    if (this.bytes.length <= idx) this.bytes.push(0);
    if (b) this.bytes[idx] |= 0x80 >>> (this.len & 7);
    this.len++;
  }
}

function pickVersion(byteLen) {
  for (let v = 1; v <= 15; v++) {
    const [ecLen, g1, d1, g2, d2] = EC_M[v];
    const dataCodewords = g1 * d1 + g2 * d2;
    const countBits = v <= 9 ? 8 : 16;
    const needBits = 4 + countBits + byteLen * 8;
    if (needBits <= dataCodewords * 8) return v;
  }
  throw new Error(`QR: 数据过长（${byteLen} 字节），本实现最大支持 V15/ECC-M`);
}

function buildCodewords(bytes, version) {
  const [ecLen, g1, d1, g2, d2] = EC_M[version];
  const totalData = g1 * d1 + g2 * d2;
  const countBits = version <= 9 ? 8 : 16;

  const bb = new BitBuffer();
  bb.put(0b0100, 4); // byte 模式
  bb.put(bytes.length, countBits);
  for (const b of bytes) bb.put(b, 8);

  // 终止符（最多 4 bit）
  const remain = totalData * 8 - bb.len;
  bb.put(0, Math.min(4, remain));
  // 补到字节边界
  while (bb.len % 8 !== 0) bb.putBit(false);
  // 填充码字
  const pad = [0xec, 0x11];
  let p = 0;
  while (bb.bytes.length < totalData) bb.bytes.push(pad[p++ % 2]);

  // 分块
  const blocks = [];
  let off = 0;
  for (let i = 0; i < g1; i++) {
    blocks.push(bb.bytes.slice(off, off + d1));
    off += d1;
  }
  for (let i = 0; i < g2; i++) {
    blocks.push(bb.bytes.slice(off, off + d2));
    off += d2;
  }
  const ecBlocks = blocks.map((b) => rsEncode(Uint8Array.from(b), ecLen));

  // 交织
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const b of ecBlocks) out.push(b[i]);
  }
  return out;
}

// ───────────────────── 矩阵构建 ─────────────────────
function buildMatrix(version, codewords) {
  const size = version * 4 + 17;
  // null = 未占用（数据区），其余为 0/1
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false)); // 功能图形标记

  const setFn = (r, c, v) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    m[r][c] = v;
    fn[r][c] = true;
  };

  // 定位图形 + 分隔符
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark = inner && ((r === 0 || r === 6 || c === 0 || c === 6) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        setFn(r0 + r, c0 + c, dark ? 1 : 0);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // 定时图形
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    setFn(6, i, v);
    setFn(i, 6, v);
  }

  // 校正图形
  const centers = ALIGN[version];
  for (const r of centers) {
    for (const c of centers) {
      // 跳过与定位图形重叠的三处
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFn(r + dr, c + dc, dark ? 1 : 0);
        }
      }
    }
  }

  // 固定的暗模块
  setFn(size - 8, 8, 1);

  // 预留格式信息位
  for (let i = 0; i < 9; i++) {
    if (!fn[8][i]) setFn(8, i, 0);
    if (!fn[i][8]) setFn(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    if (!fn[8][size - 1 - i]) setFn(8, size - 1 - i, 0);
    if (!fn[size - 1 - i][8]) setFn(size - 1 - i, 8, 0);
  }

  // 版本信息（V7+）
  if (version >= 7) {
    const vinfo = bch(version, 0x1f25, 12);
    for (let i = 0; i < 18; i++) {
      const bit = (vinfo >>> i) & 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      setFn(r, c, bit);
      setFn(c, r, bit);
    }
  }

  // 数据位按之字形填入
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  let col = size - 1;
  let upward = true;
  while (col > 0) {
    if (col === 6) col--; // 跳过垂直定时列
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let j = 0; j < 2; j++) {
        const c = col - j;
        if (fn[row][c]) continue;
        let bit = 0;
        if (bitIdx < totalBits) {
          bit = (codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1;
          bitIdx++;
        }
        m[row][c] = bit;
      }
    }
    col -= 2;
    upward = !upward;
  }

  return { size, m, fn };
}

// ───────────────────── 掩码 ─────────────────────
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMaskAndFormat(base, maskId) {
  const { size, m, fn } = base;
  const grid = m.map((row) => row.slice());
  const mask = MASKS[maskId];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!fn[r][c] && mask(r, c)) grid[r][c] ^= 1;
    }
  }

  // 格式信息：ECC-M = 00，与 mask 组成 5 bit，BCH(15,5)，再异或 0x5412
  const fmt = (bch((0b00 << 3) | maskId, 0x537, 10) ^ 0x5412) & 0x7fff;
  for (let i = 0; i < 15; i++) {
    // ⚠ MSB 先放：i=0 取的是 bit14。写成 (fmt >>> i) 会得到整串倒序的格式信息，
    //   矩阵结构看着完全正常、扫描器却一个都读不出来（已实测踩过）。
    const bit = (fmt >>> (14 - i)) & 1;
    // 第一份：横排在左上，再折上去
    if (i < 6) grid[8][i] = bit;
    else if (i === 6) grid[8][7] = bit;
    else if (i === 7) grid[8][8] = bit;
    else if (i === 8) grid[7][8] = bit;
    else grid[14 - i][8] = bit;
    // 第二份：前 7 位走左下竖列，后 8 位走右上横行
    if (i < 7) grid[size - 1 - i][8] = bit;
    else grid[8][size - 15 + i] = bit;
  }
  grid[size - 8][8] = 1; // 固定暗模块

  return grid;
}

/** 掩码惩罚分（ISO 18004 四条规则） */
function penalty(grid, size) {
  let score = 0;

  // 规则1：同色连续 ≥5
  for (let i = 0; i < size; i++) {
    for (const isRow of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const a = isRow ? grid[i][j] : grid[j][i];
        const b = isRow ? grid[i][j - 1] : grid[j - 1][i];
        if (a === b) run++;
        else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
    }
  }

  // 规则2：2×2 同色块
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3;
    }
  }

  // 规则3：1:1:3:1:1 模式（含四周空白）
  const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const match = (arr, pat) => pat.every((v, k) => arr[k] === v);
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 11; j++) {
      const row = [], colv = [];
      for (let k = 0; k < 11; k++) {
        row.push(grid[i][j + k]);
        colv.push(grid[j + k][i]);
      }
      if (match(row, P1) || match(row, P2)) score += 40;
      if (match(colv, P1) || match(colv, P2)) score += 40;
    }
  }

  // 规则4：暗模块占比偏离 50%
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += grid[r][c];
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;

  return score;
}

// ───────────────────── 对外 API ─────────────────────

/**
 * 文本 → QR 模块矩阵（0/1 二维数组）
 * opts.forceMask / opts.forceVersion 仅供比对调试用，正常调用不要传。
 */
export function qrMatrix(text, opts = {}) {
  const bytes = new TextEncoder().encode(text);
  const version = opts.forceVersion || pickVersion(bytes.length);
  const codewords = buildCodewords(bytes, version);
  const base = buildMatrix(version, codewords);

  if (opts.forceMask != null) {
    return { size: base.size, version, mask: opts.forceMask, modules: applyMaskAndFormat(base, opts.forceMask) };
  }

  let best = null;
  let bestMask = 0;
  let bestScore = Infinity;
  for (let maskId = 0; maskId < 8; maskId++) {
    const grid = applyMaskAndFormat(base, maskId);
    const s = penalty(grid, base.size);
    if (s < bestScore) {
      bestScore = s;
      best = grid;
      bestMask = maskId;
    }
  }
  return { size: base.size, version, mask: bestMask, modules: best };
}

/**
 * 文本 → SVG 字符串。
 * quiet 为静默区模块数（标准要求 4，低于 4 会显著降低识别率）。
 */
export function qrSvg(text, { size = 240, quiet = 4, dark = '#04070d', light = '#ffffff', radius = 0 } = {}) {
  const { size: n, modules } = qrMatrix(text);
  const total = n + quiet * 2;
  const parts = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (modules[r][c]) parts.push(`M${c + quiet} ${r + quiet}h1v1h-1z`);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="${light}"${radius ? ` rx="${radius}"` : ''}/>` +
    `<path fill="${dark}" d="${parts.join('')}"/>` +
    `</svg>`
  );
}
