/* review-fix145c.test.mjs — 2026-10-17 #145 第三轮复查（修复复验）R8–R13 的定向回归
 *
 * 背景：#145 两轮修复（24 条 + R1–R7）之后的准确性复查，发现 1 条必现回归 + 5 条残余，
 * 本文件逐条钉住。每条都对应「改回旧写法必然不通过」（反向探针 probe-reverse-fix145c.py
 * 逐条变异验证，还原后 sha 逐字节一致）。
 *
 *   R8【P1 必现回归】预览区锁判据误用 isBusy()（含 _reading）→ 首次预览后就地永久只读
 *   R9【P2】索引冲突重放里的 upsert 无守卫 → 把刚软删的书「复活」成在架+回收站双态
 *   R10【P2】boot 的世代快照取在 await 之后 → 窗口内登出/换会话时旧书架写回本地快照
 *   R11【P3】熔断判据后置（先全量读 1+K 再拒绝）+ root 损坏时熔断线 fail-open
 *   R12【P3】/api/logout 与 /api/books/:id/raw 缺 405 出口（method 不匹配落到 404）
 *   R13【P3】renderChapter 的 401 只提示不收敛；两个静默 .catch 调用方把它吃掉
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { memStore, req, call, login, makeReadyBook, readIdxBooks, countStore, writeIdxShards } from './_harness.mjs';
import { KEY } from '../src/router.js';
import * as upSession from '../public/js/upload/session.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 仓库文件是 CRLF：断言正则里的 \n 必须在归一后匹配（否则多行正则静默失配 = 假红）
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

/* ════════════ R8：预览区编辑闸不得复用「入场闸」 ════════════ */

test('R8：_reading 在飞时 isBusy 为真、但「上传/导入在飞」判据为假（两闸分离的行为基线）', () => {
  // 这是 R8 的**行为级**根因：锁预览区的判据必须是后一个表达式。
  // 旧判据 isBusy() 在「读字节 + 清洗预览」窗口里为 true，而首次预览恰好在这个窗口内同步渲染
  // → 锁上，finally 置回 _reading 后没有任何重绘 → 预览区从第一次选文件起永久只读。
  assert.deepEqual(
    [upSession.isBusy(), upSession.isUploading() || upSession.isImporting()],
    [false, false],
    '初始必须两闸皆闲'
  );
  upSession.setReading(true);
  assert.equal(upSession.isBusy(), true, '入场闸：读字节窗口必须拦住新的会话入口（P2-7 语义不得回退）');
  assert.equal(
    upSession.isUploading() || upSession.isImporting(),
    false,
    '编辑闸：读字节窗口不得算「上传在飞」—— 否则首次预览就地把预览区锁死且再无重绘解锁'
  );
  upSession.setReading(false);
  upSession.setUploading(true);
  assert.equal(upSession.isUploading() || upSession.isImporting(), true, '真正上传在飞 → 必须锁（P1-3 本意）');
  upSession.setUploading(false);
  upSession.setImporting(true);
  assert.equal(upSession.isUploading() || upSession.isImporting(), true, '批量导入在飞 → 必须锁');
  upSession.setImporting(false);
  assert.equal(upSession.isBusy(), false, '全部复位');
});

test('R8：renderPreviewChapters 的锁判据是 isUploading()||isImporting()，且仍在该处最后一环', () => {
  const src = read('public/js/upload/preview.js');
  // 行首锚定：注释里出现同样的词不会喂假绿（注释行以 // 开头，匹配不到 ^\s*if）
  // #146 P2-6：判据搬进 syncPreviewLock()（锁/解锁双向同步），调用点仍行首锚定
  const ok = /^\s*syncPreviewLock\(\);$/m.exec(src);
  assert.ok(ok, '渲染完成后必须调用 syncPreviewLock()');
  const fnAt = src.indexOf('export function syncPreviewLock()');
  assert.ok(fnAt > 0, '缺少 syncPreviewLock');
  const fnEnd = src.indexOf('\n}', fnAt);
  const fnBody = src.slice(fnAt, fnEnd > 0 ? fnEnd + 2 : fnAt + 500);
  assert.match(
    fnBody,
    /const locked = upSession\.isUploading\(\) \|\| upSession\.isImporting\(\);/,
    '锁判据必须是「上传/导入在飞」——isBusy() 含 _reading，会让首次预览永久锁死'
  );
  assert.doesNotMatch(fnBody, /isBusy\(\)/, '不得改回 isBusy()（编辑闸与入场闸必须分离）');
  // 锁必须发生在所有行渲染之后（addLi 追加之后），否则一行都锁不到
  const i = ok.index;
  const before = src.slice(0, i);
  assert.ok(
    before.lastIndexOf('ul.appendChild(addLi);') > before.lastIndexOf('chs.slice(0, MAX_PREVIEW).forEach'),
    '锁定调用必须在全部行（含末尾追加行）渲染完之后'
  );
});

