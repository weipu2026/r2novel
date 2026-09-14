/* upload/editor.js — 书架「编辑章节」（已发布书就地编辑：改标题 / 改正文 / 插章 / 删章）
 *
 * 与上传页的分章预览不同：这里操作的是**已发布**的书，每次改动即时落库（无「确认入库」），
 * 所以每个动作都是「先与服务端对齐，再以服务端返回的章表为唯一事实源重绘」。
 * 弹层里的按钮复用 preview.js 的 pvIconBtn / pvIconBtnSvg（同款细线图标语言）。
 */
import { els, $ } from '../dom.js';
import { api, fmtWords } from '../store.js';
import { toast } from '../ui.js';
import * as cleaner from '../cleaner.js';
import { offline } from '../offline.js';
import { host } from './ctx.js';
import { pvIconBtn, pvIconBtnSvg, IC } from './preview.js';

const ceState = { id: null, bookTitle: '', chapters: [], count: 0, words: 0, dirty: false };

const ceBodies = new Map(); // 已拉取的章节正文缓存 key -> text

function ceStatText() {
  return `《${ceState.bookTitle}》 · ${ceState.count} 章 · ${fmtWords(ceState.words)} · 改动即时保存`;
}

export async function openChapterEditor(b) {
  let meta;
  try {
    meta = await api.bookMeta(b.id);
  } catch (e) {
    toast('打开失败：' + (e.message || e), 2600);
    return;
  }
  ceState.id = b.id;
  ceState.bookTitle = b.title;
  ceState.chapters = (meta.chapters || []).map((c) => ({ key: c.key, title: c.title }));
  ceState.count = meta.chapterCount || ceState.chapters.length;
  ceState.words = meta.wordCount || 0;
  ceState.dirty = false;
  ceBodies.clear();
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
  els.modalBox.classList.add('ce');
  $('#ceStat', els.modalBox).textContent = ceStatText();
  $('#ceAppend', els.modalBox).addEventListener('click', () => ceInsert(null));
  $('#ceDone', els.modalBox).addEventListener('click', finishChapterEditor);
  renderCeList();
}

function ceBusy(text) {
  const el = $('#ceBusy', els.modalBox);
  if (el) el.textContent = text || '';
}

function renderCeList() {
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
  ceState.chapters.forEach((ch, i) => ul.appendChild(ceBuildRow(ch, i)));
}

/** 构造一行章节：序号 + 标题输入 + 正文/插章/删章按钮 +（可展开的正文编辑区） */
function ceBuildRow(ch, i) {
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
    ceBusy('保存标题…');
    try {
      const r = await api.patchChapter(ceState.id, ch.key, { title: v });
      ch.title = r.title; // 服务端兜底（空标题 → 第 N 章）后的规范值
      ceState.words = r.wordCount;
      ceState.dirty = true;
      input.value = ch.title;
      $('#ceStat', els.modalBox).textContent = ceStatText();
      toast('标题已保存', 1200);
    } catch (e) {
      input.value = old;
      toast('保存失败：' + (e.message || e), 2600);
    } finally {
      ceBusy('');
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
  ta.addEventListener('input', () => { save.disabled = false; });
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
    save.disabled = false; // 内容已变，放行保存
    toast('已清洗排版，保存后生效', 1400);
  });
  save.addEventListener('click', async () => {
    ceBusy('保存正文…');
    save.disabled = true;
    try {
      const r = await api.patchChapter(ceState.id, ch.key, { content: ta.value });
      ceBodies.set(ch.key, ta.value);
      ceState.words = r.wordCount;
      ceState.dirty = true;
      $('#ceStat', els.modalBox).textContent = ceStatText();
      toast('本章正文已保存', 1400);
    } catch (e) {
      save.disabled = false;
      toast('保存失败：' + (e.message || e), 2600);
    } finally {
      ceBusy('');
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
    if (!ceBodies.has(ch.key)) {
      ta.value = '';
      try {
        const meta0 = await api.bookMeta(ceState.id); // 拉最新 cleanVer 防缓存击穿失效
        const txt = await api.chapter(ceState.id, ch.key, meta0.cleanVer || 1);
        ceBodies.set(ch.key, txt);
        ta.value = txt;
      } catch (e) {
        toast('正文加载失败：' + (e.message || e), 2600);
        return;
      }
    }
    // 重开时若还保留着未保存的修改 → 不动内容也不启用保存钮之外的干扰
    if (ta.value === (ceBodies.get(ch.key) || '')) save.disabled = true;
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
  ceBusy('删除中…');
  try {
    const r = await api.deleteChapter(ceState.id, ch.key);
    ceState.chapters = ceState.chapters.filter((c) => c.key !== ch.key);
    ceState.count = r.chapterCount;
    ceState.words = r.wordCount;
    ceState.dirty = true;
    ceBodies.delete(ch.key);
    $('#ceStat', els.modalBox).textContent = ceStatText();
    renderCeList();
    toast('已删除本章', 1400);
  } catch (e) {
    toast('删除失败：' + (e.message || e), 2600);
  } finally {
    ceBusy('');
  }
}

async function ceInsert(afterKey) {
  ceBusy('插入中…');
  try {
    const body = afterKey ? { after: afterKey, title: '新章', content: '' } : { title: '新章', content: '' };
    const r = await api.insertChapter(ceState.id, body);
    ceState.dirty = true;
    await refreshCeFromServer(); // 以服务端为唯一事实源刷新顺序/编号/字数
    toast('已插入「' + r.title + '」，可改标题/正文', 1600);
  } catch (e) {
    toast('插入失败：' + (e.message || e), 2600);
  } finally {
    ceBusy('');
  }
}

/** 结构变化后以服务端为准刷新章表（顺序/编号/字数） */
async function refreshCeFromServer() {
  const meta = await api.bookMeta(ceState.id);
  ceState.chapters = (meta.chapters || []).map((c) => ({ key: c.key, title: c.title }));
  ceState.count = meta.chapterCount || ceState.chapters.length;
  ceState.words = meta.wordCount || 0;
  $('#ceStat', els.modalBox).textContent = ceStatText();
  renderCeList();
}

async function finishChapterEditor() {
  const { id, dirty } = ceState;
  host().closeModal();
  if (!dirty) return;
  await host().loadShelf().catch(() => {});
  const off = await offline.getBook(id).catch(() => null);
  toast(off ? '已保存。若曾下载离线整本，请到阅读页重新 ⤓ 离线 同步' : '已保存', 2800);
}
