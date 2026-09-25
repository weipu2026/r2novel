/* cleaner.test.mjs — 清洗引擎单测（编码探测 / 清理规则 / 智能分章） */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectEncoding,
  decodeWith,
  cleanText,
  countWords,
  splitChapters,
  processBook,
  fitChapters,
} from '../public/js/cleaner.js';

/* GB18030 环境能力检测（非 full-icu 的 Node 会抛） */
function canDecode(label) {
  try {
    new TextDecoder(label, { fatal: true });
    return true;
  } catch {
    return false;
  }
}

const GBK = canDecode('gb18030');
const BIG5 = canDecode('big5');

test('编码：UTF-8 文本直接判 utf-8', () => {
  const bytes = new TextEncoder().encode('第一章 测试小说内容\n第二段。');
  const r = detectEncoding(bytes);
  assert.equal(r.encoding, 'utf-8');
  assert.ok(r.text.includes('测试小说'));
});

test('编码：纯 ASCII 判 utf-8', () => {
  const r = detectEncoding(new TextEncoder().encode('hello 123, nothing else'));
  assert.equal(r.encoding, 'utf-8');
});

test('编码：GB18030 字节样本判定（UTF-8 整段必然失败）', { skip: !GBK }, () => {
  // “第一章测试”的 GBK 字节（含 0xB2E2，非法 UTF-8 序列，保证 utf-8 fatal 必失败）
  const bytes = new Uint8Array([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0xb2, 0xe2, 0xca, 0xd4]);
  const r = detectEncoding(bytes);
  assert.equal(r.encoding, 'gb18030');
  assert.equal(r.text, '第一章测试');
  // 手动重解保持一致
  assert.equal(decodeWith(bytes, 'gb18030'), '第一章测试');
});

test('编码：Big5 样本（“一” A440）', { skip: !BIG5 }, () => {
  const r = detectEncoding(new Uint8Array([0xa4, 0x40]));
  assert.equal(r.text, '一');
  assert.notEqual(r.encoding, 'utf-8');
});

test('编码：UTF-8 BOM 去除', () => {
  const body = new TextEncoder().encode('正文A');
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
  const r = detectEncoding(bytes);
  assert.equal(r.encoding, 'utf-8');
  assert.equal(r.text, '正文A');
});

/* ---- 清理规则 ---- */

test('清理：去 [x] 脚注 + 合空行', () => {
  const out = cleanText('[12]你好【3】世界\n\n\n\n第二段来了。', { stripRefMarks: true, stripMarkdown: true, cleanGarbled: true, collapseBlank: true, indent: false });
  assert.equal(out, '你好世界\n第二段来了。');
});

test('清理：段首缩进', () => {
  const out = cleanText('一段。\n二段。', { collapseBlank: true, indent: true });
  assert.ok(out.startsWith('\u3000\u3000一段。'));
});

test('清理：合并断行（行尾无句读拼接）', () => {
  const out = cleanText('他走进房间然后\n坐下说话。', { collapseBlank: true, joinSoft: true });
  assert.ok(out.includes('他走进房间然后坐下说话。'));
  assert.ok(!out.includes('\n'));
});

test('清理：引号统一', () => {
  const out = cleanText('他说「今天好冷」然后走了。', { unifyQuotes: true });
  assert.equal(out, '他说“今天好冷”然后走了。');
});

test('清理：站点残留行删除（URL 行 / 书站广告括注）', () => {
  const out = cleanText('第一行。\nhttps://www.xx.com 阅读更多\n（本书由笔趣阁提供下载）\n继续。', { stripSite: true, collapseBlank: true });
  assert.ok(!out.includes('https'));
  assert.ok(!out.includes('笔趣阁'));
  assert.ok(out.includes('第一行'));
  assert.ok(out.includes('继续'));
});

/* ---- 智能分章 ---- */

test('分章：自动检测 + 标题同行保留 + 引子归章', () => {
  const text = '引子段落……\n第一章 相遇\n他醒了。\n第二章 离别\n她走了。';
  const r = splitChapters(text, { fallbackTitle: '无名书' });
  assert.equal(r.detected, 'cn');
  assert.equal(r.chapters.length, 3);
  assert.equal(r.chapters[0].title, '引子');
  assert.equal(r.chapters[1].title, '第一章 相遇');
  assert.ok(r.chapters[1].content.includes('他醒了'));
  assert.equal(r.chapters[2].title, '第二章 离别');
});

