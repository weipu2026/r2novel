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
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Readable.toWeb(req);
  return new Request(url.href, { method: req.method, headers, body, duplex: 'half' });
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
