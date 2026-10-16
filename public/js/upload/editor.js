/* upload/editor.js — 书架「编辑章节」（已发布书就地编辑：改标题 / 改正文 / 插章 / 删章）
 *
 * 与上传页的分章预览不同：这里操作的是**已发布**的书，每次改动即时落库（无「确认入库」），
 * 所以每个动作都是「先与服务端对齐，再以服务端返回的章表为唯一事实源重绘」。
 * 弹层里的按钮复用 preview.js 的 pvIconBtn / pvIconBtnSvg（同款细线图标语言）。
 */
import { els, $, IC } from '../dom.js';
import { api, fmtWords } from '../store.js';
import { toast } from '../ui.js';
import * as cleaner from '../cleaner.js';
import { offline } from '../offline.js';
import { host } from './ctx.js';
import { pvIconBtn, pvIconBtnSvg } from './preview.js';

const ceState = { id: null, bookTitle: '', chapters: [], count: 0, words: 0, dirty: false };

// 正文两级缓存（2026-10-13 审计修复 · 缺陷 2）：
//   ceBase  —— 服务端已确认的正文（「已保存基线」）。只在拉取成功 / 保存成功后写入。
//   ceDraft —— 用户正在编辑、**尚未保存**的内容。input / 清洗改字时即时收集，保存成功后清掉。
// 原件只有一个 ceBodies，既当缓存又当基线，于是：
//   ① 结构变更（插章/删章）整表重绘后，输入框里未保存的改动**静默丢失**（缓存根本没记过它）；
//   ② 重绘后重新展开时缓存命中分支**不回填** textarea（新元素 value 天生是 ''）→ 编辑区一片空白，
//      用户若在这空白框里敲几个字再保存，整章正文会被那几个字**替换**。
// 拆开后：草稿随 key 留存、重绘后照常回填；「保存本章」可点判据 = 草稿存在且 ≠ 基线。
const ceBase = new Map();
const ceDraft = new Map();

// 忙态计数（>0 表示有请求在飞）。用**计数**而不是布尔：ceBusy('…') / ceBusy('') 成对出现，
// 嵌套路径（插章 → 刷新章表）也会各带一对，布尔会被内层提前解锁。
let ceLock = 0;
// ceLock 所属的弹层世代（2026-10-16 审计修复）：关掉编辑器时若仍有请求在飞，ceLock 会残留 >0；
// 不绑定世代的话，**重开**的新弹层一渲染就被这枚旧锁锁住（输入框与按钮全灰，最长等到旧请求
// 超时），而且旧请求返回时的 ceBusy('') 还会去清新弹层的忙态文字 —— els.modalBox 是共享
// 容器，$('#ceBusy') 取到的已是新弹层的那个。守卫：ceBusy 只在 gen === ceLockGen 时才动锁。
let ceLockGen = 0;
// 锁定前各控件的自有 disabled 原值：解锁时**只还原被本锁周期接管过的控件**。
// 不能一刀切 disabled=false —— 「保存本章」有自己的禁用逻辑（内容未变/保存中必须禁用），
// #140 复查实证：一刀切会把未改动那行的保存钮误启用，点一下就对零变化内容发出 PATCH（cleanVer 空转 +1）。
const ceLockPrev = new WeakMap();

// 本弹层的「世代号」（app.js 的弹层世代令牌 L12，经 host().modalGen() 读取）。
// 在 openModal **之后**取号：此后任何一次 open/close（用户 Esc / 点遮罩 / 被别的弹层顶掉）
// 都会让世代号前进 → ceAlive() 失配 → 在飞请求后续的 DOM 写整体作废。
// 缺这道护栏的后果（2026-10-13 审计缺陷 3）：请求在飞时关掉弹层 → $('#ceStat', els.modalBox)
// 返回 null → 在 null 上写 textContent 抛 TypeError 被 catch 吞成「保存失败 / 插入失败」，
// 而服务端其实已经写成功；「插入失败」还会诱导用户重试 → 真的插出两章。
let ceGen = 0;
/** 某个世代号是否仍是「当前弹层」。⚠️ 必须比较**调用方捕获的**世代号，不能每次重读 ceGen：
 *  「关掉编辑器 → 又打开同一个编辑器」时模块级 ceGen 已被刷新，旧请求拿它比较会误判成
 *  「还活着」（新弹层里同样有 #ceStat / #ceList），于是迟到写改写新弹层。
 *  空值守卫（if (el)）只能挡住「弹层已被清空」，挡不住这一类。 */
