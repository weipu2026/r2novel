/**
 * r2novel — 会话鉴权（HMAC 无状态 Cookie）
 *
 * 由 src/router.js 拆分而来（#149 P2）。这里只放这一件事的实现；
 * 路由/参数校验留在 src/router.js，跨模块约定见各函数注释。
 */

import { safeEqual, b64urlDecode } from './base.js';
import { SESSION_COOKIE } from './const.js';

/* ---------------- 会话鉴权（HMAC 无状态 Cookie，参照 r2book） ---------------- */

const hmacKeyCache = new Map();
async function getHmacKey(secret) {
  let k = hmacKeyCache.get(secret);
  if (!k) {
    k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    hmacKeyCache.set(secret, k);
  }
  return k;
}

async function hmac(secret, msg) {
  const key = await getHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  const bytes = new Uint8Array(sig);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function verifyCookie(req, env) {
  const cookie = req.headers.get('Cookie') || '';
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookie);
  if (!m) return false;
  const token = m[1];
  const i = token.lastIndexOf('.');
  if (i <= 0) return false;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  const secret = env.SESSION_SECRET || env.ADMIN_PASSWORD;
  if (!secret) return false;
  if (!safeEqual(sig, await hmac(secret, payload))) return false;
  try {
    const data = JSON.parse(b64urlDecode(payload));
    return typeof data.exp === 'number' && data.exp > Date.now();
  } catch {
    return false;
  }
}

function cookieAttrs(req, maxAge) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}


/* 供其他模块 / router.js 使用（集中导出，避免改动声明行） */
export { hmac, verifyCookie, cookieAttrs };
