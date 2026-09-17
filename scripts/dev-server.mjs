/**
 * r2novel — 本地开发/联调服务器（零依赖 Node）
 *
 * 与生产 Worker 共用同一套路由核心（src/router.js），存储换成文件系统
 * （data-dev/ 目录，见 .gitignore），静态资源直接读 public/。
 *
 * 用法：
 *   ADMIN_PASSWORD=口令 SESSION_SECRET=xxx npm run dev   （默认 http://localhost:8088）
 *   或把口令写进 .dev.vars 后运行 scripts/dev-server.mjs（本脚本自动读取 .dev.vars）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { handleRequest } from '../src/router.js';
import { MAX_CHAPTER_BYTES, MAX_UPLOAD_BYTES } from '../public/js/shared-const.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.R2NOVEL_DATA || path.join(ROOT, 'data-dev');
const PORT = Number(process.env.PORT || 8088);

/* ---- 读取 .dev.vars（如有），用真实 ADMIN_PASSWORD/SESSION_SECRET 模拟线上 ---- */
function loadDevVars() {
  try {
    const t = fs.readFileSync(path.join(ROOT, '.dev.vars'), 'utf8');
    for (const line of t.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {
    /* 没有 .dev.vars 也能跑（用环境变量） */
  }
}
loadDevVars();

if (!process.env.ADMIN_PASSWORD) {
  console.error('缺少 ADMIN_PASSWORD：设置环境变量或创建 .dev.vars（见 .dev.vars.example）');
  process.exit(1);
}

/* ---- 文件系统 store：key 即相对路径（router 已做白名单校验，这里再兜底防穿越） ---- */
const keyPath = (key) => {
  const p = path.join(DATA, ...key.split('/'));
  if (p !== DATA && !p.startsWith(DATA + path.sep)) throw new Error('key 越界: ' + key);
  return p;
};
const fsStore = {
  async getText(key) {
    try {
      return fs.readFileSync(keyPath(key), 'utf8');
    } catch {
      return null;
    }
  },
  async getBytes(key) {
    try {
      return new Uint8Array(fs.readFileSync(keyPath(key)));
    } catch {
      return null;
    }
  },
  async putText(key, str) {
    const p = keyPath(key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, str, 'utf8');
    fs.renameSync(tmp, p);
  },
  /** 读原文 + 版本号：etag 取内容 sha1 —— 与生产 R2（普通 put 的 etag = 内容 MD5）**同语义**：
   *  内容不变则 etag 不变。不能改成「自增版本号」：测试/脚本会直接改文件造数，那会让 etag 失真。 */
  async getTextWithEtag(key) {
    let buf;
    try {
      buf = fs.readFileSync(keyPath(key));
    } catch {
      return null;
    }
    return { text: buf.toString('utf8'), etag: createHash('sha1').update(buf).digest('hex') };
  },
  /** 条件写。三种语义（与 router.js 的 store 契约一致）：
   *   · etag 是字符串 → CAS：当前内容 etag 不等则不写、返回 null；
   *   · etag 为 null  → 「不存在才写」：文件已存在则返回 null；
   *   · etag 为 undefined → 无条件写。
   *  检查与写入之间**不得有 await**（dev-server 单进程、Node 单线程 → 这段同步代码不可被打断，
   *  等价于原子）；写入沿用 tmp+rename（崩溃不留半截文件）。 */
  async putTextIf(key, str, etag) {
    const p = keyPath(key);
    let cur = null;
    try {
      cur = createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    } catch {
      cur = null;
    }
    if (etag === null && cur !== null) return null; // 不存在才写，但盘上已经有了
    if (typeof etag === 'string' && cur !== etag) return null; // CAS 版本不匹配
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, str, 'utf8');
    fs.renameSync(tmp, p);
    return { etag: createHash('sha1').update(Buffer.from(str, 'utf8')).digest('hex') };
  },
  async putBytes(key, bytes) {
    const p = keyPath(key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    fs.renameSync(tmp, p);
  },
  async openRead(key) {
    const p = keyPath(key);
    try {
      if (!fs.statSync(p).isFile()) return null;
    } catch {
      return null;
    }
    return Readable.toWeb(fs.createReadStream(p)); // Web ReadableStream，与生产 R2 body 同形
  },
  async delete(key) {
    try {
      fs.rmSync(keyPath(key), { force: true });
    } catch {
      /* ignore */
    }
  },
  /** 遍历对象清单（与生产 R2 list 同形）；walk 全树后按前缀过滤。
   *  返回 { objects, truncated, pages }：fs 无分页，恒 pages=1、truncated=false。 */
  async list(prefix = '') {
    const out = [];
    const walk = (dir, rel) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const relKey = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), relKey);
        else if (relKey.startsWith(prefix) && !relKey.endsWith('.tmp')) {
          // 跳过写入中断残留的 .tmp（putText 先写 tmp 再 rename，崩溃会留下）
          const st = fs.statSync(path.join(dir, e.name));
          out.push({ key: relKey, size: st.size });
        }
      }
    };
    walk(DATA, '');
    return { objects: out, truncated: false, pages: 1, cursor: null };
  },
};