const ceAliveAt = (gen) => gen !== 0 && host().modalGen() === gen;

function ceStatText() {
  return `《${ceState.bookTitle}》 · ${ceState.count} 章 · ${fmtWords(ceState.words)} · 改动即时保存`;
}

/** 刷新统计行：世代已失配则整体跳过——不让迟到写碰到别人的 DOM（这也是「误报失败」的根因） */
function ceStatRefresh(gen) {
  if (!ceAliveAt(gen)) return;
  const el = $('#ceStat', els.modalBox);
  if (el) el.textContent = ceStatText();
}

export async function openChapterEditor(b) {
  // 入口抢占世代：bookMeta 是 RTT，这期间 openModal 还没调用、遮罩没出现，界面毫无反馈，
  // 用户很容易以为没点中而再点一次 → 两次 meta 回来各开一次弹层。抢占后「最后一次点击获胜」。
  const seq = host().modalTake();
  let meta;
  try {
    meta = await api.bookMeta(b.id);
  } catch (e) {
    toast('打开失败：' + (e.message || e), 2600);
    return;
  }
  if (seq !== host().modalGen()) return; // 期间用户又点了别的书 / 别的弹层：本次作废
  ceState.id = b.id;
  ceState.bookTitle = b.title;
  ceState.chapters = (meta.chapters || []).map((c) => ({ key: c.key, title: c.title }));
  ceState.count = meta.chapterCount || ceState.chapters.length;
  ceState.words = meta.wordCount || 0;
  ceState.dirty = false;
  ceBase.clear();
  ceDraft.clear();
  host().openModal(`
    <div>
      <h3>编辑章节</h3>
      <p id="ceStat" class="ce-stat modal-sub"></p>
    </div>
    <ul id="ceList" class="ce-list"></ul>
    <div class="ce-foot">
      <button class="pv-btn" id="ceAppend" type="button">＋ 在末尾追加一章</button>
      <span class="ce-busy" id="ceBusy"></span>
      <button class="ghost" id="ceDone" type="button">完成</button>
    </div>`);
  ceGen = host().modalGen(); // ⚠️ 必须在 openModal **之后**取：openModal 自己会推进世代号
  // 忙态随世代归零（2026-10-16）：上一个弹层的在飞请求不得锁住这个刚打开的新弹层。
  // ⚠️ 复位点只此一处 —— 关闭路径有多条（完成 / Esc / 点遮罩 / 被别的弹层顶掉），在关闭侧
  // 复位既漏又晚；在打开侧复位覆盖全部路径，且此刻旧控件早已脱离文档（WeakMap 记录自然失效）。
  ceLock = 0;
  ceLockGen = ceGen;
  els.modalBox.classList.add('ce');
  $('#ceAppend', els.modalBox).addEventListener('click', () => ceInsert(null));
  $('#ceDone', els.modalBox).addEventListener('click', finishChapterEditor);
  ceStatRefresh(ceGen);
  renderCeList(ceGen);
}

function ceBusy(text, gen) {
  // 世代守卫（2026-10-16）：本弹层已关 / 已被别的弹层顶掉时，迟到的解锁既不得改锁计数
  // （会把新弹层的锁减掉），也不得写忙态文字（写的是新弹层的 #ceBusy）。
  // ⚠️ gen 必传：漏传会让忙态锁**静默失效**（永远不匹配 ceLockGen）→ editor-ui.test.mjs
  // 有一条「契约哨兵」用例逐个扫调用点。
  // ⚠️ 两道判据都要：ceAliveAt 挡「弹层已关 / 已被顶掉」（不碰别人的 DOM），
  // ceLockGen 挡「已换成新弹层」（新弹层的锁计数是它的，旧世代无权减）。
  if (!ceAliveAt(gen) || gen !== ceLockGen) return;
  const el = $('#ceBusy', els.modalBox);
  if (el) el.textContent = text || '';
  ceLock = Math.max(0, ceLock + (text ? 1 : -1));
  ceApplyLock();
}

