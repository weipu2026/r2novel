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
    /** 读原文 + 版本号（乐观锁用）。R2 的 etag 对普通 put 是内容 MD5，故 etag 变化 ⟺ 内容变化。
     *  一次 get 同时拿到 body 与 etag，不多花子请求（getText 自己会丢掉 etag）。
     *  注意 R2 语义：onlyIf 未通过时 get 返回的 R2Object 的 body 是 undefined —— 这里当不存在处理。 */
    async getTextWithEtag(key) {
      const o = await bucket.get(key);
      if (!o || !o.body) return null;
      return { text: await o.text(), etag: o.etag };
    },
    async getBytes(key) {
      const o = await bucket.get(key);
      return o ? new Uint8Array(await o.arrayBuffer()) : null;
    },
    async putText(key, str) {
      await bucket.put(key, str);
    },
    /** 条件写。三种语义（与 router.js 的 store 契约一致）：
     *   · etag 是字符串 → CAS：仅当对象当前 etag 与之相等才写（onlyIf.etagMatches）；
     *   · etag 为 null  → 「不存在才写」：onlyIf 传 Headers 的 If-None-Match:*（R2 官方支持条件头，
     *                     S3 兼容的 If-None-Match:* 即「对象不存在才落盘」）；
     *   · etag 为 undefined → 无条件写。
     *  条件未满足时 R2 返回 null（官方语义，不抛错）→ 这里也返回 null，调用方据此重读重放。
     *  成功回传新 etag：调用方下次 CAS 要用它。R2 普通 put 的 etag 是内容 MD5 → 内容不变则 etag 不变。 */
    async putTextIf(key, str, etag) {
      const opts =
        etag === null
          ? { onlyIf: new Headers({ 'If-None-Match': '*' }) } // 不存在才写
          : typeof etag === 'string'
            ? { onlyIf: { etagMatches: etag } } // CAS
            : undefined; // 无条件写
      const res = await bucket.put(key, str, opts);
      return res ? { etag: res.etag } : null;
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
