/*
 * cleaner.js — r2novel 清洗引擎（浏览器 / Node 共用 ESM，零依赖）
 *
 * 三大职责：
 *   1. 编码识别：BOM / UTF-8(strict) / GB18030 / Big5，叠加「可读性打分」兜底
 *      —— GB18030 是"全字节合法"编码，fatal 试错对它是失效的（永远成功、
 *         但解出的可能是乱码），必须用汉字密度 + 常用字命中 + 替换符惩罚来判优。
 *   2. 清理排版：去 [x] 脚注 / 去 Markdown / 乱码字符 / 空行 / 缩进 / 合并断行 /
 *      中文引号统一 / 站点残留行（均可选）。
 *   3. 智能分章：移植 novel-station lib/splitter.js（标记自适应、标题同行保留、
 *      引子归章、单章取书名、误抓修复、自定义正则）。
 */

import { FIT_CHAPTER_BYTES } from './shared-const.js';

// 字数判据单点在 shared-text.js（router.js 的 wordsOf 是同一份）；
// 再导出：cleaner.countWords 是 preview.js 与测试沿用的公开入口。
import { countWords } from './shared-text.js';
export { countWords };

export const DEFAULT_CLEAN_OPTS = {
  stripRefMarks: true, // 去 [12]【3】 脚注数字标注
  stripMarkdown: true, // 去 Markdown 语法
  cleanGarbled: true,  // 清非常见/乱码字符（保守白名单）
  collapseBlank: true, // 合并多余空行，一段一行
  indent: false,       // 段首缩进两个全角空格
  joinSoft: false,     // 合并被换行打断的句子（下载版硬截断修复，默认关）
  unifyQuotes: false,  // 「」『』 → “”
  stripSite: true,     // 去站点残留行（URL 行 / 书站广告括注）
};

/* ---------------- 编码探测 ---------------- */

const decoders = new Map();
function getDecoder(label) {
  try {
    if (!decoders.has(label)) decoders.set(label, new TextDecoder(label, { fatal: true }));
  } catch {
    return null;
  }
  return decoders.get(label);
}

/* 宽容解码器（非 fatal）：非法字节解成 U+FFFD 而非抛异常。
 * M3 用 —— fatal 试错全失败时不能让整本归零，也不能让手动切换编码同样无救。 */
const lenientDecoders = new Map();
function getLenientDecoder(label) {
  try {
    if (!lenientDecoders.has(label)) lenientDecoders.set(label, new TextDecoder(label));
  } catch {
    return null;
  }
  return lenientDecoders.get(label);
}

/** 可读性打分：汉字占比 + 常用字命中率 - 替换符/罕见区惩罚 */
function readabilityScore(text) {
  if (!text) return 0;
  let cjk = 0,
    common = 0,
    replace = 0,
    rare = 0,
    total = 0;
  for (const ch of text) {
    total++;
    const cp = ch.codePointAt(0);
    if (cp === 0xfffd) replace++;
    else if (cp >= 0x4e00 && cp <= 0x9fff) {
      cjk++;
      if (COMMON_SET.has(ch)) common++; // Set 命中 O(1)；string.includes 是对 1000 字串线性扫描，逐字打分 O(N×1000)，大文件三路探测跑三遍极慢
    } else if ((cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0xf900 && cp <= 0xfaff)) rare++;
  }
  if (!total) return 0;
  return (cjk / total) * 100 + common * 0.5 - replace * 60 - rare * 10;
}

/* GB2312 一级汉字常用样本（节选高频字，用于命中率参考） */
const COMMON_HAN =
  '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞';
const COMMON_SET = new Set(COMMON_HAN); // 打分热路径用 Set，别用 string.includes（见 readabilityScore 注释）
function decodeOnce(bytes, label) {
  const d = getDecoder(label);
  if (!d) return null;
  try {
    return { text: d.decode(bytes), ok: true };
  } catch {
    return { text: '', ok: false };
  }
}

