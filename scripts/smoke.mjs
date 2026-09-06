/* smoke.mjs — 对运行中的 dev-server / 生产站点做端到端冒烟
 * 用法：npm run dev（另开终端）→ node scripts/smoke.mjs
 *       生产冒烟：SMOKE_BASE=https://… SMOKE_PASSWORD=… SMOKE_CLEANUP=1 node scripts/smoke.mjs
 * 完整走一遍：登录 → 建书 → 传章(3) → 传 raw → 发布 → 书架/目录/读章/进度 → M2 管理。
 * SMOKE_CLEANUP=1：结束后自动彻底删除本次创建的测试书（CI 生产冒烟用，不留垃圾）；
 *                  遇到同名遗留测试书也会先清掉再重建，保证可重复执行。
 */
const BASE = process.env.SMOKE_BASE || 'http://localhost:8088';
const PASS = process.env.SMOKE_PASSWORD || requireEnv('ADMIN_PASSWORD') || '';
const CLEANUP = process.env.SMOKE_CLEANUP === '1';

function requireEnv(n) {
  return process.env[n] || '';
}

let cookie = '';
const failures = [];
const created = []; // 本次冒烟创建的书 id（收尾清理用）
function check(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else {
    failures.push(name);
    console.error('  ✗ ' + name + (extra ? '  → ' + extra : ''));
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined && typeof body !== 'string') {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers, body });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers, text };
}

/** 软删 + 彻底删除一本书（收尾清理用；对已删/不存在的 id 幂等无害） */
async function purgeBook(id) {
  if (!id) return;
  await api(`/api/books/${id}`, { method: 'DELETE' }).catch(() => {});
  let r = await api(`/api/trash/${id}`, { method: 'DELETE' });
  for (let i = 0; r && r.data && r.data.remaining > 0 && i < 60; i++) {
    r = await api(`/api/trash/${id}`, { method: 'DELETE' });
  }
}

function gbkBytes() {
  // '第一章 中文\n这是测试。\n第二章 小字' 的 GBK 码位（与单测同源）
  return Uint8Array.from([
    0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0x0a,
    0xd5, 0xe2, 0xca, 0xc7, 0xb2, 0xe2, 0xca, 0xd4, 0xa1, 0xa3, 0x0a,
    0xb5, 0xda, 0xb6, 0xfe, 0xd5, 0xc2, 0x20, 0xd0, 0xa1, 0xd7, 0xd6,
  ]);
}