test('分章：冒号分隔的标题不被吞（第一章：新的开始）', () => {
  const text = '第一章：新的开始\n正文甲。\n第二章：风暴来临\n正文乙。';
  const r = splitChapters(text, {});
  assert.equal(r.chapters.length, 2);
  assert.equal(r.chapters[0].title, '第一章：新的开始');
  assert.equal(r.chapters[1].title, '第二章：风暴来临');
});

test('分章：无标题章不误抓正文首行', () => {
  const text = '\n第二章\n这里是正文第一句，继续说下去。\n第三章\n另一段正文。';
  const r = splitChapters(text, {});
  const ch2 = r.chapters.find((c) => c.title === '第二章');
  assert.ok(ch2, '应存在第二章');
  assert.ok(ch2.content.startsWith('这里是正文第一句'));
});

test('分章：Markdown 标题 # 第一章 兼容', () => {
  const text = '# 第一章 起点\n正文。\n# 第二章 途中\n正文2。';
  const r = splitChapters(text, {});
  assert.equal(r.detected, 'cn');
  assert.equal(r.chapters.length, 2);
  assert.equal(r.chapters[0].title, '第一章 起点');
});

test('分章：识别不出标记 → 整本一章取书名', () => {
  const text = '没有分章标记的纯文本。\n整本就一段又一段。';
  const r = splitChapters(text, { fallbackTitle: '我的书' });
  assert.equal(r.detected, null);
  assert.equal(r.chapters.length, 1);
  assert.equal(r.chapters[0].title, '我的书');
});

test('分章：自定义正则（2 捕获组）', () => {
  const text = '=== 第一卷 山间 ===\n内容1。\n=== 第二卷 江湖 ===\n内容2。';
  const r = splitChapters(text, { pattern: 'custom', customSrc: '(?:^|\\n)\\s*(===?\\s*[^=\\n]+\\s*===?)\\s*(.*)' });
  assert.equal(r.chapters.length, 2);
  assert.equal(r.chapters[0].title, '=== 第一卷 山间 ===');
});

/* 2 章 GBK 样本（码位手工核验）：'第一章 中文\n这是测试。\n第二章 小字\n这是测试。'
 *   第B5DA 一D2BB 章D5C2 空格20 中D6D0 文CEC4 \n0A
 *   这D5E2 是CAC7 测B2E2 试CAD4 。A1A3 \n0A
 *   第B5DA 二B6FE 章D5C2 空格20 小D0A1 字D7D6 \n0A
 *   这D5E2 是CAC7 测B2E2 试CAD4 。A1A3
 * 末章刻意带正文：只有标题行、正文为空的章会被 L1 丢弃，本样本断言的是分章本身。
 * 截断用例（M3）在同一份字节上砍末字节。 */
const GBK_TWO_CH = Uint8Array.from([
  0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0x0a,
  0xd5, 0xe2, 0xca, 0xc7, 0xb2, 0xe2, 0xca, 0xd4, 0xa1, 0xa3, 0x0a,
  0xb5, 0xda, 0xb6, 0xfe, 0xd5, 0xc2, 0x20, 0xd0, 0xa1, 0xd7, 0xd6, 0x0a,
  0xd5, 0xe2, 0xca, 0xc7, 0xb2, 0xe2, 0xca, 0xd4, 0xa1, 0xa3,
]);

test('processBook：一次到位（bytes → 章节+字数）', { skip: !GBK }, () => {
  const r = processBook(GBK_TWO_CH, { fallbackTitle: '中文' });
  assert.equal(r.encoding, 'gb18030');
  assert.equal(r.chapters.length, 2);
  assert.equal(r.chapters[0].title, '第一章 中文');
  assert.equal(r.chapters[1].title, '第二章 小字');
  assert.ok(r.chapters[0].content.includes('这是测试'));
  assert.ok(r.chapters[1].content.includes('这是测试'));
  assert.ok(r.words > 0);
});