/** 检测文本编码。bytes 必须带 BOM 前 3 字节可判 BOM。
 * 思路：UTF-8(strict)、GB18030、Big5 三路全解 → 可读性打分取最高。
 * GB18030 全字节合法，fatal 试错对它失效（永远成功），故必须叠加打分判优；
 * 纯 ASCII 文本三路同分 → 靠稳定排序保持 UTF-8 优先。
 * 返回 { encoding, text, replaced, score, candidates } */
export function detectEncoding(bytes) {
  if (!bytes || !bytes.length) return { encoding: 'utf-8', text: '', candidates: [] };
  let bin = bytes;
  let bom = null;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bom = 'utf-8';
    bin = bytes.slice(3);
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    bom = 'utf-16le';
    bin = bytes.slice(2);
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    bom = 'utf-16be';
    bin = bytes.slice(2);
  }
  if (bom === 'utf-16le' || bom === 'utf-16be') {
    const d = new TextDecoder(bom);
    const text = d.decode(bin);
    const replaced = (text.match(/\uFFFD/g) || []).length;
    const score = readabilityScore(text);
    return { encoding: bom, text, replaced, score, candidates: [{ encoding: bom, score, replaced }] };
  }

  const labels = ['utf-8', 'gb18030', 'big5'];
  const cands = labels.map((lab) => {
    const strict = decodeOnce(bin, lab); // fatal 试错：成功 ⇒ 该编码下「完全合法」
    let text = strict && strict.ok ? strict.text : null;
    if (text == null) {
      // M3：三路 fatal 全失败时**绝不能返回空文本**。含 0xFF（GB18030 非法字节）或下载被
      // 截断（悬空多字节前导）时，三个 fatal 解码器全抛 → 旧实现返回 ''，预览页于是
      // 「分章规则：未识别」+ 确认按钮永久禁用，而手动切换编码走 decodeWith 也是 fatal
      // → 用户无任何站内自救途径。这里退回宽容解码（坏字节 → U+FFFD）交给打分排序：
      // readabilityScore 对每个 U+FFFD 扣 60 分，足以分辨「整体乱码」与「仅个别坏字节」。
      const len = getLenientDecoder(lab);
      text = len ? len.decode(bin) : '';
    }
    return { encoding: lab, score: readabilityScore(text), replaced: (text.match(/\uFFFD/g) || []).length, text };
  });
  // 稳定排序：同分时保持 utf-8 → gb18030 → big5 优先级（全 ASCII 文本默认 utf-8）
  cands.sort((a, b) => b.score - a.score);
  const top = cands[0]; // 每个候选都必有 text（fatal 失败已由宽容解码兜底）
  return {
    encoding: top.encoding,
    text: top.text,
    replaced: top.replaced || 0,
    score: top.score,
    candidates: cands.map(({ encoding, score, replaced }) => ({ encoding, score, replaced })),
  };
}

/** 按指定编码重解（预览页手动切换时用）
 * fatal 失败时退回宽容解码：手动切换是用户最后的自救手段，不能也返回空串（M3）。 */
export function decodeWith(bytes, label) {
  const r = decodeOnce(bytes, label);
  if (r && r.ok) return r.text;
  const len = getLenientDecoder(label);
  return len ? len.decode(bytes) : '';
}

/* ---------------- 清理规则 ---------------- */