async function main() {
  console.log('r2novel smoke → ' + BASE);

  let r = await api('/');
  check('首页 HTML 可达', r.status === 200 && typeof r.text === 'string' && r.text.includes('书屋'));

  r = await api('/js/main.js');
  check('前端 JS 可达', r.status === 200);

  r = await api('/api/books');
  check('未登录 401', r.status === 401);

  r = await api('/api/login', { method: 'POST', body: { password: 'wrong' } });
  check('错口令 401', r.status === 401);

  r = await api('/api/login', { method: 'POST', body: { password: PASS } });
  check('登录成功', r.status === 200);
  const sc = r.headers.get('set-cookie') || '';
  const m = /rn_session=([^;]+)/.exec(sc);
  check('下发会话 cookie', !!m);
  cookie = 'rn_session=' + m[1];

  const mkSmoke = () =>
    api('/api/books', { method: 'POST', body: { title: '冒烟测试书', author: 'smoke', tags: ['测试'], chapters: ['第一章 起', '第二章 承', '第三章 合'] } });
  r = await mkSmoke();
  if (r.data.duplicate && CLEANUP) {
    // CI 幂等：清掉上次冒烟遗留的同名书（含被改过名的）再重建
    const lr = await api('/api/books');
    for (const b of (lr.data.books || []).filter((x) => /^冒烟测试书/.test(x.title || ''))) await purgeBook(b.id);
    r = await mkSmoke();
  }
  check('建书', r.status === 200 && r.data.id, r.data && r.data.duplicate ? '已存在同名《冒烟测试书》（加 SMOKE_CLEANUP=1 可自动清理后重跑）' : '');
  const id = r.data.id;
  if (id) created.push(id);

  for (let i = 0; i < 3; i++) {
    r = await api(`/api/books/${id}/chapters/${i + 1}`, { method: 'PUT', body: '第' + (i + 1) + '章正文内容，用于端到端冒烟。' });
    check(`传章 ${i + 1}`, r.status === 200);
  }

  // raw：真实 GBK 原件直传
  r = await fetch(`${BASE}/api/books/${id}/raw`, { method: 'PUT', headers: { Cookie: cookie, 'content-type': 'application/octet-stream' }, body: gbkBytes() });
  check('raw 原件上传(GBK)', r.status === 200);

  r = await api(`/api/books/${id}/publish`, { method: 'POST' });
  check('发布', r.status === 200 && r.data.chapterCount === 3);

  r = await api('/api/books');
  check('书架可见', r.status === 200 && r.data.books.some((b) => b.id === id));

  r = await api(`/api/books/${id}`);
  check('目录（3 章）', r.status === 200 && r.data.chapters.length === 3);

  r = await api(`/api/books/${id}/chapters/2`);
  check('读第 2 章正文', r.status === 200 && r.text.includes('第2章正文内容'));

  r = await api(`/api/progress/${id}`, { method: 'PUT', body: { ch: 2, ratio: 0.6 } });
  check('存进度', r.status === 200);
  r = await api(`/api/progress/${id}`);
  check('读进度一致', r.status === 200 && r.data.ch === 2 && Math.abs(r.data.ratio - 0.6) < 1e-6);

  r = await api('/api/logout', { method: 'POST' });
  check('登出', r.status === 200);
  cookie = '';
  r = await api('/api/books');
  check('登出后 401', r.status === 401);

  if (failures.length) {
    console.error('\n冒烟失败 ' + failures.length + ' 项：' + failures.join('、'));
    process.exit(1);
  }
  console.log('\n冒烟全部通过 ✓');

  /* ============== M2 书库管理链路 ============== */
  console.log('\n[ M2 书库管理 ]');
  failures.length = 0;
  cookie = '';
  r = await api('/api/login', { method: 'POST', body: { password: PASS } });
  const sc2 = r.headers.get('set-cookie') || '';
  const m2 = /rn_session=([^;]+)/.exec(sc2);
  cookie = 'rn_session=' + m2[1];
  check('M2 登录', r.status === 200);

  // 建 3 本书，分别用于 duplicate / 替换 / 回收站测试
  async function mkBook(title, n = 3) {
    const chapters = Array.from({ length: n }, (_, i) => '第' + (i + 1) + '章');
    const body = { title, author: 'smoke', tags: ['测试'], chapters, wordCount: n * 10, cleanVer: 1 };
    let r1 = await api('/api/books', { method: 'POST', body });
    if (r1.data.duplicate && CLEANUP) {
      const lr = await api('/api/books');
      for (const b of (lr.data.books || []).filter((x) => x.title === title || /^M2 测试书/.test(x.title || ''))) await purgeBook(b.id);
      r1 = await api('/api/books', { method: 'POST', body });
    }
    if (r1.data.duplicate) throw new Error('M2 测试时检测到已有同名书《' + title + '》（加 SMOKE_CLEANUP=1 可自动清理后重跑）');
    const id = r1.data.id;
    created.push(id);
    for (let i = 0; i < n; i++) {
      await api(`/api/books/${id}/chapters/${i + 1}`, { method: 'PUT', body: '第' + (i + 1) + '章正文' + title });
    }
    await api(`/api/books/${id}/publish`, { method: 'POST' });
    return id;
  }
  const idDup = await mkBook('M2 测试书 A', 3);
  const idReplace = await mkBook('M2 测试书 B', 3);
  const idTrash = await mkBook('M2 测试书 C', 2);
  check('M2 建书 A/B/C', !!idDup && !!idReplace && !!idTrash);

  // 同名去重
  r = await api('/api/books', { method: 'POST', body: { title: 'M2 测试书 A', chapters: ['x'], wordCount: 1 } });
  check('M2 同名 → duplicate=true', r.status === 200 && r.data.duplicate === true);
  r = await api('/api/books', { method: 'POST', body: { title: 'M2 测试书 A（副本）', chapters: ['x'], wordCount: 1 } });
  check('M2 不同名 → duplicate=false', r.data.duplicate === false);

  // PATCH 改书名 / 作者 / 标签 / 置顶
  r = await api(`/api/books/${idDup}`, { method: 'PATCH', body: { title: 'M2 测试书 A（已改名）', tags: ['玄幻', '完结'], pinned: true } });
  check('M2 PATCH 元信息', r.status === 200);
  r = await api(`/api/books/${idDup}`);
  check('M2 改后 meta 生效', r.data.title === 'M2 测试书 A（已改名）' && r.data.pinned === true);
  r = await api('/api/books');
  const bA = r.data.books.find((x) => x.id === idDup);
  check('M2 置顶镜像进 index', bA && bA.pinned === true);
  check('M2 改标签镜像进 index', bA && bA.tags.includes('玄幻'));

  // 进度镜像（书架角标数据源）
  await api(`/api/progress/${idReplace}`, { method: 'PUT', body: { ch: 2, ratio: 0.5 } });
  r = await api('/api/books');
  const bR = r.data.books.find((x) => x.id === idReplace);
  check('M2 进度写入 index 镜像', bR && bR.prog && bR.prog.ch === 2);

  // 更新已有书 - 替换模式
  await api(`/api/progress/${idReplace}`, { method: 'PUT', body: { ch: 2, ratio: 0.7 } });
  r = await api(`/api/books/${idReplace}/chapters`, {
    method: 'POST',
    body: { op: 'replace', chapters: ['第2章', '第1章', '新章 终'], wordCount: 30 },
  });
  check('M2 update replace 重建章表', r.status === 200 && r.data.chapterKeys.length === 3);
  for (let i = 0; i < 3; i++) await api(`/api/books/${idReplace}/chapters/${i + 1}`, { method: 'PUT', body: '新正文' + i });
  await api(`/api/books/${idReplace}/publish`, { method: 'POST' });
  r = await api(`/api/books/${idReplace}`);
  check('M2 replace 后 cleanVer+1', r.data.cleanVer === 2 && r.data.chapters[0].title === '第2章');
  r = await api(`/api/progress/${idReplace}`);
  check('M2 replace 进度按同名标题保留（第2章 → 新表第 1）', r.data.ch === 1 && Math.abs(r.data.ratio - 0.7) < 1e-6);

  // 更新已有书 - 追加模式
  r = await api(`/api/books/${idReplace}/chapters`, {
    method: 'POST',
    body: { op: 'append', chapters: ['追加1', '追加2'] },
  });
  check('M2 append key 续接', r.data.chapterKeys.length === 5 && r.data.chapterKeys[3] === '4' && r.data.chapterKeys[4] === '5');
  for (const k of ['4', '5']) await api(`/api/books/${idReplace}/chapters/${k}`, { method: 'PUT', body: '追加' + k });
  await api(`/api/books/${idReplace}/publish`, { method: 'POST' });
  r = await api(`/api/books/${idReplace}`);
  check('M2 append 后共 5 章', r.data.chapterCount === 5);

  /* ============== v1.1 已发布书章节就地编辑 ============== */
  console.log('\n[ v1.1 章节编辑 ]');
  // 改标题 + 改正文
  r = await api(`/api/books/${idReplace}/chapters/3`, { method: 'PATCH', body: { title: '新章 终（改名）' } });
  check('v1.1 PATCH 改标题', r.status === 200 && r.data.title === '新章 终（改名）' && r.data.cleanVer >= 3);
  const editBody = '这是就地编辑后的第2章正文内容。';
  r = await api(`/api/books/${idReplace}/chapters/2`, { method: 'PATCH', body: { content: editBody } });
  check('v1.1 PATCH 改正文', r.status === 200 && r.data.wordCount > 0);
  r = await api(`/api/books/${idReplace}/chapters/2`);
  check('v1.1 新正文可取', r.status === 200 && r.text === editBody);
  // 中间插入 + 末尾追加 + 删除
  r = await api(`/api/books/${idReplace}/chapters/insert`, { method: 'POST', body: { after: '3', title: '插入章', content: '插进来的正文。' } });
  check('v1.1 中部插入（独立 key）', r.status === 200 && r.data.chapterCount === 6 && /^n_/.test(r.data.key || ''));
  const insKey = r.data.key;
  r = await api(`/api/books/${idReplace}/chapters/${insKey}`);
  check('v1.1 插入章正文可取', r.status === 200 && r.text.includes('插进来的正文'));
  r = await api(`/api/books/${idReplace}/chapters/insert`, { method: 'POST', body: { title: '尾章', content: 'end' } });
  check('v1.1 末尾追加', r.status === 200 && r.data.chapterCount === 7);
  r = await api(`/api/books/${idReplace}/chapters/${insKey}`, { method: 'DELETE' });
  check('v1.1 删除插入章', r.status === 200 && r.data.chapterCount === 6);
  r = await api(`/api/books/${idReplace}`);
  check('v1.1 章表顺序正确且书可读', r.status === 200 && r.data.chapters.length === 6 && r.data.chapters[2].title === '新章 终（改名）');
  r = await api('/api/books');
  const bEdit = (r.data.books || []).find((x) => x.id === idReplace);
  check('v1.1 书架字数/章数镜像同步', bEdit && bEdit.chapterCount === 6 && bEdit.wordCount > 0);

  // 软删 + 回收站
  await api(`/api/books/${idTrash}`, { method: 'DELETE' });
  r = await api('/api/books');
  check('M2 软删后书架无此书', !r.data.books.some((x) => x.id === idTrash));
  r = await api('/api/trash');
  const trashed = (r.data.books || []).find((x) => x.id === idTrash);
  check('M2 回收站列出软删书', trashed && trashed.restorable === true);

  // 恢复
  await api(`/api/books/${idTrash}/restore`, { method: 'POST' });
  r = await api('/api/books');
  check('M2 恢复回书架', r.data.books.some((x) => x.id === idTrash));

  // 重新软删 → 彻底删除
  await api(`/api/books/${idTrash}`, { method: 'DELETE' });
  let pr = await api(`/api/trash/${idTrash}`, { method: 'DELETE' });
  while (pr && pr.data && pr.data.remaining > 0) {
    pr = await api(`/api/trash/${idTrash}`, { method: 'DELETE' });
  }
  check('M2 彻底删除至 remaining=0', pr.data.done === true && pr.data.remaining === 0);

  // 55 章大书 publish 不挂（子请求预算回归）
  const bigId = await mkBook('M2 测试书 大', 55);
  check('M2 55 章书已发布', !!bigId);
  r = await api(`/api/books/${bigId}`);
  check('M2 55 章大书目录完整', r.data.chapters.length === 55);

  /* ============== OPDS / 整本导出（第三方阅读器通道） ============== */
  console.log('\n[ OPDS ]');
  const basicAuth = 'Basic ' + Buffer.from('reader:' + PASS).toString('base64');
  const opdsFetch = (p, opts = {}) =>
    fetch(BASE + p, { headers: { authorization: basicAuth, ...(opts.headers || {}) } }).then(async (res) => ({
      status: res.status,
      text: await res.text(),
      headers: res.headers,
    }));

  r = await fetch(BASE + '/opds');
  check('OPDS 无凭据 401', r.status === 401 && (r.headers.get('www-authenticate') || '').startsWith('Basic'));

  r = await opdsFetch('/opds');
  check('OPDS Basic 拉取 feed', r.status === 200 && r.text.includes('M2 测试书 A（已改名）'));
  check('OPDS feed 带 acquisition 链接', r.text.includes('/export/') && r.text.includes('application/atom+xml'));

  r = await opdsFetch(`/export/${idDup}.txt`);
  check('OPDS 整本导出(3章)', r.status === 200 && r.text.startsWith('M2 测试书 A（已改名）') && r.text.includes('第1章正文M2 测试书 A'));
  const iEx1 = r.text.indexOf('第1章正文');
  const iEx2 = r.text.indexOf('第2章正文');
  const iEx3 = r.text.indexOf('第3章正文');
  check('OPDS 导出章节顺序', iEx1 >= 0 && iEx1 < iEx2 && iEx2 < iEx3);

  r = await api(`/export/${idDup}.txt`);
  check('OPDS 导出 Cookie 通道', r.status === 200 && r.text.includes('第2章正文'));

  r = await fetch(BASE + `/export/${idDup}.txt`, { headers: { authorization: 'Basic ' + Buffer.from('reader:wrong').toString('base64') } });
  check('OPDS 错口令 401', r.status === 401);

  /* ============== 收尾清理（SMOKE_CLEANUP=1，CI 生产冒烟不留测试书） ============== */
  if (CLEANUP && created.length) {
    console.log('\n[ 收尾清理 ]');
    for (const bid of created) {
      await purgeBook(bid);
      console.log('  · 已彻底删除测试书 ' + bid);
    }
    // 兜底：历次冒烟遗留（含被改过名的）测试书一并清走
    const lr = await api('/api/books');
    for (const b of (lr.data.books || []).filter((x) => /^(M2 测试书|冒烟测试书)/.test(x.title || ''))) {
      await purgeBook(b.id);
      console.log('  · 已清理遗留测试书 ' + b.id + '《' + b.title + '》');
    }
    const lr2 = await api('/api/books');
    check('清理后书架无测试书', !(lr2.data.books || []).some((x) => /测试书/.test(x.title || '')));
  }

  if (failures.length) {
    console.error('\nM2 链路失败 ' + failures.length + ' 项：' + failures.join('、'));
    process.exit(1);
  }
  console.log('\nM2 链路全部通过 ✓');
}

main().catch((e) => {
  console.error('冒烟异常：', e);
  process.exit(1);
});
