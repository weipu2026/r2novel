/* verify-deploy.mjs — 部署后版本核验：把「手动 cache-buster + 哈希比对」固化成 CI 步骤。
 *
 * 用法：node scripts/verify-deploy.mjs <base-url>   （如 https://novel.example.com）
 *
 * 做什么：遍历 public/ 下全部可服务静态资源（排除 _headers —— CF 配置非页面资源；
 * 排除 sw.js —— CI 部署时会用时间戳改写线上 CACHE 版本号，仓库副本对不上属预期），
 * 逐个从生产拉取（带 cache-buster 防边缘缓存），与仓库内容比对：
 *   文本文件（js/css/html/webmanifest）→ 行尾归一化（CRLF→LF）后比 sha256
 *   二进制文件（png 等）→ 原始字节比 sha256
 * 任一不一致 / 非 200 → exit 1（CI run 红）。
 *
 * 为什么要它：部署「成功」只说明 wrangler 退出码为 0，不能证明生产真在服务新代码
 * （边缘缓存、路由未生效、上传了旧产物都无报错）。冒烟测的是 API 行为，这个脚本
 * 测的是「用户拿到的静态文件到底是不是这次 push 的这份」。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('用法: node scripts/verify-deploy.mjs <base-url>');
  process.exit(2);
}

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else {
      const rel = '/' + path.relative(PUBLIC, p).split(path.sep).join('/');
      if (rel === '/_headers' || rel === '/sw.js') continue; // 与 check.mjs ③ 同口径排除
      files.push({ rel, abs: p });
    }
  }
})(PUBLIC);

const bust = Date.now();
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
const norm = (buf, rel) =>
  /\.(js|css|html?|webmanifest|json|txt|svg)$/.test(rel)
    ? Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'))
    : buf;

let bad = 0;
for (const { rel, abs } of files) {
  const local = norm(fs.readFileSync(abs), rel);
  let ok = false, detail = '';
  // 3 次重试：刚部署完边缘节点可能瞬时抖动
  for (let i = 1; i <= 3 && !ok; i++) {
    try {
      const res = await fetch(`${base}${rel}?v=${bust}`, { redirect: 'follow' });
      if (res.status !== 200) { detail = `HTTP ${res.status}`; continue; }
      const remote = norm(Buffer.from(await res.arrayBuffer()), rel);
      if (sha(remote) === sha(local)) { ok = true; break; }
      detail = `哈希不一致 本地=${sha(local)} 线上=${sha(remote)}`;
    } catch (e) { detail = `请求失败 ${e.message}`; }
    if (i < 3) await new Promise((r) => setTimeout(r, 5000));
  }
  console.log(`${ok ? '✓' : '✗'} ${rel}${ok ? '' : '  · ' + detail}`);
  if (!ok) bad++;
}

if (bad) {
  console.error(`\nVERIFY_FAIL · ${bad}/${files.length} 个静态文件与本次 push 内容不一致`);
  process.exit(1);
}
console.log(`\nVERIFY_OK · ${files.length} 个静态文件与本次 push 逐字节一致（行尾归一化）`);
