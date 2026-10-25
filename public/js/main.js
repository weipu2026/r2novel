/* main.js — 启动入口 + 全局错误兜底 + PWA 注册 */
import { init } from './app.js';
import { toast } from './ui.js';

document.addEventListener('DOMContentLoaded', init);

/* 全局错误兜底（投产必需）
 *
 * 没有这两条监听时，一个未捕获异常的表现是：点了没反应 / 半屏还在旧状态 / 直接白屏，
 * 用户不知道该干嘛，开发者手上也没有任何信号（私有站没有接入错误监控平台）。
 * 这里只做两件事：控制台留完整堆栈（原始错误照旧往上抛，不 preventDefault），
 * 以及给用户一句人话提示。同一次会话只提示一次 —— 渲染循环里抛错会连续触发，
 * 否则提示条会被刷成常驻。 */
let _fatalShown = false;
function reportFatal(err) {
  console.error('[fatal]', err);
  if (_fatalShown) return;
  _fatalShown = true;
  try {
    toast('出错了，请刷新页面重试', 4000);
  } catch {
    /* toast 自身失败（元素未绑定等）就只留 console，提示不该演变成二次异常 */
  }
}

// capture:true 才能在 window 上收到资源加载失败（img/script/link 的 error 不冒泡）
window.addEventListener(
  'error',
  (e) => {
    // 资源失败（封面 404、图标缺失）是局部问题，不该弹"出错了"—— 页面其余功能正常。
    // 判据：有 target 元素且没有 e.error 对象（脚本运行时错误一定带 e.error 或 message）。
    if (!e.error && e.target && e.target !== window) {
      console.warn('[resource]', e.target.src || e.target.href || e.target);
      return;
    }
    reportFatal(e.error || e.message || 'unknown error');
  },
  true
);
window.addEventListener('unhandledrejection', (e) => reportFatal(e.reason));

// PWA 注册（仅安全上下文：https / localhost / 127.0.0.1）
if ('serviceWorker' in navigator) {
  const sec = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (sec) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
}
