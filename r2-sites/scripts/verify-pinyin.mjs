/**
 * 中文姓名 → 拼音网址 的正确性验证。
 * 「看起来像拼音」不算数 —— slug 进了 D1 的 UNIQUE 列、又是路由的一部分，
 * 只要有一个不满足 SLUG_RE，现场那个人的作品页就是 404。
 *
 *   node scripts/verify-pinyin.mjs
 *
 * 这里跑三类断言：
 *   1) 结构断言：每个 slug 都匹配 SLUG_RE、长度合法、同一输入两次调用前缀稳定
 *   2) 内容断言：常见姓名的拼音要对（张三→zhangsan，不能是 zhangshan）
 *   3) 表自身的体检：查重（同一个字被塞进两个音节）、规模、体积
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { makeSlug } from '../src/api.js';
import { toPinyin, PINYIN_TABLE, PINYIN_SIZE } from '../src/pinyin.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 必须和 src/api.js 里的那条一模一样。下面有断言守着，改了那边这里会红。
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) pass++;
  else {
    fail++;
    failures.push(`${name}${detail ? '  ← ' + detail : ''}`);
  }
  return ok;
}

// ───────────────── 0. SLUG_RE 没跟 api.js 走散 ─────────────────
const apiSrc = readFileSync(join(ROOT, 'src', 'api.js'), 'utf8');
check(
  'SLUG_RE 与 src/api.js 保持一致',
  apiSrc.includes('/^[a-z0-9][a-z0-9-]{0,62}$/'),
  'api.js 里没找到同样的正则，规则可能被改动了'
);

// ───────────────── 1. 映射表自身体检 ─────────────────
{
  const seen = new Map(); // 字 → 第一次出现的音节
  const dups = [];
  const badSyllable = [];
  for (const seg of PINYIN_TABLE.split(/\s+/)) {
    if (!seg) continue;
    const i = seg.indexOf(':');
    if (i <= 0) {
      badSyllable.push(seg);
      continue;
    }
    const py = seg.slice(0, i);
    if (!/^[a-z]{1,6}$/.test(py)) badSyllable.push(seg);
    for (const ch of seg.slice(i + 1)) {
      if (!/[一-鿿]/.test(ch)) {
        badSyllable.push(`${py}:${ch}(非汉字)`);
        continue;
      }
      if (seen.has(ch)) dups.push(`${ch} 同时出现在 ${seen.get(ch)} 和 ${py}`);
      else seen.set(ch, py);
    }
  }
  check('映射表无重复汉字', dups.length === 0, dups.slice(0, 8).join(' / '));
  check('映射表无畸形条目', badSyllable.length === 0, badSyllable.slice(0, 8).join(' / '));
  check('映射表规模 ≥ 900 字', PINYIN_SIZE >= 900, `实际 ${PINYIN_SIZE} 字`);

  const raw = readFileSync(join(ROOT, 'src', 'pinyin.js'));
  const gz = gzipSync(raw).length;
  check('src/pinyin.js gzip 后 < 15KB', gz < 15 * 1024, `实际 ${(gz / 1024).toFixed(2)} KB`);
  console.log(
    `映射表：${PINYIN_SIZE} 字 / ${new Set([...seen.values()]).size} 个音节　` +
      `源码 ${(raw.length / 1024).toFixed(1)} KB → gzip ${(gz / 1024).toFixed(2)} KB\n`
  );
}

// ───────────────── 2. 姓名用例 ─────────────────
// expect = 期望的 slug 前缀（不含 -<hash> 那 5 位）；null 表示只做结构检查
const CASES = [
  // ── 最常见的占位名 ──
  ['张三', 'zhangsan'],
  ['李四', 'lisi'],
  ['王五', 'wangwu'],
  ['赵六', 'zhaoliu'],
  ['钱七', 'qianqi'],
  ['孙八', 'sunba'],
  // ── 三字名 ──
  ['李小明', 'lixiaoming'],
  ['罗建国', 'luojianguo'],
  ['梁建军', 'liangjianjun'],
  ['宋桂英', 'songguiying'],
  ['郑文志', 'zhengwenzhi'],
  ['刘秀英', 'liuxiuying'],
  ['谢梓涵', 'xiezihan'],
  ['韩一诺', 'hanyinuo'],
  ['冯欣怡', 'fengxinyi'],
  ['唐雨轩', 'tangyuxuan'],
  ['董子文', 'dongziwen'],
  ['翟志刚', 'zhaizhigang'],
  // ── 两字名（人名高频字）──
  ['张伟', 'zhangwei'],
  ['王芳', 'wangfang'],
  ['李娜', 'lina'],
  ['陈敏', 'chenmin'],
  ['杨静', 'yangjing'],
  ['黄丽', 'huangli'],
  ['周强', 'zhouqiang'],
  ['吴磊', 'wulei'],
  ['徐洋', 'xuyang'],
  ['孙艳', 'sunyan'],
  ['马勇', 'mayong'],
  ['朱军', 'zhujun'],
  ['胡杰', 'hujie'],
  ['郭娟', 'guojuan'],
  ['何涛', 'hetao'],
  ['高超', 'gaochao'],
  ['林霞', 'linxia'],
  ['沈平', 'shenping'],
  // ── 复姓 ──
  ['欧阳修', 'ouyangxiu'],
  ['司马光', 'simaguang'],
  ['诸葛亮', 'zhugeliang'],
  ['上官婉儿', 'shangguanwaner'],
  ['令狐冲', 'linghuchong'],
  ['夏侯惇', 'xiahou'], // 惇 不在表里 —— 缺字直接消失，不吐问号
  // ── 姓氏优先的多音字（重点回归区）──
  ['单雄信', 'shanxiongxin'], // 单 shan 不是 dan
  ['解晓东', 'xiexiaodong'], // 解 xie 不是 jie
  ['仇英', 'qiuying'], // 仇 qiu 不是 chou
  ['区文伟', 'ouwenwei'], // 区 ou 不是 qu
  ['朴智星', 'piaozhixing'], // 朴 piao 不是 pu
  ['覃海洋', 'qinhaiyang'], // 覃 qin 不是 tan
  ['查文斌', 'zhawenbin'], // 查 zha 不是 cha
  ['乐嘉', 'yuejia'], // 乐 yue 不是 le
  ['曾志伟', 'zengzhiwei'], // 曾 zeng 不是 ceng
  ['重耳', 'chonger'], // 重 chong 不是 zhong
  ['繁钦', 'poqin'], // 繁 po 不是 fan
  ['华罗庚', 'hualuogeng'], // 华 hua
  ['秘彦杰', 'biyanjie'], // 秘 bi 不是 mi
  ['种师道', 'chongshidao'], // 种 chong 不是 zhong
  ['谌龙', 'chenlong'], // 谌 chen 不是 shen
  // ── 四字名 / 超长 ──
  ['萧十一郎', 'xiaoshiyilang'],
  ['爱新觉罗溥仪', 'aixinjueluopuyi'],
  ['张三李四王五赵六钱七孙八', 'zhangsanlisiwangwuzhaoli'], // 24 字符处硬截断
  // ── 中英混合 / 纯英文 / 空格 ──
  ['Anna 李', 'anna-li'],
  ['李 Anna', 'li-anna'],
  ['John Smith', 'john-smith'],
  ['Lin', 'lin'],
  ['  张   三  ', 'zhang-san'], // 首尾空格被收边，中间空格变连字符
  ['张三 · 设计师', 'zhangsan-shejishi'], // 中点这类标点整段塌缩成一个连字符
  // ── 兜底路径 ──
  ['🎉🎉🎉', null],
  ['', null],
  ['!!!???', null],
  ['龘龘', null], // 生僻字整体查不到 → 退回 w-
  // emoji 夹在中间：代理对不能被劈开（劈开会漏出半个码位、正则也拦不住），
  // 它作为「非汉字」原样穿过 toPinyin，再被规范化成一个连字符 → zhang-san
  ['张🎉三', 'zhang-san'],
  ['张龘三', 'zhangsan'], // 缺字消失，前后拼音仍要接上
  ['ZHANG三', 'zhangsan'], // 大写 ASCII 要降小写
  ['张三2026', 'zhangsan2026'],
  ['---张三---', 'zhangsan'], // 连字符不能漏到首尾
];

const rows = [];
for (const [creator, expect] of CASES) {
  const label = JSON.stringify(creator);
  const slug = makeSlug(creator, '我的第一个网站');
  const again = makeSlug(creator, '我的第一个网站');

  const okRe = SLUG_RE.test(slug);
  const okLen = slug.length >= 3 && slug.length <= 63;
  // 前缀 = 去掉末尾 -<hash>；hash 里掺了 Date.now()，所以只有前缀该稳定
  const prefix = slug.slice(0, slug.lastIndexOf('-'));
  const okStable = prefix === again.slice(0, again.lastIndexOf('-'));
  const okExpect = expect === null ? slug.startsWith('w-') : prefix === expect;

  const ok = okRe && okLen && okStable && okExpect;
  if (ok) pass++;
  else {
    fail++;
    const why = [];
    if (!okRe) why.push('不匹配 SLUG_RE');
    if (!okLen) why.push(`长度 ${slug.length}`);
    if (!okStable) why.push('前缀不稳定');
    if (!okExpect) why.push(`期望前缀 ${expect === null ? 'w-' : expect}`);
    failures.push(`${label} → ${slug}  ← ${why.join(' / ')}`);
  }

  rows.push(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(20)} → ${slug.padEnd(32)} 拼音=${JSON.stringify(toPinyin(creator))}`
  );
}

console.log(rows.join('\n'));

// ───────────────── 3. 全表扫一遍，确保没有字能产出非法 slug ─────────────────
{
  let bad = 0;
  for (const [ch] of [...PINYIN_TABLE.matchAll(/[一-鿿]/g)]) {
    const s = makeSlug(ch + ch, 't');
    if (!SLUG_RE.test(s)) {
      bad++;
      if (bad <= 5) console.log(`\n  FAIL  单字 ${ch} 产出非法 slug: ${s}`);
    }
  }
  check(`表内每个字单独成名都能产出合法 slug`, bad === 0, `${bad} 个字失败`);
}

// ───────────────── 4. 随机 fuzz：任意 Unicode 垃圾输入也不能崩 ─────────────────
{
  let seed = 20260813;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const POOL = '张三李四王五abcXYZ019-_. ​\t中文𝕏🎉🀄️龘 �';
  let bad = 0;
  for (let t = 0; t < 500; t++) {
    let s = '';
    const len = Math.floor(rnd() * 40);
    for (let i = 0; i < len; i++) s += POOL[Math.floor(rnd() * POOL.length)];
    try {
      const slug = makeSlug(s, 'x');
      if (!SLUG_RE.test(slug) || slug.length > 63) {
        bad++;
        if (bad <= 5) console.log(`\n  FUZZ FAIL  ${JSON.stringify(s)} → ${slug}`);
      }
    } catch (e) {
      bad++;
      if (bad <= 5) console.log(`\n  FUZZ FAIL  ${JSON.stringify(s)} 抛异常: ${e.message}`);
    }
  }
  check('fuzz 500 次全部产出合法 slug', bad === 0, `${bad} 次失败`);
}

// ───────────────── 汇总 ─────────────────
console.log(`\n用例 ${CASES.length} 条　断言通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  ' + f);
}
console.log(fail === 0 ? '\n全部通过 ✔' : `\n有 ${fail} 项失败 ✘`);
process.exit(fail === 0 ? 0 : 1);
