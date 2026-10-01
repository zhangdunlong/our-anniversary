/**
 * modules/hearts.js —— 浮动爱心（核心功能 2/6）
 *
 * 重构点：
 *   1. 原版在页面加载时一次性创建 20 个 DOM 节点，永远循环播放 ——
 *      手机端长时间挂着会有持续合成开销。现改为「按需补充」：
 *      每个爱心的动画结束后再回收重建，DOM 数量恒定但视觉连续不断。
 *   2. 数量随窗口宽度自适应；窗口 resize 时防抖重建（原版只在加载时算一次）。
 *   3. 尊重 prefers-reduced-motion：开启后完全不渲染飘动爱心。
 */

import { $, create } from '../core/dom.js';
import { prefersReducedMotion } from '../core/raf.js';

const POOL = ['❤', '💕', '💖', '💗', '💝', '✨', '🌸'];

export function initHearts() {
  const container = $('#floating-hearts');
  if (!container) return null;

  if (prefersReducedMotion()) {
    container.style.display = 'none';
    return { destroy: function () {} };
  }

  let alive = 0;
  let targetCount = 0;
  let stopped = false;
  const nodes = new Set();

  function spawn() {
    if (stopped) return;

    const el = create('span', {
      class: 'floating-heart',
      'aria-hidden': 'true',
      text: POOL[Math.floor(Math.random() * POOL.length)]
    });

    const duration = 12 + Math.random() * 16;
    el.style.left = (Math.random() * 100) + '%';
    el.style.fontSize = (12 + Math.random() * 18) + 'px';
    el.style.animationDuration = duration + 's';
    el.style.animationDelay = (Math.random() * 2) + 's';

    function recycle() {
      el.removeEventListener('animationend', recycle);
      nodes.delete(el);
      if (el.parentNode) el.parentNode.removeChild(el);
      alive--;
      // 回收后立刻补位，形成永不间断的循环
      if (!stopped && alive < targetCount) spawn();
    }

    el.addEventListener('animationend', recycle);

    container.appendChild(el);
    nodes.add(el);
    alive++;
  }

  function computeTarget() {
    // 宽屏多、窄屏少；上限 18 个，避免低端机合成压力
    return Math.max(6, Math.min(18, Math.floor(window.innerWidth / 60)));
  }

  function fill() {
    targetCount = computeTarget();
    while (alive < targetCount) spawn();
  }

  function rebuild() {
    stopped = true;
    nodes.forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    nodes.clear();
    alive = 0;
    stopped = false;
    fill();
  }

  fill();

  let timer = null;
  function onResize() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      if (computeTarget() !== targetCount) rebuild();
    }, 250);
  }
  window.addEventListener('resize', onResize);

  return {
    destroy: function () {
      stopped = true;
      window.removeEventListener('resize', onResize);
      clearTimeout(timer);
      rebuild.__noop = true;
      nodes.forEach(function (el) {
        if (el.parentNode) el.parentNode.removeChild(el);
      });
      nodes.clear();
      alive = 0;
    }
  };
}
