/**
 * modules/easter-egg.js —— 新增功能 ⑦：点击彩蛋
 *
 * 作用：把「浏览」变成「互动」。每次点击 / 轻触屏幕，指尖会散出一小簇爱心；
 *       连续快点若干次，则触发一次满屏爱心爆炸 + 「我爱你 ❤」。
 *       对手机端尤其有意义 —— 用户划来划去的时候有即时反馈，页面不再「死」着。
 *
 * 实现要点：
 *   - 用事件委托绑定在 document 上，只挂 1 个监听器，
 *     不会因为页面元素增删而失效（对比给每张卡片单独绑事件的做法）；
 *   - 小簇爱心走 force 通道跳过节流，保证每次点击都有反馈；
 *     大爆炸仍然受限流保护，狂点也不会把主线程打爆；
 *   - 连击计数用「时间窗」判定：两次点击间隔超过 1200ms 就重新计数；
 *   - 明确排除按钮 / 链接等交互控件，避免和正常功能抢事件；
 *   - 触摸端用 pointerdown，鼠标端同样适用，一套代码两端通用。
 */

import { burstAt, showToast } from './confetti.js';

export function initEasterEgg(config) {
  const cfg = config.easterEgg || {};
  if (cfg.enabled === false) return null;

  const threshold = Number(cfg.burstThreshold || 7);
  const window_ms = 1200;

  let combo = 0;
  let lastTime = 0;

  /** 命中交互控件时不触发彩蛋，避免打扰正常操作 */
  function isInteractive(target) {
    if (!target || !target.closest) return false;
    return !!target.closest('a,button,input,textarea,select,label,[role="button"],[contenteditable="true"]');
  }

  function handler(e) {
    if (isInteractive(e.target)) return;

    const x = e.clientX;
    const y = e.clientY;
    if (typeof x !== 'number' || typeof y !== 'number') return;

    const now = Date.now();
    combo = now - lastTime > window_ms ? 1 : combo + 1;
    lastTime = now;

    if (combo >= threshold) {
      burstAt(x, y, 26, 1.6);
      showToast(cfg.burstText || '我爱你 ❤');
      combo = 0;
    } else {
      // 小簇反馈：3 颗，小半径，不节流
      burstAt(x, y, 3, 0.42, true);
    }
  }

  document.addEventListener('pointerdown', handler, { passive: true });

  // 触摸设备的键盘/鼠标用户也能玩：空格键在中心爆一次
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    if (isInteractive(e.target)) return;
    burstAt(null, null, 10, 1);
  });

  return {
    destroy: function () {
      document.removeEventListener('pointerdown', handler);
    }
  };
}
