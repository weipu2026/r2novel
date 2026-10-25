/* review-fix148.test.mjs — UI 评审 v2 三个梯队的回归（①可达性 / ②结构 / ③系统化）
 *
 * 为什么这么测：
 *   · ①的色值不是「看着舒服」而是「算得出来」—— 直接读真实 style.css 的令牌值，
 *     用 WCAG 相对亮度公式复算比值。改回旧值必然翻红，不靠"源码里出现过某字符串"。
 *   · ②的标签云折叠是有状态的行为（展开/收起/选中项保留），把 renderTagCloud 从源码
 *     抽出后**真跑** DOM 桩，断言 chip 数量、文案、aria-expanded 与"不重跑网格"。
 *   · 版心（1180）与焦点环（outline 实际生效）依赖真实布局/计算样式，单测无法诚实覆盖，
 *     由 .ui-tests/audit-focus.mjs（真机 Tab 逐跳 + 五档视口测量）守。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, El, NOP } from './_dom-stub.mjs';

installDom();

const APP_SRC = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');

/** 抽出顶层函数声明（按花括号配平，不用固定字符窗口） */
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '源码里找不到 function ' + name);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (!depth) return src.slice(start, i + 1);
    }
  }
  throw new Error('花括号未配平: ' + name);
}

/* ════════════ WCAG 对比度工具（与 .ui-tests/contrast-calc.mjs 同一套公式） ════════════ */
const rgb = (h) => h.replace('#', '').match(/../g).map((x) => parseInt(x, 16));
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (h) => { const [r, g, b] = rgb(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const ratio = (a, b) => {
  const [x, y] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
  return (x + 0.05) / (y + 0.05);
};

/** 取 :root 里某个令牌的原始定义值（不解析 var） */
function cssDecl(name) {
  const m = CSS.match(new RegExp('--' + name + ':\\s*([^;]+);'));
  assert.ok(m, `:root 缺少令牌 --${name}`);
  return m[1].trim();
}
/** 取 :root 里某个令牌的色值定义（只认「定义」，不认 var() 引用处） */
function token(name) {
  const v = cssDecl(name);
  assert.match(v, /^#[0-9a-fA-F]{6}$/, `--${name} 不是纯色：${v}`);
  return v;
}
/** 取一条规则块的正文（选择器必须唯一，按花括号配平） */
function ruleBody(sel) {
  const at = CSS.indexOf(sel + ' {');
  assert.ok(at >= 0, `找不到规则：${sel}`);
  const open = CSS.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < CSS.length; i++) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}') { depth--; if (!depth) return CSS.slice(open + 1, i); }
  }
  throw new Error('花括号未配平：' + sel);
}
/** 取规则块里某个属性的最终色值（var(--x) 会解析到 :root 定义） */
function declColor(sel, prop = 'color') {
  const body = ruleBody(sel);
  const m = body.match(new RegExp('(?:^|[;\\n])\\s*' + prop + ':\\s*([^;]+);'));
  assert.ok(m, `${sel} 里没有 ${prop} 声明`);
  const v = m[1].trim();
  const ref = v.match(/^var\(--([a-z0-9-]+)\)$/i);
  if (ref) return token(ref[1]);
  assert.match(v, /^#[0-9a-fA-F]{6}$/, `${sel} 的 ${prop} 不是纯色：${v}`);
  return v;
}

/* ════════════ ① 对比度：4 个色值 + 金色 chip + 伪封面 ════════════ */

test('①-1 --muted 在白底 / --bg / 浅底上都过 AA 4.5（旧 #7d7d75 白底仅 4.15）', () => {
  const muted = token('muted');
  assert.ok(ratio(muted, '#ffffff') >= 4.5, `白底 ${ratio(muted, '#ffffff').toFixed(2)}`);
  assert.ok(ratio(muted, token('bg')) >= 4.5, `--bg ${ratio(muted, token('bg')).toFixed(2)}`);
  assert.ok(ratio(muted, token('surface-1')) >= 4.5, `--surface-1 ${ratio(muted, token('surface-1')).toFixed(2)}`);
  assert.ok(ratio(muted, token('surface-2')) >= 4.5, `--surface-2 ${ratio(muted, token('surface-2')).toFixed(2)}`);
});

test('①-2 --accent 双向达标：作底色配白字 / 作文字压白底与 --bg（旧 #b3692e 仅 4.22）', () => {
  const accent = token('accent');
  assert.ok(ratio('#ffffff', accent) >= 4.5, `白字作底 ${ratio('#ffffff', accent).toFixed(2)}`);
  assert.ok(ratio(accent, '#ffffff') >= 4.5, `作文字白底 ${ratio(accent, '#ffffff').toFixed(2)}`);
  assert.ok(ratio(accent, token('bg')) >= 4.5, `作文字 --bg ${ratio(accent, token('bg')).toFixed(2)}`);
});

test('①-3 --mark 作图形过 3.0，--mark-ink 作文字/金底过 4.5（旧 #d9a01f 仅 2.33）', () => {
  const mark = token('mark');
  assert.ok(ratio(mark, '#ffffff') >= 3.0, `mark 白底 ${ratio(mark, '#ffffff').toFixed(2)}`);
  assert.ok(ratio(mark, token('bg')) >= 3.0, `mark --bg ${ratio(mark, token('bg')).toFixed(2)}`);
  const ink = token('mark-ink');
  assert.ok(ratio(ink, '#ffffff') >= 4.5, `mark-ink 作文字 ${ratio(ink, '#ffffff').toFixed(2)}`);
  assert.ok(ratio('#ffffff', ink) >= 4.5, `mark-ink 作底配白字 ${ratio('#ffffff', ink).toFixed(2)}`);
});

test('①-4 金色 chip 两态都走令牌且过 4.5（硬编码 #a97c1a 3.76 / #e0b23c 白字 1.9）', () => {
  const idle = declColor('.tagcloud button.star-chip');
  assert.ok(ratio(idle, '#ffffff') >= 4.5, `未选中文字 ${ratio(idle, '#ffffff').toFixed(2)}`);
  const onBg = declColor('.tagcloud button.star-chip.on', 'background');
  assert.ok(ratio('#ffffff', onBg) >= 4.5, `选中态白字 ${ratio('#ffffff', onBg).toFixed(2)}`);
});

test('①-5 浅底上的两处 --accent 文字改走 --accent-ink（--accent 压 accent-weak 只有 3.90）', () => {
  const weak = token('accent-weak');
  assert.ok(ratio(token('accent'), weak) < 4.5, '前提校验：--accent 直接压在 accent-weak 上确实不达标');
  for (const sel of ['.diag-tag', '.side-toc .toc-item.cur']) {
    const c = declColor(sel);
    assert.ok(ratio(c, weak) >= 4.5, `${sel} 在 accent-weak 上 ${ratio(c, weak).toFixed(2)}`);
  }
});

test('①-6 伪封面 8 色配白字全过 3.0（第 7 色旧 #d0a43a 仅 2.32）', () => {
  const m = APP_SRC.match(/const PALETTE = \[([^\]]+)\]/);
  assert.ok(m, '找不到 PALETTE');
  const colors = m[1].match(/#[0-9a-fA-F]{6}/g);
  assert.equal(colors.length, 8, 'PALETTE 必须是 8 色（同书同色的辨识度靠这 8 档）');
  for (const c of colors) {
    const r = ratio('#ffffff', c);
    assert.ok(r >= 3.0, `${c} 白字 ${r.toFixed(2)}`);
  }
});

/* ════════════ ① 焦点环：令牌 + 规则形状 ════════════ */

test('①-7 焦点环令牌随主色走，且规则带 !important（否则被 8 处 outline:none 压过）', () => {
  assert.equal(cssDecl('focus-ring'), '2px solid var(--accent)', '焦点环颜色必须跟随 --accent');
  assert.equal(cssDecl('focus-offset'), '2px', '焦点环需 2px 留白');
  const rule = CSS.match(/:focus-visible\s*\{([\s\S]*?)\}/);
  assert.ok(rule, '缺少 :focus-visible 规则');
  assert.match(rule[1], /outline:\s*var\(--focus-ring\)\s*!important;/, ':focus-visible 必须 !important');
  assert.match(rule[1], /outline-offset:\s*var\(--focus-offset\);/, ':focus-visible 需带 offset');
});

test('①-8 焦点环用 outline 而非 box-shadow（卡片自带 .pinned/.picked 阴影语义，不能被覆盖）', () => {
  const rule = CSS.match(/:focus-visible\s*\{([\s\S]*?)\}/);
  assert.ok(rule);
  assert.ok(!/box-shadow/.test(rule[1]), ':focus-visible 不得用 box-shadow —— 会覆盖置顶金条/勾选光环');
});

/* ════════════ ② 标签云折叠：真跑 renderTagCloud ════════════ */

const TAG_MAX = Number(APP_SRC.match(/const TAG_CLOUD_MAX = (\d+);/)[1]);

function makeCloud(total) {
  const tags = Array.from({ length: total }, (_, i) => [`标签${String(i + 1).padStart(2, '0')}`, total - i]);
  const els = { tagCloud: new El('div') };
  const ui = { tag: '', finished: '', star: false, tagsMore: false };
  const calls = { shelf: 0 };
  const docEle = new Function('return ' + extractFn(APP_SRC, 'docEle'))();
  const deps = {
    els,
    ui,
    docEle,
    renderShelf: () => { calls.shelf++; },
    readCounts: () => ({ star: 0 }),
    tagCounts: () => tags,
    TAG_CLOUD_MAX: TAG_MAX,
  };
  const factory = new Function(
    'els', 'ui', 'docEle', 'renderShelf', 'readCounts', 'tagCounts', 'TAG_CLOUD_MAX',
    extractFn(APP_SRC, 'renderTagCloud') + '\nreturn renderTagCloud;'
  );
  const render = factory(deps.els, deps.ui, deps.docEle, deps.renderShelf, deps.readCounts, deps.tagCounts, deps.TAG_CLOUD_MAX);
  return { render, els, ui, calls, cloud: () => els.tagCloud };
}

/** 标签云里除「固定三件」（★星标 / 完结 / 连载中）之外的标签 chip */
const chipTexts = (el) => el.children
  .filter((c) => c.tagName === 'BUTTON' && !c.classList.contains('tag-more') && /^标签/.test(c.textContent))
  .map((c) => c.textContent);
const moreBtn = (el) => el.children.find((c) => c.classList.contains('tag-more')) || null;

test('②-1 标签数不超过阈值时全量渲染，不出现「更多」', () => {
  const { render, cloud } = makeCloud(TAG_MAX);
  render();
  assert.equal(chipTexts(cloud()).length, TAG_MAX);
  assert.equal(moreBtn(cloud()), null, '没有可折叠项时不该出现展开器');
});

test('②-2 12 个标签折叠到阈值 + 「更多 N ▾」，展开后全量 + 「收起 ▴」', () => {
  const { render, cloud } = makeCloud(12);
  render();
  assert.equal(chipTexts(cloud()).length, TAG_MAX, '折叠态只画阈值内的标签');
  assert.equal(chipTexts(cloud())[0], '标签01 12', '折叠不应打乱排序（频次倒序）');
  const more = moreBtn(cloud());
  assert.ok(more, '缺少「更多」按钮');
  assert.equal(more.textContent, `更多 ${12 - TAG_MAX} ▾`);
  assert.equal(more.getAttribute('aria-expanded'), 'false');

  more.dispatch('click');
  assert.equal(chipTexts(cloud()).length, 12, '展开后应全量');
  assert.equal(moreBtn(cloud()).textContent, '收起 ▴');
  assert.equal(moreBtn(cloud()).getAttribute('aria-expanded'), 'true');

  moreBtn(cloud()).dispatch('click');
  assert.equal(chipTexts(cloud()).length, TAG_MAX, '再点应收起');
  assert.equal(moreBtn(cloud()).getAttribute('aria-expanded'), 'false');
});

test('②-3 展开/收起只重画标签云，不重跑 renderShelf（已加载的网格不该被带走）', () => {
  const { render, cloud, calls } = makeCloud(12);
  render();
  const before = calls.shelf;
  moreBtn(cloud()).dispatch('click');
  moreBtn(cloud()).dispatch('click');
  assert.equal(calls.shelf, before, '展开器不得触发 renderShelf');
});

test('②-4 选中的标签若被折叠到窗口外，仍强制显示在最前（否则筛选生效却找不到原因）', () => {
  const { render, cloud, ui } = makeCloud(12);
  ui.tag = '标签11'; // 频次排序下的第 11 个，默认在窗口外
  render();
  const texts = chipTexts(cloud());
  assert.ok(texts.includes('标签11 2'), `选中标签必须可见，实际：${texts.join(' | ')}`);
  assert.equal(texts[0], '标签11 2', '选中的标签排最前，且不重复占位');
  assert.ok(texts.includes('标签01 12'), '其余窗口内标签照常显示');
});

test('②-5 「更多」是展开器不是筛选条件：不带 .on，也不能和选中 chip 混同', () => {
  const { render, cloud, ui } = makeCloud(12);
  ui.tag = '标签01';
  render();
  moreBtn(cloud()).dispatch('click');
  const more = moreBtn(cloud());
  assert.ok(!more.classList.contains('on'), '展开器不该有选中态');
  assert.equal(chipTexts(cloud()).filter((t) => t.startsWith('标签01')).length, 1, '选中 chip 只出现一次');
});

/* ════════════ ② 结构：版心与栅格参数 ════════════ */

test('②-6 书架有 1180 版心（用 padding 居中，不用 max-width 以免滚动条离开视口右缘）', () => {
  const body = ruleBody('  .shelf-body');
  assert.match(body, /padding-left:\s*max\(32px, calc\(\(100% - 1180px\) \/ 2\)\);/, '缺少居中版心');
  assert.ok(!/max-width/.test(body), '不得用 max-width —— 滚动条会被拖到内容右边界');
});

test('②-7 「继续阅读」与书架同栅格（不再有 840 的独立版心）', () => {
  // 桌面档（≥900）必须与 .grid 同为 190/18 —— 直接对整段模板断言，不依赖块的出现顺序
  assert.match(CSS, /#continueCard \{\s*grid-template-columns: repeat\(auto-fill, minmax\(190px, 1fr\)\);\s*gap: 18px;/,
    '桌面档应复用书架栅格 190/18');
  assert.ok(!/max-width:\s*840px/.test(CSS), '旧的 840 独立版心必须移除（两块内容两种版心）');
});

test('②-7b 平板档（481~899）继续阅读不再单列竖叠（768 首屏工具区 64% 的一半来自它）', () => {
  const at = CSS.indexOf('@media (min-width: 481px) and (max-width: 899px)');
  assert.ok(at >= 0, '缺少平板档断点');
  const block = CSS.slice(at, CSS.indexOf('\n}', CSS.indexOf('#continueCard', at)));
  assert.match(block, /#continueCard/, '平板档必须约束继续阅读');
  assert.match(block, /grid-template-columns:\s*repeat\(auto-fill, minmax\(190px, 1fr\)\)/, '平板档应铺成一行多列');
});

test('②-8 手机端继续阅读改横向滑动（列流向 + 86% 卡宽 + 吸附）', () => {
  assert.ok(/@media \(max-width: 480px\)[\s\S]*#continueCard/.test(CSS), '缺手机断点');
  const mobile = CSS.slice(CSS.lastIndexOf('@media (max-width: 480px)'));
  assert.match(mobile, /grid-auto-flow:\s*column/, '应为列流向');
  assert.match(mobile, /grid-auto-columns:\s*86%/, '86% 是「露出下一张」与「元信息不被截断」的平衡点');
  assert.match(mobile, /scroll-snap-type:\s*x proximity/, '松手应吸附到卡片左缘');
});

test('②-9 ⋯ 热区只在粗指针下扩大（鼠标环境不能抢走元信息行右端的点击）', () => {
  assert.equal(CSS.split('.card .card-more::after').length - 1, 1, '::after 规则只应出现一次');
  assert.match(CSS, /@media \(pointer: coarse\) \{\s*\.card \.card-more::after \{ content: ''; position: absolute; inset: -10px -4px -10px -6px; \}\s*\}/,
    '热区必须整体落在 @media (pointer: coarse) 里');
});

/* ════════════ ③ 系统化：z-index / 时长 / 浅底 ════════════ */

test('③-1 全站 z-index 只剩语义令牌，无散值', () => {
  const raw = Array.from(CSS.matchAll(/z-index:\s*([^;]+);/g)).map((m) => m[1].trim());
  assert.ok(raw.length >= 10, `z-index 声明数异常：${raw.length}`);
  const literal = raw.filter((v) => !/^var\(--z-[a-z]+\)$/.test(v));
  assert.deepEqual(literal, [], `these must use tokens: ${literal.join(', ')}`);
});

test('③-2 层级令牌覆盖原有的每个档位，且语义名齐全', () => {
  for (const n of ['card', 'sticky', 'side', 'float', 'drawer', 'sheet', 'toast', 'modal']) {
    assert.match(cssDecl(`z-${n}`), /^\d+$/, `--z-${n} 必须是数值`);
  }
  // 原有 10 个散值（2/3/5/10/16/20/30/50/60/70）必须都还有归属档 —— card 收 2+3，sticky 收 5+10
  assert.equal(cssDecl('z-card'), '3');
  assert.equal(cssDecl('z-sticky'), '10');
});

test('③-3 transition/animation 时长只剩两档令牌', () => {
  const decls = Array.from(CSS.matchAll(/(?:transition|animation):[^;\n]*;/g));
  assert.ok(decls.length >= 10, `时长声明数异常（扫描可能失效）：${decls.length}`);
  const literal = decls.map((m) => m[0]).filter((d) => /\b\d*\.?\d+s\b/.test(d));
  assert.deepEqual(literal, [], `these must use --t-fast/--t-base: ${literal.join(' | ')}`);
  assert.equal(cssDecl('t-fast'), '.12s');
  assert.equal(cssDecl('t-base'), '.18s');
});

test('③-4 近似浅底收成 surface/线/危险令牌，无散落', () => {
  const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, ''); // 剥注释：注释里允许写「改造前是 #xxx」
  // 这些值现在只该作为 :root 里的令牌定义出现一次
  for (const old of ['#f2f1ec', '#faf8f2', '#fbfaf6', '#f1efe9', '#fbeeec', '#6d4614']) {
    const n = bare.split(old).length - 1;
    assert.equal(n, 1, `${old} 出现 ${n} 次（应只在 :root 定义 1 次）`);
  }
  // 这些值被并入了差 ≤2 灰阶的既有令牌（#f0efe9→line-soft / #fbf7f0→surface-1 /
  // #f7f5ef→surface-1 / #fdf0ee→danger-weak），自己不再保留定义
  for (const old of ['#f0efe9', '#fbf7f0', '#f7f5ef', '#fdf0ee']) {
    const n = bare.split(old).length - 1;
    assert.equal(n, 0, `${old} 仍有 ${n} 处裸值`);
  }
  for (const n of ['surface-1', 'surface-2', 'surface-3', 'line-soft', 'danger-weak', 'accent-ink', 'mark-ink']) {
    assert.match(token(n), /^#[0-9a-fA-F]{6}$/, `缺少令牌 --${n}`);
  }
});
