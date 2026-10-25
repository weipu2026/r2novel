/* review-fix150e.test.mjs — #150 批次5：SW install 分级 / staticReach / 部署链 / 弱 ETag / 可访问性标记
 *
 * 这一批的共同点：**全是"出错时没人喊"的位置**。
 *   · SW install 旧实现用 allSettled 吞掉全部失败 —— 17 项全挂也照样 skipWaiting，
 *     而 activate 会无条件删旧缓存 → 弱网下"新缓存残缺 + 旧缓存已删" = 断网白屏。
 *   · 门禁 staticReach 漏了 `export { x } from` → 首屏依赖被标成 LAZY 时不报错。
 *   · deploy.yml 解析不出访问地址就 exit 0 → 整段版本核验静默蒸发、CI 全绿。
 *   · dev-server 只认强校验 ETag 精确相等 → 本地恒 200 全量，与线上不同构。
 * 所以断言都落在**行为**上：SW 用 vm 真跑 install，ETag 真起服务发请求。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const codeOnly = (src) =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

/* ============ 1. SW install：失败要按「哪一项」分级 ============ */

/** 在 vm 里跑 public/sw.js 的 install handler。
 *  failUrls：这些 URL 的 cache.add 会抛错（模拟弱网/代理下单个资源失败）。 */
function runInstall(failUrls) {
  const src = read('public/sw.js');
  const handlers = {};
  const added = [];
  let skipWaiting = 0;
  class FakeRequest {
    constructor(u, opts) {
      this.url = u;
      this.opts = opts;
    }
  }
  class FakeResponse {
    constructor(body, init) {
      this.body = body;
      Object.assign(this, init || {});
    }
  }
  vm.runInNewContext(
    src,
    {
      self: {
        addEventListener: (t, f) => {
          handlers[t] = f;
        },
        skipWaiting: () => {
          skipWaiting++;
          return Promise.resolve();
        },
        location: { origin: 'https://r2novel.test' },
        clients: { claim: () => Promise.resolve() },
      },
      caches: {
        open: async () => ({
          add: async (req) => {
            if (failUrls.has(req.url)) throw new TypeError('Failed to fetch ' + req.url);
            added.push({ url: req.url, opts: req.opts });
          },
        }),
        keys: async () => [],
        delete: async () => true,
        match: async () => undefined,
      },
      Request: FakeRequest,
      Response: FakeResponse,
      URL,
      fetch: () => Promise.reject(new Error('install 阶段不该发网络请求')),
    },
    { filename: 'public/sw.js' }
  );
  let p;
  handlers.install({
    waitUntil: (x) => {
      p = x;
    },
  });
  return { p, skipWaiting: () => skipWaiting, added: () => added };
}

test('SW install：关键资源失败 → install 拒绝，且绝不 skipWaiting', async () => {
  const r = runInstall(new Set(['/js/app.js']));
  await assert.rejects(
    r.p,
    /SW install 关键资源失败.*\/js\/app\.js/,
    '关键项（首屏 JS/CSS/HTML/manifest）缺失必须让 install 失败'
  );
  assert.equal(
    r.skipWaiting(),
    0,
    '关键项缺失还接管 → activate 无条件删旧缓存，新缓存又残缺 = 断网打开白屏'
  );
});

