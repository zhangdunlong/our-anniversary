/**
 * modules/confetti.js —— 共享特效层：爱心粒子 / 撒花
 *
 * 定位：不是独立功能，而是被「里程碑达成」「纪念日当天」「点击彩蛋」
 *       三处复用的视觉效果实现，抽出来避免三份重复代码。
 *
 * 实现要点：
 *   - 纯 DOM + CSS 动画，不额外开 canvas，也不引入任何动画库；
 *   - 粒子用完即焚（animationend 自动移除），不产生 DOM 泄漏；
 *   - 全局节流：500ms 内重复调用会被忽略，防止狂点导致卡顿；
 *   - 尊重 prefers-reduced-motion，无障碍模式下直接跳过。
 */

import { create } from '../core/dom.js';
import { prefersReducedMotion } from '../core/raf.js';

const GLYPHS = ['❤', '💖', '💕', '💗', '💝', '✨', '🌸'];
let lastRun = 0;
let layer = null;

function ensureLayer() {
  if (layer && document.body.contains(layer)) return layer;
  layer = create('div', { class: 'fx-layer', 'aria-hidden': 'true' });
  document.body.appendChild(layer);
  return layer;
}

/**
 * 在指定坐标炸开一簇爱心
 * @param {number} [x]  视口横坐标，缺省为屏幕中心
 * @param {number} [y]  视口纵坐标，缺省为屏幕中心
 * @param {number} [count] 粒子数量
 * @param {number} [power] 扩散半径倍数
 * @param {boolean} [force] 跳过节流（用于单击反馈这类高频小特效）
 */
export function burstAt(x, y, count, power, force) {
  if (prefersReducedMotion()) return 0;

  const now = Date.now();
  // 节流只作用于大簇爆炸；小颗粒反馈（force）允许每次点击都响应
  if (!force && now - lastRun < 500) return 0;
  lastRun = now;

  const host = ensureLayer();
  const cx = x == null ? window.innerWidth / 2 : x;
  const cy = y == null ? window.innerHeight / 2 : y;
  const total = count || 16;
  const radius = (power || 1) * 130;

  for (let i = 0; i < total; i++) {
    const angle = (Math.PI * 2 * i) / total + Math.random() * 0.5;
    const dist = radius * (0.5 + Math.random() * 0.7);
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;

    const p = create('span', {
      class: 'fx-particle',
      text: GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
    });

    p.style.left = cx + 'px';
    p.style.top = cy + 'px';
    p.style.fontSize = (12 + Math.random() * 14) + 'px';
    p.style.setProperty('--dx', dx.toFixed(1) + 'px');
    p.style.setProperty('--dy', dy.toFixed(1) + 'px');
    p.style.setProperty('--rot', Math.round((Math.random() - 0.5) * 540) + 'deg');
    p.style.animationDuration = (0.8 + Math.random() * 0.7).toFixed(2) + 's';

    p.addEventListener('animationend', function () {
      if (p.parentNode) p.parentNode.removeChild(p);
    });

    host.appendChild(p);
  }

  return total;
}

/** 全屏撒花（从顶部飘落），用于里程碑达成 */
export function celebrate(text) {
  if (prefersReducedMotion()) return 0;

  const host = ensureLayer();
  const total = 28;

  for (let i = 0; i < total; i++) {
    const p = create('span', {
      class: 'fx-fall',
      text: GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
    });
    p.style.left = (Math.random() * 100) + '%';
    p.style.fontSize = (14 + Math.random() * 18) + 'px';
    p.style.animationDuration = (2.2 + Math.random() * 2.2).toFixed(2) + 's';
    p.style.animationDelay = (Math.random() * 0.8).toFixed(2) + 's';

    p.addEventListener('animationend', function () {
      if (p.parentNode) p.parentNode.removeChild(p);
    });

    host.appendChild(p);
  }

  if (text) showToast(text);
  return total;
}

/** 轻量提示条，不依赖任何 UI 库 */
export function showToast(text) {
  const el = create('div', { class: 'toast', text: text, role: 'status' });
  document.body.appendChild(el);
  window.requestAnimationFrame(function () { el.classList.add('is-in'); });
  window.setTimeout(function () {
    el.classList.remove('is-in');
    window.setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 400);
  }, 2400);
}