/* ---- #134 清洗组回归（M3 / M4 / M5 / L1 / L2 / L3） ---- */

test('编码：UTF-8 混一个非法字节不再整本归零（M3）', () => {
  const good = new TextEncoder().encode(
    '第一章 测试\n正文内容写得很长，汉字很多很多。\n第二章 继续\n这里还有更多汉字内容。'
  );
  const bytes = new Uint8Array(good.length + 1);
  bytes.set(good.subarray(0, 20), 0);
  bytes[20] = 0xff; // GB18030 的非法字节：三个 fatal 解码器会全部抛异常
  bytes.set(good.subarray(20), 21);
  const r = detectEncoding(bytes);
  assert.equal(r.encoding, 'utf-8');
  assert.ok(r.text.length > 0, 'fatal 全失败时不能返回空文本（旧实现返回 "" → 整本归零）');
  assert.equal(r.replaced, 1);
  // 手动切换编码是最后的自救手段，同样不能被 fatal 锁死
  for (const lab of ['utf-8', 'gb18030', 'big5']) {
    assert.ok(decodeWith(bytes, lab).length > 0, lab + ' 的宽容解码应有输出');
  }
  const pb = processBook(bytes, { fallbackTitle: 'X' });
  assert.equal(pb.chapters.length, 2);
  assert.ok(pb.words > 0);
});

test('编码：GBK 尾部截断（悬空多字节）仍能识别（M3）', { skip: !GBK }, () => {
  // 砍掉末字节 → 尾部悬空前导字节，三个 fatal 解码器会全抛（旧实现因此整本归零）
  const cut = GBK_TWO_CH.slice(0, GBK_TWO_CH.length - 1);
  const r = detectEncoding(cut);
  assert.equal(r.encoding, 'gb18030');
  assert.equal(r.replaced, 1);
  assert.ok(r.text.length > 0, 'fatal 全失败时不能返回空串');
  const pb = processBook(cut, { fallbackTitle: 'X' });
  assert.equal(pb.chapters.length, 2, '截断也不该退化成整本一章');
  assert.ok(pb.chapters[1].title.startsWith('第二章'));
  assert.ok(pb.chapters[0].content.includes('这是测试'));
});

test('分章：两位数章号必须识别（含 〇 / 全角数字）', () => {
  // 回归护栏：字符类曾漏掉 `+` 量词 → 章号只能吃一个字符，「第十一章」「第一〇章」全不识别，
  // 而单字符章号的用例照旧通过（所以这条用例专盯「多字符章号」这一维）。
  const cases = [
    '第十一章 起始\n正文甲。\n第十二章 终局\n正文乙。',
    '第一〇章 起始\n正文甲。\n第一一章 终局\n正文乙。',
    '第１章 起始\n正文甲。\n第２章 终局\n正文乙。',
    '第100章 起始\n正文甲。\n第101章 终局\n正文乙。',
  ];
  for (const t of cases) {
    const r = splitChapters(t, {});
    assert.equal(r.detected, 'cn', '未识别：' + t.slice(0, 5));
    assert.equal(r.chapters.length, 2, '章数不对：' + t.slice(0, 5));
  }
});

test('分章：标题带问号/叹号/省略号不被降级（M4）', () => {
  const text =
    '第一章 谁在那里？\n正文甲。\n' +
    '第二章 轰！天崩地裂\n正文乙。\n' +
    '第三章 魔宫建立，十二个时辰之后现身\n正文丙。';
  const r = splitChapters(text, {});
  assert.deepEqual(
    r.chapters.map((c) => c.title),
    ['第一章 谁在那里？', '第二章 轰！天崩地裂', '第三章 魔宫建立，十二个时辰之后现身']
  );
  assert.ok(r.chapters[0].content.startsWith('正文甲'), '副标题不该被复制进正文');
});

test('分章：紧贴正文的行仍判正文（M4 反向对照）', () => {
  const text = '第一章 他推开门，走了进去。\n后面还有正文。\n第二章 他醒了。\n正文。';
  const r = splitChapters(text, {});
  assert.deepEqual(r.chapters.map((c) => c.title), ['第一章', '第二章']);
  assert.ok(r.chapters[0].content.startsWith('他推开门'));
});

