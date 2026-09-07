/**
 * r2novel — Cloudflare Worker 入口（薄壳）
 *
 * 职责：把 R2 适配成 store 接口 + 静态资源透传，业务全在 src/router.js（可与本地
 * dev-server 共用同一套逻辑，保证本地验证与线上行为一致）。
 */
import { handleRequest } from './router.js';

export function r2Store(bucket) {
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
    /** 遍历对象清单（含前缀过滤）。返回 { objects:[{key,size}], truncated, pages, cursor }；
     *  分页每页 ≤1000，受 maxPages 约束：超出即截断并置 truncated（大库防单请求子请求/耗时爆表）。
     *  cursor 必须逐页回传——漏传会让每一页都重读第 1 页（对象重复、1000 之后永不出现、
     *  maxPages=0 时无限循环烧穿 CPU）。返回的 cursor 为下一窗续扫游标（null=已扫完），
     *  可作为 startCursor 回传续扫（diag 大库分窗扫描依赖此语义）。 */
    async list(prefix = '', maxPages = 0, startCursor = '') {
      const out = [];
      let cursor = startCursor || undefined;
      let pages = 0;
      let truncated = false;
      do {
        if (maxPages > 0 && pages >= maxPages) {
          truncated = true;
          break;
        }
        const page = await bucket.list({ ...(prefix ? { prefix } : {}), ...(cursor ? { cursor } : {}) });
        for (const o of page.objects) out.push({ key: o.key, size: o.size });
        pages++;
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return { objects: out, truncated, pages, cursor: cursor || null };
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
