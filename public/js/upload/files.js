/* upload/files.js — 上传页入口与文件处理（选文件 / 拖入 / 粘贴 / 批量导入）
 *
 * 三条入场口（input change / drop / paste）最终都汇到 handleFiles：
 *   · 多个文件 → importBatch（串行逐本，一次一本避免内存峰值叠加）
 *   · 单个文件 → prepareFile（读字节建会话 → runPreview）
 * 上传进行中一律在 handleFiles 里被 isBusy() 拦下（防当前会话被换掉后串台）。
 */
import { els } from '../dom.js';
import { api } from '../store.js';
import { CHAPTER_MAX } from '../shared-const.js';
import { busy, busyDone, toast } from '../ui.js';
import { host } from './ctx.js';
import { hint, prepareFile } from './prepare.js';
import { runPreview } from './preview.js';
import { setProg, uploadChapters } from './upload.js';
import * as upSession from './session.js';

export function openUpload(opts = {}) {
  host().showView('upload');
  host().refreshPresetTags(); // 每次进上传页后台刷新 top20（快照先显示，不阻塞；打了新标签立刻跟进）
  els.upForm.reset();
  els.upFile.value = '';
  els.upClean.checked = true;
  els.upCleanOpts.classList.remove('off');
  els.upKeepRaw.checked = true;
  els.upPrev.classList.add('hidden');
  els.upDetected.textContent = '';
  els.encWrap.classList.add('hidden');
  els.encManual.classList.add('hidden');
  els.upEncoding.innerHTML = '<option value="auto">自动检测</option>';
  els.upUpdateHint.classList.add('hidden');
  els.upProgWrap.classList.add('hidden');
  els.upConfirm.disabled = true;
  upSession.clear();
  host().syncPresetChips(); // 重洗/新建都会重置标签输入 → 同步常用分类 chips 高亮
  if (opts.book) {
    // 重新清洗入口
    upSession.begin({
      updating: { id: opts.book.id, op: 'replace', book: opts.book },
      // title 必须带上：runPreview 用它做 fallbackTitle，缺失时 cleaners 检测不到书名会退成 "undefined"
      title: opts.book.title || '',
      bytes: null,
      keepRaw: true,
    });
    els.upHead.textContent = '重新清洗';
    els.upTitle.value = opts.book.title || '';
    els.upAuthor.value = opts.book.author || '';
    els.upTags.value = (opts.book.tags || []).join(', ');
    host().syncPresetChips();
    els.upNote.value = opts.book.note || '';
    hint(`正在用原件重新清洗《${opts.book.title}》，确认后整本替换`);
    busy(0.05, '下载原件…');
    const bookId = opts.book.id;
    const sameSession = () => {
      const s = upSession.current();
      return !!(s && s.updating && s.updating.id === bookId);
    };
    api.rawBytes(bookId)
      .then((bytes) => {
        // 下载期间用户可能又选了别的文件（会话已被替换）→ 丢弃这次回调，避免数据串台
        if (!sameSession()) return;
        upSession.current().bytes = bytes;
        runPreview();
      })
      .catch((e) => {
        if (!sameSession()) return; // 同理：会话已切换就别把用户踢回书架
        toast('原件下载失败（可能未留档）：' + (e.message || e), 3000);
        host().showView('shelf');
      })
      .finally(busyDone);
    return;
  }
  els.upHead.textContent = '上传小说';
  els.upUpdateHint.classList.add('hidden');
}

export async function handleFiles(files) {
  if (!files.length) return;
  // 上传进行中冻结会话：此时换文件会把当前会话换掉，而正文与原件要等到 await 之后才读
  // → 章节表来自旧文件、正文与原件来自新文件，产出「标题A/正文B」的坏书且全程无报错。
  if (upSession.isBusy()) {
    els.upFile.value = ''; // 复位，否则下次选同一个文件 change 不再触发
    toast('上传进行中，请等本次完成后再换文件', 2600);
    return;
  }
  if (files.length > 1) {
    await importBatch(files);
    return;
  }
  const f = files[0];
  upSession.clear();
  els.upPrev.classList.add('hidden');
  await prepareFile(f);
}

/** 多文件批量导入（P1）：串行逐本 cleaner → 自动入库，一次一本避免浏览器内存峰值叠加。
 * 作者/标签/备注取上传表单当前值，作为这一批的统一默认值；书名取文件名；
 * 与书架同名的自动跳过（批量不逐本弹窗）。上传复用 bulk 通道。 */
