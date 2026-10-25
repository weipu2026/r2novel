/**
 * r2novel — 登录 / 登出
 *
 * 由 src/router.js 拆分而来（#149 P2）。这里只放这一件事的实现；
 * 路由/参数校验留在 src/router.js，跨模块约定见各函数注释。
 */

import { hmac, cookieAttrs } from '../core/auth.js';
import { json, readBodyText, safeEqual, b64urlEncode } from '../core/base.js';
import { bruteCheck, bruteFail, bruteClear } from '../core/brute.js';
import { SESSION_COOKIE } from '../core/const.js';

/* ---------------- 鉴权 API ---------------- */

async function apiLogin(req, env, store) {
  const st = await bruteCheck(req, env, store);
  if (st.locked) {
    // 锁定期内一律 429（即使口令正确），不给绕过限速试探的机会
    const min = Math.max(1, Math.ceil(st.retryAfterMs / 60000));
    return json({ error: `尝试次数过多，请约 ${min} 分钟后再试` }, 429, {
      'Retry-After': String(Math.ceil(st.retryAfterMs / 1000)),
    });
  }
  // 公开端点加固：合法登录体不足 100 字节。走有界流式读取——即使客户端用 chunked
  // 不声明 Content-Length，超大请求也会在 64KB 处被中断，不会读满内存。
  // （本端点是唯一免鉴权入口，OOM 防护优先级最高；旧实现只看 content-length，可被绕过。）
  let body;
  try {
    body = JSON.parse(await readBodyText(req, 65536));
  } catch (e) {
    if (e && (e.message === '请求体超过上限' || e.message === '解压后超过上限')) return json({ error: '请求体过大' }, 413);
    body = {}; // 非法 JSON / 读取解压失败 → 统一走「口令错误」，不泄露内部细节
  }
  const pass = String(body.password || '');
  const admin = env.ADMIN_PASSWORD;
  if (!admin || !safeEqual(pass, admin)) {
    if (admin) await bruteFail(req, env, store);
    return json({ error: '口令错误' }, 401);
  }
  await bruteClear(req, store);
  const days = Number(env.SESSION_DAYS) || 30;
  const payload = b64urlEncode(JSON.stringify({ exp: Date.now() + days * 86400000 }));
  const sig = await hmac(env.SESSION_SECRET || admin, payload);
  return json({ ok: true }, 200, {
    'Set-Cookie': `${SESSION_COOKIE}=${payload}.${sig}; ${cookieAttrs(req, days * 86400)}`,
  });
}

const apiLogout = (req) =>
  json({ ok: true }, 200, { 'Set-Cookie': `${SESSION_COOKIE}=; ${cookieAttrs(req, 0)}` });


/* 供其他模块 / router.js 使用（集中导出，避免改动声明行） */
export { apiLogin, apiLogout };