/** 忙态期间禁掉所有会写 meta 的控件。此前 ceBusy 只改一行文字，输入框与按钮全程可用，
 *  「改标题（change 失焦即发）→ 立刻点保存正文」会发出两个并发的 meta 读—改—写。
 *  服务端有 CAS 兜底（mutateMeta），这里让前端**根本不制造**这种并发，同时给出可见的忙态。
 *  禁用在 mousedown→mouseup 之间生效时那次 click 不触发 → 用户再点一次即可，
 *  不会出现「看着没反应、请求其实已发出」的双写。
 *  ⚠️ 解锁只还原 ceLockPrev 里记录过的控件：忙态期间重渲染出来的新行（插章/删章后的整表重绘）
 *  在加锁时已记录各自原值，解锁一并还原；未被锁周期接管的控件**不动**（比如从未忙过时的
 *  renderCeList → ceApplyLock 是 no-op，「保存本章」的初始禁用态得以保留）。
 *  ⚠️ 推论：**在 await 之后要设定按钮的终态，必须写在 ceBusy('') 之后** —— 解锁会把控件还原成
 *  加锁前那一刻的原值（保存钮此时是「有改动 → false」），写在之前会被解锁悄悄覆盖。
 *  见下方 save 的 click handler。 */
function ceApplyLock() {
  const box = els.modalBox;
  if (!box) return;
  const on = ceLock > 0;
  box.classList.toggle('ce-locked', on);
  box.querySelectorAll('input.ce-title, .ce-row button, #ceAppend, #ceDone').forEach((n) => {
    if (on) {
      if (!ceLockPrev.has(n)) ceLockPrev.set(n, n.disabled); // 只记首见值：嵌套/重绘不覆盖真值
      n.disabled = true;
    } else if (ceLockPrev.has(n)) {
      n.disabled = ceLockPrev.get(n);
      ceLockPrev.delete(n);
    }
  });
}

function renderCeList(gen) {
  if (!ceAliveAt(gen)) return; // 世代已失配：绝不把章节表重绘进别人（或后来新开的）弹层
  const ul = $('#ceList', els.modalBox);
  if (!ul) return;
  ul.innerHTML = '';
  if (!ceState.chapters.length) {
    const li = document.createElement('li');
    li.className = 'ce-empty muted';
    li.textContent = '（暂无章节）';
    ul.appendChild(li);
    return;
  }
  ceState.chapters.forEach((ch, i) => ul.appendChild(ceBuildRow(ch, i, gen)));
  ceApplyLock(); // 新建的行默认可用 → 若此刻仍在忙（插章后的整表重绘），必须重新锁上
}

/** 构造一行章节：序号 + 标题输入 + 正文/插章/删章按钮 +（可展开的正文编辑区）
 *  gen：本行所属的弹层世代（本行所有 await 之后的写都以它为准） */