async function importBatch(files) {
  const n = files.length;
  const author = els.upAuthor.value.trim();
  const tags = host().parseTagInput(els.upTags.value);
  const note = els.upNote.value.trim();
  const keepRaw = els.upKeepRaw.checked;
  const summary = `作者「${author || '空'}」· 标签「${tags.join('、') || '空'}」· 备注「${note || '空'}」`;
  if (!(await host().confirmModal(`将对 ${n} 本书批量导入。书名取文件名，以下信息统一应用到这批：${summary}。与书架同名的自动跳过。继续？`, `导入 ${n} 本`))) {
    // 取消：必须复位文件输入（L10）。否则 input.value 仍是这一批文件名，
    // 用户改主意后重选同一批文件不触发 change 事件 —— 表现为"点了没反应"。
    els.upFile.value = '';
    return;
  }

  let ok = 0;
  let skip = 0;
  let fail = 0;
  let rawFail = 0; // 原件上传失败本数（书仍入库，重洗不可用）
  upSession.setImporting(true);
  els.upProgWrap.classList.remove('hidden');
  els.upConfirm.disabled = true;
  let lastBooks = null;
  try {
    for (let i = 0; i < n; i++) {
      const file = files[i];
      const title = file.name.replace(/\.(txt|text)$/i, '').trim() || ('未命名_' + (i + 1));
      setProg(i / n, `处理 ${i + 1}/${n}：《${title}》`);
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        const sess = { title, bytes: buf, updating: null, keepRaw };
        upSession.begin(sess);
        runPreview();
        els.upConfirm.disabled = true; // runPreview→updateConfirmBtn 会重启用按钮，这里再压住
        const preview = upSession.current().preview;
        if (!preview || !preview.chapters.length) {
          fail++;
          continue;
        }
        const payload = {
          title,
          author,
          tags,
          note,
          chapters: preview.chapters.slice(0, CHAPTER_MAX).map((c) => c.title),
          wordCount: preview.words || 0,
          cleanVer: 1,
        };
        const created = await api.createBook(payload);
        if (created.duplicate && created.needCreate && created.book) {
          skip++; // 同名 → 跳过（批量不弹窗确认）
          continue;
        }
        upSession.setCreatedId(created.id);
        const pub = await uploadChapters(created.id, created.chapterKeys, keepRaw, sess);
        if (pub && pub.books) lastBooks = pub.books; // 旧版 worker 才回传快照；新版不回传 → 收尾统一 loadShelf()
        upSession.setCreatedId(null);
        ok++;
        if (pub && pub.rawFailed) rawFail++; // raw 失败不算失败：书已入库，仅重洗不可用
      } catch (e) {
        fail++;
        if (upSession.createdId()) {
          // 失败时把停在 creating 的半成品移入回收站，不留孤儿数据
          await api.deleteBook(upSession.createdId()).catch(() => {});
          upSession.setCreatedId(null);
        }
      }
      setProg((i + 1) / n, `完成 ${ok + skip + fail}/${n}（成功 ${ok}）`);
    }
  } finally {
    upSession.setImporting(false);
    els.upProgWrap.classList.add('hidden');
    els.upConfirm.disabled = false;
  }
  upSession.clear();
  els.upFile.value = '';
  toast([`成功 ${ok} 本`, skip ? `同名跳过 ${skip} 本` : '', fail ? `失败 ${fail} 本` : '', rawFail ? `原件缺失 ${rawFail} 本（重洗不可用）` : ''].filter(Boolean).join(' · '), 3200);
  host().showView('shelf');
  if (lastBooks) await host().loadShelf({ books: lastBooks }).catch(() => {});
  else await host().loadShelf().catch(() => {}); // 刷新失败不吞结果提示
}

export function onFileChosen() {
  handleFiles(Array.from(els.upFile.files || [])).catch((e) => toast('读取失败：' + e.message, 2500));
}

export function onPasteText(e) {
  const txt = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
  if (!txt || !txt.trim()) return;
  e.preventDefault();
  if (!els.upTitle.value) els.upTitle.value = '粘贴文本_' + new Date().toISOString().slice(0, 10);
  upSession.begin({
    title: els.upTitle.value.trim(),
    bytes: new TextEncoder().encode(txt),
    keepRaw: false,
    updating: null,
  });
  hint('已粘贴文本（不计原件留档）');
  runPreview();
}