/* ════════════ R9：索引冲突重放的 upsert 需要回收站守卫 ════════════ */

test('R9：publish 的索引冲突重放不得把并发软删的书「复活」成在架+回收站双态', async () => {
  const base = memStore();
  const cookie = await login(base);
  // 先有一本书，让索引（root + s0）成型：本次 publish 走「更新」路径（root 先落）
  await makeReadyBook(base, cookie, '基准书', 1);

  const { id, keys } = await (async () => {
    const r = await call(
      base,
      req('/api/books', {
        method: 'POST',
        cookie,
        body: { title: '冲突重放书', author: '作者', tags: [], chapters: ['第1章 章1'], wordCount: 10, cleanVer: 1 },
      })
    );
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const libId = r.data.id;
    await call(base, req(`/api/books/${libId}/chapters/1`, { method: 'PUT', cookie, body: '第1章正文' }));
    await call(base, req(`/api/books/${libId}/raw`, { method: 'PUT', cookie, body: new TextEncoder().encode('raw') }));
    return { id: libId, keys: ['1'] };
  })();
  assert.deepEqual(keys, ['1']);

  // 确定性注入「窗口内的并发软删 + 索引 CAS 冲突」：
  // 第一次索引写（root 或分片，一律拦）返回 null = 盘面已被别人改过 → router 抛 IDX_CONFLICT；
  // 同一时刻把书真写进 trash.json（与 apiSoftDelete 的产物同形），模拟另一路请求刚把它软删。
  // 只拦一次：重放那一轮必须能正常落盘，否则测的是另一条路径。
  let armed = false;
  const racer = {
    ...base,
    async putTextIf(k, s, etag) {
      if (!armed && /^meta\/idx\//.test(k)) {
        armed = true;
        await base.putText(KEY.TRASH, JSON.stringify({ books: [{ id, title: '冲突重放书', deletedAt: Date.now() }] }));
        return null; // CAS 冲突
      }
      return base.putTextIf(k, s, etag);
    },
  };

  const r = await call(racer, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.equal(armed, true, '注入点没被触发 —— 用例前提失效（publish 必须走到索引写）');
  assert.equal(r.status, 409, '重放前复检到回收站 → 必须按「在回收站」拒绝：' + JSON.stringify(r.data));
  assert.match(String(r.data.error), /回收站/, '错误文案要与另外两处 trash 拒绝点一致');

  const shelf = (await readIdxBooks(base)) || [];
  assert.ok(
    !shelf.some((b) => b.id === id),
    '索引里**不能**出现它（旧实现：重放的 upsert 无条件上架 → 在架+回收站双态，随后 purgeOnce 删掉一本在架书）'
  );
  const trash = JSON.parse((await base.getText(KEY.TRASH)) || '{"books":[]}');
  assert.ok(
    trash.books.some((b) => b.id === id),
    '它必须留在回收站里（可恢复、可重发发布）'
  );
});

/* ════════════ R10：boot 的世代快照必须取在 await 之前 ════════════ */

test('R10：boot 在 await api.books() 之前取世代快照，响应到达后先复检再动视图/快照', () => {
  const app = read('public/js/app.js');
  const b = app.indexOf('async function boot()');
  assert.ok(b > 0, '找不到 boot');
  const body = app.slice(b, app.indexOf('\nfunction showView(', b));
  const snapAt = body.indexOf('const seq0 = shelfSeq;');
  const awaitAt = body.indexOf('await api.books()');
  const recheckAt = body.indexOf('if (seq0 !== shelfSeq) return;');
  const viewAt = body.indexOf("if (!inOtherView) showView('shelf');");
  assert.ok(snapAt >= 0, '缺少世代快照（没有它，loadShelf 里的 ++shelfSeq 分配在响应之后 → 必然追平）');
  assert.ok(snapAt < awaitAt, '快照必须取在 await **之前**（之后取 = 永远追平当前世代，守卫形同虚设）');
  assert.ok(recheckAt > awaitAt, '响应到达后必须立刻复检世代');
  assert.ok(recheckAt < viewAt, '复检必须在动视图之前（否则登录页会被前任书架顶掉）');
  // catch 分支同判据：窗口内新会话登录成功时，别把刚登录的人踢回登录页
  const catchAt = body.indexOf('} catch (e) {');
  assert.ok(catchAt > 0, '找不到 boot 的 catch');
  assert.match(
    body.slice(catchAt, catchAt + 700),
    /if \(seq0 !== shelfSeq\) return;/,
    'catch 分支也要复检（新会话刚登录成功时，boot 的 401 收敛会把人踢回登录页）'
  );
});

/* ════════════ R11：熔断判据必须在全量读之前 ════════════ */

/** 造一个「root 声明 n 片」的库（片内容为空，只为让旧实现真的读得动） */
async function seedShards(store, n) {
  await writeIdxShards(store, Array.from({ length: n }, () => []));
}

test('R11：标签合并超限时只读 root 就熔断（旧实现先把 1+K 片全读一遍再拒绝）', async () => {
  const base = memStore();
  const cookie = await login(base);
  await seedShards(base, 50);
  const c = countStore(base);
  const r = await call(c, req('/api/tags', { method: 'POST', cookie, body: { from: '甲', to: '乙' } }));
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.match(String(r.data.error), /50 片/, '要如实报出分片数');
  assert.ok(
    c._count.get <= 2,
    `超限判据必须在读分片之前（实测 get=${c._count.get}；旧实现是 1+50=51，等于把 50 个子请求烧在必然拒绝的读上）`
  );
});

test('R11：残留清理超限时只读 root 就熔断（同判据，2+K ≥ 45 ⇔ K > 42）', async () => {
  const base = memStore();
  const cookie = await login(base);
  await seedShards(base, 50);
  const c = countStore(base);
  const r = await call(
    c,
    req('/api/diag/orphans', { method: 'DELETE', cookie, body: { objects: ['text/nope/1.txt'] } })
  );
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.match(String(r.data.error), /50 片/);
  assert.ok(c._count.get <= 2, `超限时不得读分片（实测 get=${c._count.get}，旧实现 51+）`);
});

test('R11：root 损坏时用 root.bak 拿分片数，熔断线不得 fail-open', async () => {
  const base = memStore();
  const cookie = await login(base);
  await seedShards(base, 50);
  await base.putText('meta/idx/root.json', '这不是 JSON'); // 只坏主 root，bak 仍是 50 片的合法布局
  const c = countStore(base);
  const r = await call(c, req('/api/tags', { method: 'POST', cookie, body: { from: '甲', to: '乙' } }));
  assert.equal(r.status, 409, '主 root 坏但 bak 说明 50 片 → 仍必须熔断：' + JSON.stringify(r.data));
  assert.match(String(r.data.error), /50 片/, '分片数来自 root.bak');
  assert.ok(
    c._count.get <= 3,
    `root 坏 + 超限时也只需 root + bak 两次读（实测 get=${c._count.get}；旧实现 fail-open → 读 bak 再读 50 片）`
  );
});

/* ════════════ R12：两个子路由的 405 出口 ════════════ */

test('R12：/api/logout 与 /api/books/:id/raw 的 method 不匹配回 405（不再落到 404）', async () => {
  const base = memStore();
  const cookie = await login(base);
  const wrong = [
    ['GET', '/api/logout'],
    ['PUT', '/api/logout'],
    ['POST', '/api/books/abcdef123456/raw'],
    ['DELETE', '/api/books/abcdef123456/raw'],
  ];
  for (const [method, p] of wrong) {
    const r = await call(base, req(p, { method, cookie, body: method === 'GET' ? undefined : { a: 1 } }));
    assert.equal(r.status, 405, `${method} ${p} 应 405（不能落到 404「没有这个端点」）`);
    assert.equal(r.data.error, 'method');
    assert.match(r.headers.get('content-type') || '', /json/);
  }
});

/* ════════════ R13：renderChapter 的 401 必须自己收敛 ════════════ */

test('R13：renderChapter 的 401 自收敛 + sessionExpired 幂等 + openBook 重新武装', () => {
  const src = read('public/js/reader.js');
  const rc = src.indexOf('async function renderChapter(');
  assert.ok(rc > 0, '找不到 renderChapter');
  const rcBody = src.slice(rc, src.indexOf('\nasync function', rc + 10));
  // 401 分支：必须走 sessionExpired 并继续 throw（不能只 showTip —— 三个调用方里有两个是
  // 静默 .catch(() => {})，抛出去的 401 被吃掉，用户对着空白正文困在阅读器里）
  assert.match(
    rcBody,
    /if \(e instanceof ApiError && e\.status === 401\) \{[\s\S]{0,900}?sessionExpired\(\);\s*\n\s*throw e;/,
    '401 分支必须自己 sessionExpired() 再 throw（收敛不能指望调用方）'
  );
  // 幂等：一次过期只收敛一次（401 成串到达 + goto 那条 catch 会再调一次）
  assert.match(src, /let expiredOnce = false;/, '缺少幂等标记');
  assert.match(src, /if \(expiredOnce\) return;/, 'sessionExpired 必须幂等');
  // 重新武装：进入阅读器 = 新的会话尝试
  assert.match(
    src,
    /export async function openBook\(id\) \{\s*\n\s*const seq = \+\+openSeq;\s*\n\s*expiredOnce = false;/,
    'openBook 必须重新武装 401 收敛（否则重新登录后 401 不再收敛）'
  );
  // openBook 自己的 401 上抛由 app.js 的 openRead 收敛（复核结论：无需改动，钉住别退化）
  const app = read('public/js/app.js');
  const or = app.indexOf('async function openRead(');
  assert.match(app.slice(or, or + 400), /if \(handleAuth\(e\)\) return;/, 'openRead 必须收敛 openBook 抛出的 401');
});