const KEEP_RE = new RegExp(
  '[^' +
    '\\n\\t\\u0020-\\u007E' + // 基本 ASCII
    '\\u00A5\\u00B0\\u00B7\\u00D7\\u00F7' + // ¥ ° · × ÷
    '\\u2010-\\u2027\\u2030-\\u205E' + // 常用标点 — … “ ” ‘ ’
    '\\u3000-\\u303F' + // CJK 标点
    '\\u3400-\\u4DBF\\u4E00-\\u9FFF' + // CJK 汉字
    '\\uF900-\\uFAFF\\uFE30-\\uFE4F' + // CJK 兼容
    '\\uFF00-\\uFFEF' + // 全角字符
    // L2：假名 / 谚文 / 罗马数字原先不在白名单里 → cleanGarbled 默认开启时被**静默删除**
    //     （「こんにちは」变空白、Ⅰ Ⅱ Ⅲ 消失）。这三段都是「成体系的文字」，不可能是
    //     解码乱码（乱码产出的是散落的汉字/拉丁符号），加进白名单不削弱清乱码能力。
    '\\u3040-\\u30FF' + // 日文假名（半角/全角片假名已含在 FF00 段）
    '\\u1100-\\u11FF\\u3130-\\u318F\\uA960-\\uA97F\\uAC00-\\uD7AF\\uD7B0-\\uD7FF' + // 谚文（Jamo/兼容/音节）
    '\\u2160-\\u217F' + // 罗马数字 Ⅰ Ⅱ Ⅲ …
    ']',
  'g'
);