function ceBuildRow(ch, i, gen) {
  const li = document.createElement('li');
  li.className = 'ce-row';
  const line = document.createElement('div');
  line.className = 'ce-line';
  const idx = document.createElement('span');
  idx.className = 'ch-no';
  idx.textContent = String(i + 1);
  const input = document.createElement('input');
  input.className = 'ce-title';
  input.placeholder = '第' + (i + 1) + '章';
  input.value = ch.title;
  input.addEventListener('change', async () => {
    const v = input.value.trim();
    if (v === ch.title) return;
    const old = ch.title;
    input.value = ch.title; // 未成功前先回显旧值
    ceBusy('保存标题…', gen);
    try {
      const r = await api.patchChapter(ceState.id, ch.key, { title: v });
      // #145 P2-8：状态写入包进世代守卫（与正文保存的 ceAliveAt 分支同一口径）。await 期间
      // 弹层可能被关/被换书：迟到响应把旧书的字数覆写进 ceState.words —— 新弹层统计行显示
      // 《B》· N 章 ·〈A 的字数〉，dirty=true 还引发无谓 loadShelf 与误弹离线同步提示。
      // 「已保存」toast 保留（服务端已成功就不能沉默，与正文保存同一契约）。
      if (ceAliveAt(gen)) {
        ch.title = r.title; // 服务端兜底（空标题 → 第 N 章）后的规范值
        ceState.words = r.wordCount;
        ceState.dirty = true;
        input.value = ch.title;
      }
      ceStatRefresh(gen); // 世代已失配则自动跳过（不让迟到写把成功误报成失败）
      toast('标题已保存', 1200);
    } catch (e) {
      input.value = old;
      toast('保存失败：' + (e.message || e), 2600);
    } finally {
      ceBusy('', gen);
    }
  });

  // 正文编辑区（懒加载：首次展开才拉正文）
  const bodyBox = document.createElement('div');
  bodyBox.className = 'ce-body hidden';
  const ta = document.createElement('textarea');
  ta.rows = 8;
  bodyBox.appendChild(ta);
  const acts = document.createElement('div');
  acts.className = 'ce-body-acts';
  const tip = document.createElement('span');
  tip.className = 'pv-tip';
  tip.textContent = '替换本章正文（UTF-8 文本）';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'pv-save';
  save.textContent = '保存本章';
  save.disabled = true;
  let bodyOpen = false;
  // 逐键收集草稿：重绘后（插章/删章）草稿仍在，展开即回填，不再静默丢掉未保存的改动
  ta.addEventListener('input', () => {
    ceDraft.set(ch.key, ta.value);
    save.disabled = ta.value === (ceBase.get(ch.key) || ''); // 与库内一致 → 无改动可存
  });
  // 清洗排版：本地跑 cleaner.cleanText 后回填（与上传页同一套默认规则）。
  // 所见即所得，用户主动点才洗，不会覆盖自己排的版；回填后需点「保存本章」才入库。
  const cleanBtn = document.createElement('button');
  cleanBtn.type = 'button';
  cleanBtn.className = 'pv-btn';
  cleanBtn.textContent = '清洗排版';
  cleanBtn.title = '用与上传页相同的规则清洗本章（去[x]脚注/Markdown/多余空行/站点残留等）。可反复点，保存后生效。';
  cleanBtn.addEventListener('click', () => {
    const cleaned = cleaner.cleanText(ta.value, cleaner.DEFAULT_CLEAN_OPTS);
    if (cleaned === ta.value) {
      toast('正文已是干净格式', 1200);
      return;
    }
    ta.value = cleaned;
    ceDraft.set(ch.key, cleaned);
    save.disabled = cleaned === (ceBase.get(ch.key) || ''); // 与库内一致 → 无改动可存
    toast('已清洗排版，保存后生效', 1400);
  });
  save.addEventListener('click', async () => {
    let ok = false;
    ceBusy('保存正文…', gen); // 加锁（此刻记下各控件的原值，解锁时照此还原）
    save.disabled = true; // 保存中必须禁用：防连点发出双请求
    // #144 P1-3：请求体与基线推进必须用**同一份快照**。原实现两处各读一次 ta.value，
    // 而加锁选择器不含 textarea —— 在飞期间打字时：新字上不了送，却被基线推进登记为
    // 「已保存」，静默丢失。捕获快照后，在飞期新输入只进草稿（下方条件保留）。
    const content = ta.value;
    try {
      const r = await api.patchChapter(ceState.id, ch.key, { content });
      // 基线推进到刚保存的内容 → 此后「与库内一致、无改动可存」。
      // 草稿只在**恰好等于刚保存内容**时清掉：若在飞期又打了新字（草稿 ≠ content），
      // 无条件 delete 会把它们连着「已保存」的假象一起丢掉。
      // ⚠️ 弹层已关 / 已换书时必须跳过：ceBase 的键是「章 key」，跨书同 key 必撞
      //（各书都是 '1'/'2'…）→ 新书那一章展开时会显示**旧书**的正文，用户一保存就写坏。
      // 「已保存」的反馈照旧要给（缺陷 3 的契约：服务端已成功就不能沉默）→ 只包状态写入。
      if (ceAliveAt(gen)) {
        ceBase.set(ch.key, content);
        if (ceDraft.get(ch.key) === content) ceDraft.delete(ch.key);
        ceState.words = r.wordCount;
        ceState.dirty = true;
      }
      ceStatRefresh(gen); // 世代已失配则自动跳过（缺陷 3：不让迟到写把成功误报成失败）
      toast('本章正文已保存', 1400);
      ok = true;
    } catch (e) {
      toast('保存失败：' + (e.message || e), 2600);
    } finally {
      ceBusy('', gen);
      // ⚠️ 必须写在 ceBusy('') **之后**：解锁会把控件还原成加锁前记下的原值（此刻是 false），
      // 写在之前会被解锁悄悄覆盖 → 保存成功后按钮重新可点，再点就对**零变化**内容发一次
      // PATCH（服务端不比对内容：正文对象重写 + cleanVer 空转 +1 + 索引写）。
      // 也不能提到 ceBusy 之前：那样解锁会把「失败要放行重试」一并吃掉（比原缺陷更严重）。
      // 成功 → 禁用（无改动可存）；失败 → 可点（允许重试）。
      save.disabled = ok;
    }
  });
  acts.append(tip, cleanBtn, save);
  bodyBox.append(ta, acts);

  const toggleBody = async () => {
    if (bodyOpen) {
      bodyBox.classList.add('hidden');
      bodyOpen = false;
      return;
    }
    if (!ceBase.has(ch.key)) {
      ta.value = '';
      try {
        const meta0 = await api.bookMeta(ceState.id); // 拉最新 cleanVer 防缓存击穿失效
        const txt = await api.chapter(ceState.id, ch.key, meta0.cleanVer || 1);
        // ⚠️ 守卫必须在写缓存**之前**：原实现在 ceBase.set 之后才判 → 拉取期间关弹层/
        // 换到另一本书时，这份正文照样进了 ceBase（同 key 撞车 → 新书显示旧书正文）。
        if (!ceAliveAt(gen)) return;
        ceBase.set(ch.key, txt);
      } catch (e) {
        toast('正文加载失败：' + (e.message || e), 2600);
        return;
      }
      if (!ceAliveAt(gen)) return; // 拉取期间弹层被关/被换 → 不回填（写下去碰的是别人的 DOM）
    }
    // 统一回填（不论缓存是否命中）：有草稿用草稿（重绘前未保存的改动），否则用基线。
    // ⚠️ 旧实现只在「缓存未命中」分支回填 → 重绘后（新建的 textarea）展开是一片空白；
    //    用户若在空白框里敲几个字再保存，整章正文会被那几行字替换掉。
    ta.value = ceDraft.has(ch.key) ? ceDraft.get(ch.key) : (ceBase.get(ch.key) || '');
    save.disabled = ta.value === (ceBase.get(ch.key) || ''); // 与库内一致 → 无改动可存
    bodyBox.classList.remove('hidden');
    bodyOpen = true;
    ta.focus();
  };

  // 删除：双段确认（3s 内再点一次才执行）
  const delBtn = pvIconBtnSvg('x', '删除本章（连点两次确认）', () => {}, true);
  let armed = false;
  let armTimer = null;
  delBtn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      delBtn.textContent = '确认删除'; // 文字提示比图标更醒目
      armTimer = setTimeout(() => {
        armed = false;
        delBtn.innerHTML = IC.x; // 恢复图标
      }, 3200);
      return;
    }
    clearTimeout(armTimer);
    ceDelete(ch);
  });

  const editBtn = pvIconBtn('正文', '查看 / 替换本章正文', () => toggleBody().catch(() => {}));
  const insBtn = pvIconBtnSvg('plus', '在本章后插入一章', () => ceInsert(ch.key));
  line.append(idx, input, editBtn, insBtn, delBtn);
  li.append(line, bodyBox);
  return li;
}

