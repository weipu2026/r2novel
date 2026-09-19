/* review-fix138b.test.mjs — 2026-09-19 审计修复里的两个「浏览器存储兜底」项
 *
 * 单列一个文件的原因：这两条要在 node 里替 localStorage / indexedDB 造桩（见下），
 * 与本目录 review-fix138.test.mjs 的服务端/纯逻辑用例分开，互不干扰。
 *
 * 覆盖：
 *   P2-4②  书架快照超限 → 必须清掉旧快照（原实现只 return false，远古快照留在本地）。
 *   P2-4③  IndexedDB 打开失败 → 不得把 rejected promise 永久缓存（原实现一次失败即废掉
 *          整个会话的离线能力）。
 * 两条都是「改回旧写法必然不通过」的判据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { local } from '../public/js/store.js';
import { offline } from '../public/js/offline.js';

/** 最小 localStorage 桩（Node 默认没有它）。store.js 是运行时才取 localStorage，
 *  所以在这里挂全局即可生效；用完必须还原，避免污染同进程的其它用例。 */
function withLocalStorage(fn) {
  const orig = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const m = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      key: (i) => [...m.keys()][i] ?? null,
      get length() {
        return m.size;
      },
    },
  });
  try {
    return fn(m);
  } finally {
    if (orig) Object.defineProperty(globalThis, 'localStorage', orig);
    else delete globalThis.localStorage;
  }
}

test('P2-4 书架快照超限：必须清掉旧快照（否则网络失败时长期显示过期书架）', () => {
  withLocalStorage(() => {
    assert.equal(local.setShelfCache([{ id: 'a', title: '小快照' }]), true);
    assert.ok(local.getShelfCache(), '前置：正常大小的快照写得进去');

    // 30k 本 × 60 字标题 ≈ 2.4M 字符 > 1,000,000 上限
    const big = Array.from({ length: 30000 }, (_, i) => ({ id: 'b' + i, title: 'x'.repeat(60) }));
    assert.equal(local.setShelfCache(big), false, '超限要如实返回 false（调用方据此走网络）');
    assert.equal(local.getShelfCache(), null, '超限时必须清掉旧快照：留着它，网络失败时用户看到的是过期书架');
  });
});

test('P2-4 IndexedDB 打开失败：不得把失败永久缓存（一次失败废掉整个会话的离线能力）', async () => {
  const orig = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  let attempts = 0;
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    writable: true,
    value: {
      /** 只做到「异步失败」这一条：openDB 要的就是 onerror → reject */
      open() {
        attempts++;
        const req = {};
        setTimeout(() => {
          req.error = new Error('indexedDB denied');
          if (req.onerror) req.onerror();
        }, 0);
        return req;
      },
    },
  });
  try {
    await assert.rejects(() => offline.getBook('bk1'), /denied/, '打开失败要如实抛给调用方（降级路径不变）');
    await assert.rejects(() => offline.getBook('bk1'), /denied/);
    assert.equal(attempts, 2, '第二次调用必须重新尝试打开；原实现把 rejected promise 永久缓存，attempts 会停在 1');
  } finally {
    if (orig) Object.defineProperty(globalThis, 'indexedDB', orig);
    else delete globalThis.indexedDB;
  }
});
