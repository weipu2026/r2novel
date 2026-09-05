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

test('processBook：一次到位（bytes → 章节+字数）', { skip: !GBK }, () => {
  // GBK 样本（码位手工核验）：'第一章 中文\n这是测试。\n第二章 小字'
  //   第B5DA 一D2BB 章D5C2 空格20 中D6D0 文CEC4 \n0A
  //   这D5E2 是CAC7 测B2E2 试CAD4 。A1A3 \n0A
  //   第B5DA 二B6FE 章D5C2 空格20 小D0A1 字D7D6
  const bytes = Uint8Array.from([
    0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0x0a,
    0xd5, 0xe2, 0xca, 0xc7, 0xb2, 0xe2, 0xca, 0xd4, 0xa1, 0xa3, 0x0a,
    0xb5, 0xda, 0xb6, 0xfe, 0xd5, 0xc2, 0x20, 0xd0, 0xa1, 0xd7, 0xd6,
  ]);
  const r = processBook(bytes, { fallbackTitle: '中文' });
  assert.equal(r.encoding, 'gb18030');
  assert.equal(r.chapters.length, 2);
  assert.equal(r.chapters[0].title, '第一章 中文');
  assert.equal(r.chapters[1].title, '第二章 小字');
  assert.ok(r.chapters[0].content.includes('这是测试'));
  assert.ok(r.words > 0);
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