async function ceDelete(ch) {
  const gen = ceGen; // 捕获本次操作所属的世代：await 之后的写以它为判据
  ceBusy('删除中…', gen);
  try {
    const r = await api.deleteChapter(ceState.id, ch.key);
    // #144 P2-9：ceState 是模块级且 ceState.chapters 的 key 全书通用 —— 弹层已关/已换书
    //（世代失配）时迟到返回的删除响应会直写 ceState，污染下一本书的编辑弹层章表
    //（stat 行的 ceStatRefresh(gen) 有守卫，ceState 本体没有）。失配即整体放弃。
    if (!ceAliveAt(gen)) return;
    ceState.chapters = ceState.chapters.filter((c) => c.key !== ch.key);
    ceState.count = r.chapterCount;
    ceState.words = r.wordCount;
    ceState.dirty = true;
    ceBase.delete(ch.key);
    ceDraft.delete(ch.key);
    ceStatRefresh(gen);
    renderCeList(gen);
    toast('已删除本章', 1400);
  } catch (e) {
    toast('删除失败：' + (e.message || e), 2600);
  } finally {
    ceBusy('', gen);
  }
}

async function ceInsert(afterKey) {
  const gen = ceGen; // 捕获本次操作所属的世代：await 之后的写以它为判据
  ceBusy('插入中…', gen);
  try {
    const body = afterKey ? { after: afterKey, title: '新章', content: '' } : { title: '新章', content: '' };
    const r = await api.insertChapter(ceState.id, body);
    if (ceAliveAt(gen)) ceState.dirty = true; // #145 P3-12a：同 P2-8 家族，迟到写不碰下一弹层
    // #144 P2-8：插入请求已成功（章已在服务端落位），随后的刷新失败**必须分段报错**——
    // 二段 await 共用一个 catch 会把「已插入」报成「插入失败」，诱导用户重试 → 真插出两章
    //（与 3cd06e7 修的「迟到写误报失败」同一族，只是失败点换到了刷新段）。
    try {
      await refreshCeFromServer(gen);
    } catch {
      if (ceAliveAt(gen)) toast('已插入，但章表刷新失败，请关闭弹层重新打开核对', 2800);
      return;
    }
    if (!ceAliveAt(gen)) return; // #144 P2-9 同款守卫：刷新期间弹层已关/换书 → 不再写
    toast('已插入「' + r.title + '」，可改标题/正文', 1600);
  } catch (e) {
    toast('插入失败：' + (e.message || e), 2600);
  } finally {
    ceBusy('', gen);
  }
}

/** 结构变化后以服务端为准刷新章表（顺序/编号/字数） */
async function refreshCeFromServer(gen) {
  const meta = await api.bookMeta(ceState.id);
  if (!ceAliveAt(gen)) return; // #144 P2-9：弹层已关/已换书 → ceState 是下一本书的，不能写
  ceState.chapters = (meta.chapters || []).map((c) => ({ key: c.key, title: c.title }));
  ceState.count = meta.chapterCount || ceState.chapters.length;
  ceState.words = meta.wordCount || 0;
  ceStatRefresh(gen);
  renderCeList(gen);
}

async function finishChapterEditor() {
  const { id, dirty } = ceState;
  ceGen = 0; // 先复位世代：closeModal 之后本弹层的所有在飞写都作废
  host().closeModal();
  if (!dirty) return;
  await host().loadShelf().catch(() => {});
  const off = await offline.getBook(id).catch(() => null);
  toast(off ? '已保存。若曾下载离线整本，请到阅读页重新 ⤓ 离线 同步' : '已保存', 2800);
}
