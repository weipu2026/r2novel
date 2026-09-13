/* css-lint.test.mjs — style.css 的「注释完整性 / 括号平衡 / 中文不得漏在注释外」检查
 *
 * 背景（真实事故）：一次「只改注释文案」的编辑让注释被结束标记提前闭合，后面的说明文字
 * 变成裸 CSS 文本，浏览器解析到那儿报错并**跳过了紧随其后的那条规则**
 * （正是手机端「进度角标不与右下角 ⋯ 叠字」的 padding-right）。
 * 花括号计数是平衡的、单测全绿、dry-run 也正常 —— 但手机上角标就压在 ⋯ 上了。
 * 这类事故没有运行时症状，只能靠静态检查拦：本测试就是那道闸。
 *
 * 四条断言：
 *  1. 注释必须成对：不允许出现孤立的结束标记，也不允许文件结束时注释未闭合。
 *  2. 剥离注释后花括号必须平衡（且过程中不得出现负深度）。
 *  3. 剥离注释与字符串后不得残留 CJK 字符 —— 中文只允许出现在注释或引号内
 *     （content:/font-family 等）。漏在注释外的中文＝必然的解析事故。
 *  4. 「角标让位」那条关键规则必须存在且让位够宽（纯静态也算得出净空）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS = path.join(ROOT, 'public', 'css', 'style.css');

/** 逐字符剥离注释；返回 { code, comments, errors } */
function stripComments(src) {
  let out = '';
  let i = 0;
  const comments = [];
  const errors = [];
  while (i < src.length) {
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) {
        errors.push({ kind: '未闭合注释', at: i });
        comments.push(src.slice(i));
        break;
      }
      comments.push(src.slice(i + 2, end));
      i = end + 2;
      continue;
    }
    if (src.startsWith('*/', i)) {
      errors.push({ kind: '无主 */', at: i });
      i += 2;
      continue;
    }
    out += src[i++];
  }
  return { code: out, comments, errors };
}

/** 行号（1 基）便于定位 */
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

test('style.css：注释必须成对（无主的 */ 与未闭合注释都会被解析器吞掉后续规则）', () => {
  const src = fs.readFileSync(CSS, 'utf8');
  const { errors } = stripComments(src);
  assert.deepEqual(
    errors.map((e) => e.kind + '@第' + lineOf(src, e.at) + '行'),
    [],
    '注释结构损坏：' + errors.map((e) => e.kind + '@第' + lineOf(src, e.at) + '行').join('、')
  );
});

test('style.css：剥离注释后花括号平衡、不出现负深度', () => {
  const src = fs.readFileSync(CSS, 'utf8');
  const { code } = stripComments(src);
  let depth = 0;
  let min = 0;
  for (const ch of code) {
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth < min) min = depth; }
  }
  assert.equal(min, 0, '出现多余的 }');
  assert.equal(depth, 0, '花括号不平衡，差 ' + depth + ' 个 }');
});

test('style.css：中文只能出现在注释或引号内（漏在注释外＝解析事故）', () => {
  const src = fs.readFileSync(CSS, 'utf8');
  const { code } = stripComments(src);
  // 先去掉引号内的内容（content: '…' / font-family: "…" 里的中文是合法的）
  const noStrings = code.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  // 覆盖：通用标点/破折号省略号、CJK 符号与标点、扩展 A、基本区、全角形式。
  // 通用标点那一段是必要的 —— 说明文字常常是「—— 或 … 打头」而没有一个汉字。
  const CJK = /[ -⁯　-〿㐀-䶿一-鿿＀-￯]/;
  const hits = [];
  noStrings.split('\n').forEach((line, i) => {
    if (CJK.test(line)) hits.push('第' + (i + 1) + '行: ' + line.trim().slice(0, 60));
  });
  assert.deepEqual(hits, [], '注释外出现中文（会把后续规则一起带崩）：\n' + hits.join('\n'));
});

test('style.css：关键规则必须真的在文件里且注释不会吞掉它', () => {
  const src = fs.readFileSync(CSS, 'utf8');
  const { code } = stripComments(src);

  // 手机端「角标让位给右下角 ⋯」的唯一保障：漏了它角标就会压在 ⋯ 上（已发生过一次）
  const padRule = /\.card:not\(\.picking\) \.card-meta-row\s*\{[^}]*padding-right:\s*(\d+)px/.exec(code);
  assert.ok(padRule, '缺少 .card-meta-row 的 padding-right 让位规则');
  // ⋯ 必须定宽，否则按钮随字号长大，下面的算式就不成立
  const moreWidth = /\.card \.card-more\s*\{[^}]*width:\s*(\d+)px/.exec(code);
  assert.ok(moreWidth, '⋯ 按钮必须定宽（缺 width: Npx）');
  const moreRight = /\.card \.card-more\s*\{[^}]*right:\s*(\d+)px/.exec(code);
  assert.ok(moreRight, '⋯ 按钮缺少 right 偏移');
  // 卡片在手机端的右内边距（.card { padding: 10px 12px } → 12px）
  const cardPadMobile = /\.card \{[^}]*padding:\s*10px\s+(\d+)px/.exec(code);
  assert.ok(cardPadMobile, '未找到手机端 .card 的右内边距');

  // 全部从 CSS 现解析，不写死数字 —— 否则改了 ⋯ 宽度，这里会假装通过
  const reserved = Number(padRule[1]);
  const W = Number(moreWidth[1]);
  const rightOff = Number(moreRight[1]);
  const cardPadR = Number(cardPadMobile[1]);
  // 净空 = 行内容右界(卡片 padding + reserved) 与 ⋯ 左界(右偏 + 宽) 之差。
  // 门槛 12px：8px 量级正是「看着像贴上了」的距离（上一版 34px 让位就只剩 8px），
  // 不能算过。
  const clearance = reserved + cardPadR - (rightOff + W);
  assert.ok(
    clearance >= 12,
    '角标与 ⋯ 的净空只有 ' + clearance + 'px（需 ≥12px：padding-right=' + reserved +
      '、⋯ 宽=' + W + '、右偏=' + rightOff + '、卡片 padding=' + cardPadR + '）'
  );
});

test('style.css × app.js：角标「长/短双文案」的显隐规则必须配套', () => {
  const css = stripComments(fs.readFileSync(CSS, 'utf8')).code;
  const js = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  // 无角标（默认＝桌面）显长、手机显短；两个类缺一不可
  assert.match(css, /\.card \.prog-badge \.pb-compact\s*\{\s*display:\s*none;?\s*\}/, '缺少 pb-compact 的默认隐藏规则');
  assert.match(css, /\.pb-full\s*\{\s*display:\s*none;?\s*\}/, '缺少手机上隐藏 pb-full 的规则');
  assert.match(css, /\.pb-compact\s*\{\s*display:\s*inline;?\s*\}/, '缺少手机上显示 pb-compact 的规则');
  // JS 必须真的产出这两个类名（改名只改一边会静默退化成「角标空白」）
  assert.match(js, /className\s*=\s*'pb-full'/, 'app.js 未生成 .pb-full');
  assert.match(js, /className\s*=\s*'pb-compact'/, 'app.js 未生成 .pb-compact');
  assert.match(js, /progBadgeText\(b,\s*true\)/, 'app.js 未取用紧凑文案');
});