test('分章：Chapter / chapter / CHAPTER 都识别（M5）', () => {
  for (const head of ['Chapter', 'chapter', 'CHAPTER']) {
    const t = head + ' 1 A\nbody one.\n' + head + ' 2 B\nbody two.';
    const r = splitChapters(t, {});
    assert.equal(r.detected, 'en', head + ' 未识别');
    assert.equal(r.chapters.length, 2);
    assert.equal(r.chapters[0].title, head + ' 1 A');
  }
});

test('分章：纯目录页不再产出 N 个空正文章（L1）', () => {
  const toc = ['第一章 起始', '第二章 成长', '第三章 试炼', '第四章 转折', '第五章 终局'].join('\n');
  const r = splitChapters(toc, { fallbackTitle: '目录书' });
  assert.equal(r.chapters.length, 1);
  assert.equal(r.chapters[0].title, '目录书');
  assert.ok(r.chapters[0].content.includes('第一章 起始'));
  assert.ok(r.chapters.every((c) => c.content.trim()), '不该有空正文章');
});

test('分章：只有个别章无正文时，其余章照常（L1 反向对照）', () => {
  const text = '第一章 楔子\n第二章 起始\n正文甲。\n第三章 终局\n正文乙。';
  const r = splitChapters(text, {});
  assert.deepEqual(r.chapters.map((c) => c.title), ['第二章 起始', '第三章 终局']);
  assert.ok(r.chapters[0].content.startsWith('正文甲'));
});

test('清理：cleanGarbled 不再删假名/谚文/罗马数字（L2）', () => {
  const src = '第一章 你好\n「こんにちは」与「안녕하세요」以及 Ⅰ Ⅱ Ⅲ 结尾。';
  const out = cleanText(src, { cleanGarbled: true, stripSite: false });
  assert.ok(/[ぁ-んァ-ヴ]/.test(out), '假名（U+3040-30FF）应保留');
  assert.ok(/[가-힣]/.test(out), '谚文（U+AC00-D7AF）应保留');
  assert.ok(/[Ⅰ-Ⅿ]/.test(out), '罗马数字（U+2160-217F）应保留');
  assert.ok(out.includes('こんにちは'));
  assert.ok(out.includes('안녕하세요'));
});

test('清理：cleanGarbled 仍能清私用区与控制符（L2 反向对照）', () => {
  const out = cleanText('第一\uE000章\u0007正文\uF8FF。', { cleanGarbled: true, stripSite: false });
  assert.ok(!/[\uE000\uF8FF]/.test(out), '私用区仍应清除');
  assert.ok(!/\u0007/.test(out), '控制符仍应清除');
  assert.ok(out.includes('正文'));
});

test('countWords 不含空白', () => {
  assert.equal(countWords('你好 世界\n再来一段'), 8);
});

test('fitChapters：正常章节原样返回，无 extra', () => {
  const chapters = [{ title: '一', content: '短内容。' }, { title: '二', content: 'x'.repeat(1000) }];
  const r = fitChapters(chapters, 2000);
  assert.equal(r.extra, 0);
  assert.equal(r.chapters.length, 2);
  assert.equal(r.chapters[0].content, '短内容。');
});

test('fitChapters：超大章按 UTF-8 边界切块，不劈裂字符，标题追加序号', () => {
  // 单章 10000 个 emoji（每字符 4 字节 = 40000 字节），maxBytes 取 1000 → 切成多段
  const big = '😀'.repeat(10000);
  const r = fitChapters([{ title: '正文', content: big }], 1000);
  assert.ok(r.extra > 0, '应产生额外分段');
  assert.ok(r.chapters.length > 1);
  // 每段拼回 == 原文（字符完整无 replacement）
  const joined = r.chapters.map((c) => c.content).join('');
  assert.equal(joined, big, '切块拼接必须与原文逐字符一致');
  assert.ok(!joined.includes('\uFFFD'), '不得出现替换符（劈裂多字节）');
  // 标题带序号且序号连续
  assert.equal(r.chapters[0].title, '正文（1）');
  assert.equal(r.chapters[1].title, '正文（2）');
  // 每段 UTF-8 字节数不超过上限
  for (const c of r.chapters) assert.ok(new TextEncoder().encode(c.content).length <= 1000, '每段字节不得超限');
});