/* ---- 静态服务 ---- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, url) {
  let p;
  try {
    p = decodeURIComponent(url.pathname);
  } catch {
    return null; // 非法 % 序列
  }
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(PUBLIC, p);
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) return new Response('Forbidden', { status: 403 });
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    const ext = path.extname(file).toLowerCase();
    return new Response(fs.createReadStream(file), {
      status: 200,
      headers: { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' },
    });
  } catch {
    return null;
  }
}

/* ---- 启动 ---- */
if (!process.env.SESSION_SECRET) {
  console.warn('· 未设置 SESSION_SECRET：本地开发暂用 ADMIN_PASSWORD 作 Cookie 签名密钥（生产必须单独设，见 .dev.vars.example）');
}
fs.mkdirSync(DATA, { recursive: true });
const env = {
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  SESSION_SECRET: process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD,
  SESSION_DAYS: '30',
  MAX_UPLOAD: String(MAX_UPLOAD_BYTES),
  MAX_CHAPTER: String(MAX_CHAPTER_BYTES),
  serveStatic,
};

const server = http.createServer((req, res) => {
  handleRequest(toWeb(req), env, fsStore)
    .then((r) => fromWeb(res, r))
    .catch((e) => {
      console.error('handler error:', e);
      res.writeHead(500).end('Internal Server Error');
    });
});

/* Node req/res <-> Web Request/Response 的最小适配 */
import { Readable } from 'node:stream';
function toWeb(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) for (const item of v) headers.append(k, item);
  }
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : reqBodyStream(req);
  return new Request(url.href, { method: req.method, headers, body, duplex: 'half' });
}
/**
 * Node IncomingMessage → Web ReadableStream（自管，不用 Readable.toWeb）。
 *
 * 为什么不用 Readable.toWeb(req)：它的 onData 是裸 enqueue，没有「已关闭」判断。
 * 消费者一旦提前取消（典型：未鉴权/参数非法的 POST 早退时 handler 调 dropBody() →
 * req.body.cancel()），controller 被关闭，而此后到达的分片仍会 enqueue 到已关闭的
 * controller，抛出未捕获的 ERR_INVALID_STATE("Controller is already closed")，
 * 直接把 dev-server 进程打死 —— 现场表现为「测试莫名 Failed to fetch」，
 * 把真正的 401/400 伪装成服务崩溃。
 * 这里自己接管：关闭后不再 enqueue，改为 resume() 排空丢弃，进程不受影响。
 */
function reqBodyStream(req) {
  let closed = false;
  return new ReadableStream({
    start(c) {
      req.on('data', (chunk) => {
        if (closed) return;
        try { c.enqueue(chunk); } catch { closed = true; req.resume(); return; }
        // 背压：队列满则暂停读取，消费者 pull 时再恢复（否则大文件会全量堆在内存里）
        if (c.desiredSize !== null && c.desiredSize <= 0) req.pause();
      });
      req.on('end', () => { if (closed) return; closed = true; try { c.close(); } catch {} });
      req.on('error', (e) => { if (closed) return; closed = true; try { c.error(e); } catch {} });
    },
    pull() { if (!closed) req.resume(); },
    cancel() { closed = true; req.resume(); },
  });
}

function fromWeb(res, r) {
  res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
  if (r.body) {
    Readable.fromWeb(r.body).pipe(res);
  } else {
    res.end();
  }
}

server.listen(PORT, () => {
  console.log(`r2novel dev server: http://localhost:${PORT}   数据目录: ${DATA}`);
  console.log(`  浏览器打开上方地址，口令即 ADMIN_PASSWORD`);
});