function stripMarkdown(text) {
  text = text.replace(/```[^\n]*\n?/g, '');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  text = text.replace(/^\s{0,3}[-*+]\s+/gm, '');
  text = text.replace(/^\s{0,3}\d+\.\s+/gm, '');
  text = text.replace(/^\s{0,3}([-*_])\1{2,}\s*$/gm, '');
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/___([^_]+)___/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/~~([^~]+)~~/g, '$1');
  return text;
}

const QUOTE_RE = /[「『]([^」』]*)[」』]/g;

/** 主清理入口 */
export function cleanText(raw, opts = {}) {
  const o = { ...DEFAULT_CLEAN_OPTS, ...opts };
  if (raw == null) return '';
  let text = String(raw);

  // 统一换行、去 BOM/零宽
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = text.replace(/[\uFEFF\u200B\u200C\u200D\u2060\u200E\u200F]/g, '');

  if (o.stripRefMarks) text = text.replace(/[\[【〔]\s*\d+\s*[\]】〕]/g, '');
  if (o.stripMarkdown) text = stripMarkdown(text);
  if (o.cleanGarbled) text = text.replace(KEEP_RE, '');

  let lines = text.split('\n').map((line) => line.replace(/[\t \u3000]+/g, ' ').replace(/\s+$/, '').replace(/^\s+/, ''));

  if (o.stripSite) {
    lines = lines.filter((l) => {
      if (!l) return true;
      if (/\b(?:www\.|https?:\/\/)/i.test(l)) return false;
      // 书站广告括注：短行 + 关键词
      if (l.length <= 40 && /^[【\[(（]?(?:本书|笔趣阁|顶点|追书|搜读|小说阅读网|首发|无弹窗|阅读网址|欢迎访问|手机用户|请收藏|加入书签|收藏本站|下载txt|推荐票|月票)/.test(l)) return false;
      if (/^={3,}\s*(?:完|全文完|全书完)/.test(l)) return false;
      return true;
    });
  }

  if (o.collapseBlank) {
    lines = lines.filter((l) => l.length > 0);
  } else {
    const out = [];
    let prevBlank = false;
    for (const l of lines) {
      const blank = l.length === 0;
      if (blank && prevBlank) continue;
      out.push(l);
      prevBlank = blank;
    }
    lines = out;
  }

  // 先合并断行、后缩进：避免段中拼接时把第二行原样的全角缩进带进段落中间
  if (o.joinSoft) {
    const SENT_END = /[。！？!?…：；;:"'「『（(《———]$/;
    const paras = [];
    let buf = '';
    for (const line of lines) {
      if (!line) {
        if (buf) {
          paras.push(buf);
          buf = '';
        }
        continue;
      }
      if (!buf) buf = line;
      else if (SENT_END.test(buf)) {
        paras.push(buf);
        buf = line;
      } else buf = buf + line;
    }
    if (buf) paras.push(buf);
    lines = paras;
  }

  if (o.indent) lines = lines.map((l) => (l.length > 0 ? '\u3000\u3000' + l : l));

  if (o.unifyQuotes) lines = lines.map((l) => l.replace(QUOTE_RE, (m, inner) => '“' + inner + '”'));

  // 只清首尾空行，不清行首全角缩进（String.trim 会把 \u3000 一并吞掉）
  return lines.join('\n').replace(/^\n+|\n+$/g, '');
}

/* ---------------- 智能分章 ---------------- */

/* 章号字符集：半角数字 + 全角数字 ０-９ + 中文数字 + 〇（U+3007）。
 * 单一来源，5 个检测器共用 —— 改一处即全体生效，不会「改了 4 个漏 1 个」。
 * L3：全角数字与〇原先一律不识别 → 整本一章兜底。 */
const CH_NUM = '[0-9\\uFF10-\\uFF19零〇一二三四五六七八九十百千万两]';

/* 正则必须含两个捕获组：标记本体、同行余下文字（章节名候选）
 * flags：附加的正则标志（默认无）。en 需要 i —— M5：Chapter/chapter/CHAPTER 混写极其常见，
 *        缺了 i 会整本判「未识别」变一章，而该检测器的 label 本身就写着 Chapter X。 */
export const DETECTORS = [
  { id: 'cn', label: '第X章', src: '(?:^|\\n)\\s*(?:#+\\s*)?(第\\s*' + CH_NUM + '+\\s*[章回节卷])\\s*(.*)' },
  { id: 'cn_hui', label: '第X回', src: '(?:^|\\n)\\s*(?:#+\\s*)?(第\\s*' + CH_NUM + '+\\s*回)\\s*(.*)' },
  { id: 'cn_jie', label: '第X节', src: '(?:^|\\n)\\s*(?:#+\\s*)?(第\\s*' + CH_NUM + '+\\s*节)\\s*(.*)' },
  { id: 'cn_juan', label: '第X卷', src: '(?:^|\\n)\\s*(?:#+\\s*)?(第\\s*' + CH_NUM + '+\\s*卷)\\s*(.*)' },
  { id: 'en', label: 'Chapter X', flags: 'i', src: '(?:^|\\n)\\s*(chapter\\s+[0-9ivxlcdm]+)\\s*(.*)' },
  { id: 'vol', label: '卷X', src: '(?:^|\\n)\\s*(卷\\s*' + CH_NUM + '+)\\s*(.*)' },
];

const DETECT_PREFIX = 5000000;

function scanDetectors(text) {
  let best = null;
  let bestCount = 0;
  for (const d of DETECTORS) {
    const c = (text.match(new RegExp(d.src, 'gm' + (d.flags || ''))) || []).length;
    if (c > bestCount) {
      bestCount = c;
      best = d.id;
    }
  }
  return { id: best, count: bestCount };
}

function detectBest(text) {
  const sample = text.length > DETECT_PREFIX ? text.slice(0, DETECT_PREFIX) : text;
  let r = scanDetectors(sample);
  if (r.count < 2 && text.length > DETECT_PREFIX) r = scanDetectors(text);
  return r.count >= 2 ? r.id : null;
}

/** 同行余下文字是否像章节名（而非正文首句）
 *
 * M4：原判据「含 。！？!?… 一律判正文」把大量合法标题打掉 —— 网文标题带问号/叹号极常见
 * （「第一章 谁在那里？」「第二章 轰！天崩地裂」），降级后标题只剩「第X章」、副标题被
 * 复制进正文首行并随之上传入库。改为判「像不像一句完整的话」：
 *   · 「。」是正文句末标点，标题几乎不会以它收尾 → 出现即判正文；
 *   · 顿号/逗号类 + 偏长（>16）→ 更像正文首句；标题即便带逗号也很短
 *     （「风起云涌，少年踏上修仙路」12 字、「魔宫建立，十二个时辰之后现身」14 字）。
 * 与旧判据的差异只在两处放宽（放行 ？！… 、逗号阈值 12→16）与一处收紧（「。」一律拒），
 * 因此既修掉降级，又不放过「第一章 他推开门，走了进去。」这类紧贴正文的写法。 */
function isLikelyTitle(s) {
  if (!s) return false;
  if (s.length > 40) return false;
  if (s.includes('。')) return false;
  if (/[，,、；;]/.test(s) && s.length > 16) return false;
  return true;
}

/**
 * splitChapters(text, opts)
 *   opts.pattern    'auto' | 'cn' | 'cn_hui' | 'cn_jie' | 'cn_juan' | 'en' | 'vol' | 'custom'
 *   opts.customSrc  自定义正则（需 2 捕获组：标记、标题）
 *   opts.clean      每章是否套用 cleanText（默认 true）
 *   opts.cleanOpts  传给 cleanText 的选项
 *   opts.fallbackTitle  单章时默认章名（通常传书名）
 * 返回 { chapters:[{title, content}], detected }
 */
export function splitChapters(text, opts = {}) {
  const clean = opts.clean !== false;
  const cleanOpts = opts.cleanOpts || {};
  const raw = String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  let patternId = opts.pattern || 'auto';
  let src;
  let flags = '';

  if (patternId === 'auto') {
    const best = detectBest(raw);
    if (!best) {
      const whole = clean ? cleanText(raw.trim(), cleanOpts) : raw.trim();
      if (!whole) return { chapters: [], detected: null };
      const firstLine = whole.split('\n')[0] || '';
      const fb = opts.fallbackTitle || '';
      const singleTitle = fb || (firstLine.length > 30 ? '正文' : firstLine);
      return { chapters: [{ title: singleTitle, content: whole }], detected: null };
    }
    patternId = best;
  }

  if (patternId === 'custom') src = opts.customSrc || '';
  else {
    const det = DETECTORS.find((d) => d.id === patternId) || DETECTORS[0];
    src = det.src;
    flags = det.flags || ''; // 例：en 需要 i（Chapter / chapter 混写）
  }

  let re;
  try {
    re = new RegExp(src, 'gm' + flags);
  } catch {
    re = new RegExp(DETECTORS[0].src, 'gm');
  }

  const chapters = [];
  let m;
  let lastEnd = 0;
  let prevTitle = '';
  let prevBody = '';
  let first = false;
  let preamble = '';

  while ((m = re.exec(raw)) !== null) {
    const rest = (m[2] || '').trim();
    let title;
    let body;
    if (isLikelyTitle(rest)) {
      const sep = /^[\s:：\-—]/.test(rest) ? '' : ' ';
      title = (m[1] || '').trim() + (rest ? sep + rest : '');
      title = title.replace(/[\s:：\-—]+$/, '');
      body = '';
    } else {
      title = (m[1] || '').trim();
      body = rest;
    }
    if (!first) {
      preamble = raw.slice(0, m.index).trim();
      first = true;
    } else {
      const contentText = (prevBody ? prevBody + '\n' : '') + raw.slice(lastEnd, m.index);
      chapters.push({ title: prevTitle, content: clean ? cleanText(contentText.trim(), cleanOpts) : contentText.trim() });
    }
    prevTitle = title;
    prevBody = body;
    lastEnd = re.lastIndex;
    if (m.index === re.lastIndex) re.lastIndex++;
  }

  if (!first) {
    const whole2 = clean ? cleanText(raw.trim(), cleanOpts) : raw.trim();
    if (!whole2) return { chapters: [], detected: null };
    return { chapters: [{ title: opts.fallbackTitle || '正文', content: whole2 }], detected: null };
  }

  const lastText = (prevBody ? prevBody + '\n' : '') + raw.slice(lastEnd);
  const lastContent = clean ? cleanText(lastText.trim(), cleanOpts) : lastText.trim();
  chapters.push({ title: prevTitle, content: lastContent });
  if (preamble) chapters.unshift({ title: '引子', content: clean ? cleanText(preamble, cleanOpts) : preamble });

  // L1：目录页（连续标记行之间没有任何正文）会产出 N 个「空正文」章 —— 入库后一堆点开是空白，
  // 书架里也全是 0 字章。空章一律丢弃；若整篇都是目录（全空），退回「整本一章」，避免
  // chapters:[] 让预览页的「确认入库」永久禁用（那是 M3 同类死胡同，只是成因不同）。
  const kept = chapters.filter((c) => (c.content || '').trim());
  if (!kept.length) {
    const whole3 = clean ? cleanText(raw.trim(), cleanOpts) : raw.trim();
    if (!whole3) return { chapters: [], detected: null };
    return { chapters: [{ title: opts.fallbackTitle || '正文', content: whole3 }], detected: null };
  }

  return { chapters: kept, detected: patternId };
}

/** 一次到位：bytes → {encoding, chapters, detected, words, candidates}，供上传预览
 * cleanOpts.clean === false 时整链不做清理（只解码 + 分章）。 */
export function processBook(bytes, { fallbackTitle, cleanOpts = {}, forceEncoding = null, pattern = 'auto' } = {}) {
  const det = forceEncoding ? { encoding: forceEncoding, text: decodeWith(bytes, forceEncoding) } : detectEncoding(bytes);
  if (!det.text) return { encoding: det.encoding, chapters: [], detected: null, words: 0, candidates: det.candidates || [] };
  const clean = cleanOpts.clean !== false;
  const sp = splitChapters(det.text, { pattern, clean, cleanOpts, fallbackTitle });
  const words = (sp.chapters || []).reduce((s, c) => s + countWords(c.content), 0);
  return { encoding: det.encoding, replaced: det.replaced || 0, chapters: sp.chapters, detected: sp.detected, words, candidates: det.candidates || [] };
}

/** 服务端单章上限适配：把清洗后超限（> maxBytes，默认约 1.9MB 留余量）的章节
 * 按 UTF-8 字节边界切成连续段——切点回退到字符边界，绝不劈裂多字节字符。
 * 超大章（分章引擎整本兜底等）若不切会在上传时被服务端 413 拒绝、留下半成品书。
 * 返回 { chapters, extra }：extra = 因切分多出的章节数（>0 时调用方提示用户）。 */
export function fitChapters(chapters, maxBytes = FIT_CHAPTER_BYTES) {
  const out = [];
  let extra = 0;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  for (const c of chapters) {
    const text = c.content || '';
    // 粗筛：字符数 × 4（UTF-8 单字最多 4 字节）仍小于上限 → 必不超，跳过编码
    if (text.length * 4 <= maxBytes) {
      out.push(c);
      continue;
    }
    const bytes = enc.encode(text);
    if (bytes.length <= maxBytes) {
      out.push(c);
      continue;
    }
    const titleBase = c.title || '正文';
    const parts = [];
    let start = 0;
    while (start < bytes.length) {
      let end = Math.min(start + maxBytes, bytes.length);
      if (end < bytes.length) {
        // 回退到字符边界：跳过 continuation 字节，end 落在某字符首字节/末尾之后
        while (end > start && (bytes[end] & 0xc0) === 0x80) end--;
        if (end <= start) end = Math.min(start + maxBytes, bytes.length); // 防御：块内全是续字节不可能
      }
      parts.push(dec.decode(bytes.subarray(start, end)));
      start = end;
    }
    extra += parts.length - 1;
    parts.forEach((content, i) => out.push({ ...c, content, title: parts.length === 1 ? titleBase : titleBase + '（' + (i + 1) + '）' }));
  }
  return { chapters: out, extra };
}