test('fitChapters：中英混排边界安全（切点落在多字节字符中间也能回退）', () => {
  // 3 字节汉字 + 1 字节 ASCII 混排，maxBytes 卡在字符中间位置
  const text = ('中a'.repeat(5000)); // 10000 字符 ×4 字节均分
  const r = fitChapters([{ title: '卷', content: text }], 999); // 奇数上限，必切在字符中间
  const joined = r.chapters.map((c) => c.content).join('');
  assert.equal(joined, text);
  assert.ok(!joined.includes('\uFFFD'));
  assert.ok(r.chapters.length > 1);
  for (const c of r.chapters) assert.ok(new TextEncoder().encode(c.content).length <= 999);
});

test('fitChapters：整本一章大书（无章兜底）自动分段后可正常入库', () => {
  // 模拟 100 万字无章散文：字符长度 200 万 > maxBytes/4 触发编码判断
  const text = '这是正文内容。'.repeat(120000); // 1800000 字节左右
  const r = fitChapters([{ title: '散文集', content: text }]);
  assert.ok(r.extra > 0);
  const joined = r.chapters.map((c) => c.content).join('');
  assert.equal(joined, text, '整本切块拼接应与原文一致');
  for (const c of r.chapters) assert.ok(new TextEncoder().encode(c.content).length <= 1900000, '每段 ≤1.9MB（默认上限）');
});

/* ---------------- 不分章（pattern:'none'）—— 2026-09-25 新增 ---------------- */

test('不分章：带章标记的文本也不切，整本一章', () => {
  const text = '第一章 起点\n正文甲。\n第二章 转折\n正文乙。';
  const r = splitChapters(text, { pattern: 'none', fallbackTitle: '我的书' });
  assert.equal(r.chapters.length, 1, '显式不分章必须整本一章（章标记留在正文里当普通文字）');
  assert.equal(r.chapters[0].title, '我的书');
  assert.ok(r.chapters[0].content.includes('第一章 起点'), '章标记不得被删');
  assert.ok(r.chapters[0].content.includes('正文乙。'));
  assert.equal(r.detected, 'none', 'detected=none 表示用户主动选择，区别于 null（未识别）');
});

test('不分章：无 fallbackTitle 且首行短 → 取首行当章名', () => {
  const text = '短标题\n正文内容。';
  const r = splitChapters(text, { pattern: 'none' });
  assert.equal(r.chapters.length, 1);
  assert.equal(r.chapters[0].title, '短标题');
});

test('不分章：clean 开着时正文仍套清洗（清洗与分章独立）', () => {
  const text = '第一章 X\n他说了[1]一句话。\n**重要**内容。';
  const r = splitChapters(text, { pattern: 'none', fallbackTitle: '书' });
  assert.equal(r.chapters.length, 1, '不得被 auto 分章（否则整章标记被当真切走）');
  const c = r.chapters[0].content;
  assert.ok(!c.includes('[1]'), '脚注仍按清洗选项删');
  assert.ok(!c.includes('**'), 'Markdown 仍按清洗选项删');
  assert.ok(c.includes('他说了一句话'));
  assert.ok(c.includes('第一章 X'), '章标记留在正文里');
});

test('不分章：clean 关掉时正文原样保留', () => {
  const text = '第一章 X\n他说了[1]一句话。';
  const r = splitChapters(text, { pattern: 'none', clean: false, fallbackTitle: '书' });
  assert.equal(r.chapters[0].content, text);
});

test('不分章：空文本 → 空章节（确认按钮禁用路径不变）', () => {
  const r = splitChapters('   \n  ', { pattern: 'none', fallbackTitle: '书' });
  assert.deepEqual(r.chapters, []);
});

test('processBook：pattern none 透传（上传页的实际入口）', () => {
  const bytes = new TextEncoder().encode('第一章 甲\n内容一。\n第二章 乙\n内容二。');
  const r = processBook(bytes, { fallbackTitle: '透传书', pattern: 'none' });
  assert.equal(r.chapters.length, 1);
  assert.equal(r.chapters[0].title, '透传书');
  assert.equal(r.detected, 'none');
});