test('SW install：全部资源失败也必须拒绝（旧实现的致命场景）', async () => {
  const src = read('public/sw.js');
  const shell = [...(/const\s+SHELL\s*=\s*\[([\s\S]*?)\]/.exec(src)[1].matchAll(/'([^']+)'/g))].map((m) => m[1]);
  assert.ok(shell.length >= 10, 'SHELL 解析空 → 下面的断言等于空转');
  const r = runInstall(new Set(shell));
  await assert.rejects(r.p, /SW install 关键资源失败/);
  assert.equal(r.skipWaiting(), 0, '全挂还接管是最坏路径：旧缓存被删、新缓存为空');
});

test('SW install：只有图标失败 → 照常接管（不为一个图标卡住整次更新）', async () => {
  const r = runInstall(new Set(['/icons/icon-192.png']));
  await assert.doesNotReject(r.p);
  assert.equal(r.skipWaiting(), 1, '图标属非关键项，缺了也要能更新');
  assert.ok(
    !r.added().some((a) => a.url === '/icons/icon-192.png'),
    '失败的图标不应出现在已缓存清单里（防止断言恒真）'
  );
});

test('SW install：全部成功 → 接管一次，且非图标走 cache:no-cache', async () => {
  const r = runInstall(new Set());
  await assert.doesNotReject(r.p);
  assert.equal(r.skipWaiting(), 1);
  const added = r.added();
  assert.ok(added.length >= 10, '缓存项数异常：' + added.length);
  const js = added.find((a) => a.url === '/js/app.js');
  // ⚠️ 不能 deepEqual：opts 是 vm 里构造的对象，原型与宿主 realm 不同，deepStrictEqual 会
  // 因为 prototype 不同而判不相等（expected/actual 打印出来一模一样，极难排查）。
  assert.equal(js && js.opts && js.opts.cache, 'no-cache', 'JS/CSS/HTML 必须强制回源校验（部署后拿新）');
  const png = added.find((a) => a.url === '/icons/icon-192.png');
  assert.equal(png && png.opts, undefined, '图标走默认缓存（命中即用，不重复下载）');
});

test('SW install：icon-180 已在 SHELL（iOS 主屏图标要能离线拿到）', () => {
  const src = read('public/sw.js');
  const shell = /const\s+SHELL\s*=\s*\[([\s\S]*?)\]/.exec(src)[1];
  assert.match(shell, /'\/icons\/icon-180\.png'/, 'index.html 已指向 180px，SHELL 缺它则离线图标 404');
  assert.ok(fs.existsSync(path.join(ROOT, 'public/icons/icon-180.png')), 'icon-180.png 文件必须真实存在');
});

/* ============ 2. 门禁 staticReach：export { x } from ============ */

function reachRegex() {
  const c = codeOnly(read('scripts/check.mjs'));
  const m = /const re = (\/\(\?:\^\|\\n\)[\s\S]*?\/g);/.exec(c);
  assert.ok(m, 'check.mjs 里找不到 staticReach 的 re 定义');
  return new Function('return ' + m[1])();
}

const specs = (re, code) => [...code.matchAll(re)].map((x) => x[1]);

test('门禁 staticReach：export { x } from 必须算作静态可达', () => {
  const re = reachRegex();
  assert.deepEqual(specs(re, `import { a } from './a.js';`), ['./a.js']);
  assert.deepEqual(specs(re, `import './b.js';`), ['./b.js']);
  assert.deepEqual(specs(re, `export * from './c.js';`), ['./c.js']);
  assert.deepEqual(
    specs(re, `export { normTitle } from './shared-text.js';`),
    ['./shared-text.js'],
    '漏了这一支：dom.js 的 normTitle 就是这样转出的，首屏依赖被标成 LAZY 也不会报错'
  );
  assert.deepEqual(specs(re, `export {a, b as c} from './d.js';`), ['./d.js']);
  assert.deepEqual(specs(re, `  export { x } from './e.js';`), ['./e.js'], '缩进写法同样要认');
  // 动态 import 绝不能进图：进了就等于把 LAZY 全判成首屏依赖
  assert.deepEqual(specs(re, `const m = await import('./dyn.js');`), []);
});

test('门禁 staticReach：真实仓库里 dom.js 的 re-export 能被抓到', () => {
  const re = reachRegex();
  const dom = codeOnly(read('public/js/dom.js'));
  assert.ok(
    specs(re, dom).includes('./shared-text.js'),
    'dom.js 存在 `export { … } from "./shared-text.js"`，正则必须捕获它'
  );
});

test('门禁：静态可达必须预缓存（反向门禁存在）', () => {
  const c = codeOnly(read('scripts/check.mjs'));
  // 方向一：LAZY 里不得出现静态可达项
  assert.match(c, /for \(const s of lazySet\) \{\s*\n\s*if \(reach\.has\(s\)\)/, '缺方向一');
  // 方向二：静态可达项必须在 SHELL 里（新增）
  assert.match(
    c,
    /for \(const s of reach\) \{\s*\n\s*if \(!shellSet\.has\(s\)\) say\('SW SHELL'/,
    '缺方向二：把首屏依赖错标成 LAZY 时方向一不响，首访断网少一块而门禁全绿'
  );
});

/* ============ 3. 部署链：解析不出地址必须 fail loud ============ */

test('deploy.yml：解析不出访问地址不得 exit 0 静默跳过版本核验', () => {
  const y = read('.github/workflows/deploy.yml');
  // ⚠️ 必须按步骤名切片。用 `if [ -n "$CUSTOM_DOMAIN" ]` 当锚点会命中**上游「生产冒烟」**
  // 的同名片段（那段本来就没有 exit 0 之外的问题）；更坑的是注释里正写着「旧实现 exit 0」，
  // 全文匹配 `exit 0` 会把自己判红 —— 先剥注释行，再按整行语句判。
  const start = y.indexOf('- name: 部署后版本核验');
  assert.ok(start > 0, '找不到「部署后版本核验」这一步');
  const next = y.indexOf('\n      - name:', start + 10);
  const block = y.slice(start, next > 0 ? next : undefined);
  const code = block
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  assert.match(code, /VERIFY_BASE=\$\(grep -oE/, '锚点跑偏：这段不是版本核验步骤');
  assert.match(code, /if \[ -z "\$VERIFY_BASE" \]; then/, '空值分支不见了？');
  assert.match(code, /::error::/, '必须用 ::error:: 让 CI 红在明处');
  assert.match(code, /^\s+exit 1$/m, '解析失败必须让这一步失败');
  assert.ok(
    !/^\s*exit 0\s*$/m.test(code),
    'exit 0 会让整段版本核验静默蒸发：wrangler 退出码 0 但线上产物不对时无人知晓'
  );
});

/* ============ 4. dev-server：If-None-Match 的三种合法形态 ============ */

const freePort = () =>
  new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('dev-server：If-None-Match 认弱校验 W/"…" 与 *，错误值仍 200', { timeout: 40000 }, async () => {
  const port = await freePort();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'r2n-150e-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/dev-server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      R2NOVEL_DATA: data,
      ADMIN_PASSWORD: 'test-pass',
      SESSION_SECRET: 'test-secret-0123456789abcdef',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => {
    err += d;
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      try {
        const r = await fetch(base + '/manifest.webmanifest');
        ready = r.status === 200;
        if (!ready) err += '\n就绪探测返回 ' + r.status;
      } catch {
        await sleep(100);
      }
    }
    assert.ok(ready, 'dev-server 未就绪：' + err.slice(0, 400));

    const url = base + '/manifest.webmanifest';
    const r1 = await fetch(url);
    const etag = r1.headers.get('etag');
    assert.equal(r1.status, 200);
    assert.ok(etag && etag.startsWith('"'), 'ETag 应为强校验形态，实际 ' + etag);

    const cases = [
      ['精确值', etag],
      ['弱校验', 'W/' + etag],
      ['任意当前表示', '*'],
      ['逗号列表中的弱校验', '"deadbeef", W/' + etag],
    ];
    for (const [name, inm] of cases) {
      const r = await fetch(url, { headers: { 'if-none-match': inm } });
      assert.equal(r.status, 304, name + ' 未命中 304（本地退化成每次 200 全量，与线上不同构）');
    }
    const bad = await fetch(url, { headers: { 'if-none-match': '"deadbeef"' } });
    assert.equal(bad.status, 200, '不匹配的 ETag 必须回 200 全量（否则会把陈旧内容当真）');
  } finally {
    child.kill();
    await sleep(200);
    try {
      fs.rmSync(data, { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉不影响结论 */
    }
  }
});

/* ============ 5. iOS 主屏与可访问性标记 ============ */

test('index.html：iOS 添加到主屏的 meta 齐全，图标指向 180px', () => {
  const h = read('public/index.html');
  assert.match(h, /<meta name="mobile-web-app-capable" content="yes">/);
  assert.match(h, /<meta name="apple-mobile-web-app-capable" content="yes">/,
    '缺它则加主屏仍是 Safari 套壳（多一条地址栏）');
  assert.match(h, /<meta name="apple-mobile-web-app-status-bar-style" content="default">/);
  assert.match(h, /<meta name="apple-mobile-web-app-title" content="[^"]+">/);
  assert.match(h, /<link rel="apple-touch-icon" sizes="180x180" href="\/icons\/icon-180\.png">/,
    'iOS 取 180×180；指向 192 会被缩放');
});

test('index.html：弹层是 dialog、阅读进度是 progressbar（不是 slider）', () => {
  const h = read('public/index.html');
  const box = /<div id="modalBox"[^>]*>/.exec(h);
  assert.ok(box, '找不到 #modalBox');
  assert.match(box[0], /role="dialog"/, '遮罩层弹窗没有 dialog 角色，读屏不认它是模态');
  assert.match(box[0], /aria-modal="true"/);
  const prog = /<div id="readProg"[^>]*>/.exec(h);
  assert.ok(prog, '找不到 #readProg');
  assert.match(prog[0], /role="progressbar"/);
  assert.ok(
    !/role="slider"/.test(prog[0]),
    'slider 会被读屏念成「用左右方向键调整」，但这个进度条不可聚焦、也没有键盘操作'
  );
  assert.match(prog[0], /aria-valuetext|title=/, '纯数字不足以为读者提供上下文');
});

test('reader.js：进度条要给出章号文案而不只是百分比', () => {
  const c = codeOnly(read('public/js/reader.js'));
  assert.match(
    c,
    /els\.prog\.setAttribute\('aria-valuetext', '第 ' \+ \(i \+ 1\) \+ ' \/ ' \+ n \+ ' 章'\)/,
    'progressbar 上只有数字时读屏只念百分比；章号才是读者关心的信息'
  );
});

/* ============ 6. 弹层焦点契约（行为由 .ui-tests/ui-150e.mjs 验） ============ */

test('app.js：openModal 记下触发者并把焦点搬进弹层、closeModal 还回去', () => {
  const c = codeOnly(read('public/js/app.js'));
  assert.match(c, /let modalReturnFocus = null;/, '缺焦点宿主变量');
  assert.match(
    c,
    /if \(!els\.modalMask\.contains\(document\.activeElement\)\) modalReturnFocus = document\.activeElement;/,
    '必须记下打开前的 activeElement（且不能把弹层内部的焦点当成宿主）'
  );
  const om = c.slice(c.indexOf('function openModal(html)'), c.indexOf('function closeModal()'));
  assert.match(om, /aria-labelledby/, 'role=dialog 没有名字时读屏只会念「对话框」');
  assert.match(om, /first\.focus\(\)/, '不搬焦点，Tab 会继续在遮罩背后的页面里走');
  const cm = c.slice(c.indexOf('function closeModal()'), c.indexOf('function closeModal()') + 900);
  assert.match(cm, /back\.isConnected/, '书架重渲后原节点已脱离文档，直接 focus 会静默失败/抛错');
  assert.match(cm, /back\.focus\(\)/, '关掉弹层要把焦点还回触发它的控件');
  // ⚠️ 「Tab 圈禁」故意**不在单测里断言**：源码静态匹配（查 e.key !== 'Tab' 是否出现）对
  // `|| true` 这类短路毫无判别力 —— 实测变异后依然全绿。它的判据只能是真机行为：
  // 「连按 N 次 Tab 之后 activeElement 仍在 #modalBox 内」，见 .ui-tests/ui-150e.mjs 的 P3-19c。
});
