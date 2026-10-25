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

/** 单次清洗的看门狗上限：50 MB 原件在 Worker 里实测 ≈5 s，留足慢设备余量 */
const TIMEOUT_MS = 30000;

/** 让 Worker 彻底失效：在途请求全部拒绝 + 实例销毁（下次调用重建）。
 *  每一次拒绝都会让对应调用的 catch 走到「回退主线程同步清洗」—— 宁可卡几秒出结果，
 *  也不能把用户钉在一张永不撤除的遮罩上（preview 的遮罩是 position:fixed; inset:0）。 */
function killWorker(err) {
  const e = err instanceof Error ? err : new Error('Worker 已失效');
  for (const [, p] of pending) p.reject(e);
  pending.clear();
  if (worker) {
    try {
      worker.terminate();
    } catch {
      /* already dead */
    }
    worker = null;
  }
}

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
  // 「消息永远回不来」有三种死法，每一种都必须把在途 Promise 结算掉（R150 P2-7）：
  //   ① 脚本 404 / 语法错 / 被 CSP 拦 → onerror；
  //   ② 回来的消息无法反序列化 → onmessageerror（这时 onmessage 根本不会触发）；
  //   ③ Worker 活着但卡死（OOM / 死循环）→ 没有任何回调，只能靠看门狗定时器。
  worker.onerror = (e) => killWorker(new Error((e && e.message) || 'Worker 加载失败'));
  worker.onmessageerror = () => killWorker(new Error('Worker 消息解析失败'));
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
  let timer = null;
  try {
    return await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      timer = setTimeout(() => killWorker(new Error('清洗超时（>' + TIMEOUT_MS / 1000 + 's）')), TIMEOUT_MS);
      try {
        w.postMessage({ id, bytes, opts });
      } catch (e) {
        // 拿到的是已 terminate 的实例（onerror 之后 getWorker 会重建，但在途这次还握着旧引用）
        killWorker(e instanceof Error ? e : new Error('Worker 不可用'));
      }
    });
  } catch (e) {
    console.warn('[cleaner] Worker 路径失败，回退主线程', e);
    pending.delete(id);
    return cleaner.processBook(bytes, opts);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 退出登录 / 换会话时调用：终止 Worker，释放它那份 cleaner.js 实例 */
export function disposeCleaner() {
  killWorker(new Error('已取消'));
  // 顺带释放 cleaner 的编码检测缓存（R150 P2-8）：它持有上一本书的 bytes 与解码全文，
  // 50 MB 原件 ≈ 50 MB 字节 + 100 MB 级字符串，常驻到下一次解析 —— 移动端 OOM 诱因，
  // 共享设备上也是「登出后仍能拿到一整本书正文」的隐私残留。
  cleaner.clearDetMemo();
}
