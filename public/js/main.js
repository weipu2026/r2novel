/* main.js — 启动入口 + PWA 注册 */
import { init } from './app.js';

document.addEventListener('DOMContentLoaded', init);

// PWA 注册（仅安全上下文：https / localhost / 127.0.0.1）
if ('serviceWorker' in navigator) {
  const sec = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (sec) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
}
