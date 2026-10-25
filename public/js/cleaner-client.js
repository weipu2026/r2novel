/* cleaner-client.js — 清洗入口的主线程侧：大文件丢 Worker，小文件同步跑（#149 P1-B）
 *
 * 起因：cleaner.processBook 是同步的，实测 10 MB 占主线程 1010 ms（50 MB 上限按线性外推 ≈5 s），
 * 期间页面完全无响应 —— 用户以为崩了。这是"试运行碰不到、投产才暴露"的那类故障：
 * 平时传的书 1~2 MB（<100 ms，无感），真丢一本合集进来就假死。
 *
 * 为什么不在 cleaner.js 里改成 async：它是浏览器 / Node 共用的纯函数，464 条单测跑在上面，
 * 服务端与测试都按同步语义调用。把它改成 async 等于把那层保护拆掉换一个性能收益 —— 不划算。
 * 所以只在**调用侧**分叉：Worker 里跑同一份 cleaner.js，主线程只管等消息。
 *
 * 阈值 1.5 MB：低于它的解析实测 <100 ms（1 MB = 63 ms），走同步更快 ——
 * Worker 有启动开销（拉脚本 + 编译）和结构化克隆的往返，小文件反而更慢。
 */
import * as cleaner from './cleaner.js';

/** 超过这个字节数才值得进 Worker（1.5 MB） */
export const OFFLOAD_BYTES = 1.5 * 1024 * 1024;

let worker = null;
let seq = 0;
const pending = new Map(); // id → { resolve, reject }

export function needsWorker(bytes) {
  return !!(bytes && bytes.length >= OFFLOAD_BYTES);
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./cleaner-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const { id, ok, result, error } = e.data || {};
    const p = pending.get(id);
    if (!p) return; // 已回退/已作废的请求
    pending.delete(id);
    if (ok) p.resolve(result);
    else p.reject(new Error(error || '清洗失败'));
  };
  worker.onerror = (e) => {
    // Worker 整体挂了（脚本 404 / 语法错 / 被 CSP 拦）：在途请求全拒，下次调用重建
    const err = new Error((e && e.message) || 'Worker 加载失败');
    for (const [, p] of pending) p.reject(err);
    pending.clear();
    try {
      worker.terminate();
    } catch {
      /* already dead */
    }
    worker = null;
  };
  return worker;
}

/**
 * 解析一本书：大文件走 Worker（不阻塞 UI），小文件 / 无 Worker 环境（Node 单测）同步跑。
 * 返回 Promise；Worker 路径失败会**回退同步**再跑一次 —— 宁可卡一秒，也不能让用户拿不到预览。
 */
export async function processBookOff(bytes, opts) {
  if (typeof Worker !== 'function' || !needsWorker(bytes)) {
    return cleaner.processBook(bytes, opts);
  }
  let w;
  try {
    w = getWorker();
  } catch {
    return cleaner.processBook(bytes, opts); // 构造 Worker 就失败（老浏览器/被拦）
  }
  const id = ++seq;
  try {
    return await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage({ id, bytes, opts });
    });
  } catch (e) {
    console.warn('[cleaner] Worker 路径失败，回退主线程', e);
    pending.delete(id);
    return cleaner.processBook(bytes, opts);
  }
}

/** 退出登录 / 换会话时调用：终止 Worker，释放它那份 cleaner.js 实例 */
export function disposeCleaner() {
  for (const [, p] of pending) p.reject(new Error('已取消'));
  pending.clear();
  if (worker) {
    try {
      worker.terminate();
    } catch {
      /* ignore */
    }
    worker = null;
  }
}
