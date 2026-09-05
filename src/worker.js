/**
 * r2novel — Cloudflare Worker 入口（薄壳）
 *
 * 职责：把 R2 适配成 store 接口 + 静态资源透传，业务全在 src/router.js（可与本地
 * dev-server 共用同一套逻辑，保证本地验证与线上行为一致）。
 */
import { handleRequest } from './router.js';

function r2Store(bucket) {
  return {
    async getText(key) {
      const o = await bucket.get(key);
      return o ? o.text() : null;
    },
    async getBytes(key) {
      const o = await bucket.get(key);
      return o ? new Uint8Array(await o.arrayBuffer()) : null;
    },
    async putText(key, str) {
      await bucket.put(key, str);
    },
    async putBytes(key, bytes) {
      await bucket.put(key, bytes);
    },
    async openRead(key) {
      const o = await bucket.get(key);
      return o ? o.body : null;
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}

export default {
  async fetch(req, env) {
    const store = r2Store(env.NOVELS);
    const serveStatic = async () => env.ASSETS.fetch(req);
    return handleRequest(req, { ...env, serveStatic }, store);
  },
};
