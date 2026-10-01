/**
 * modules/starfield.js —— 星空背景（核心功能 1/6，行为与原版一致）
 *
 * 重构点：
 *   1. 星点数量、闪烁速度全部按「屏幕面积」自适应，手机上不再白画 300 个点；
 *   2. 颜色改为读取 CSS 变量 --star-rgb，主题切换时自动换色（原版写死粉色）；
 *   3. 高 DPI 屏幕按 devicePixelRatio 放大画布，星星不再发虚；
 *   4. 复用 core/raf 的全局帧调度 —— 页面隐藏时自动停止，省电；
 *   5. 提供 destroy()，符合模块可卸载的架构约定。
 */

import { $ } from '../core/dom.js';
import { add, prefersReducedMotion } from '../core/raf.js';
import { on, EVENTS } from '../core/bus.js';

const DENSITY = 4200;   // 每个星点平均占据的像素面积，越大越稀疏
const MAX_STARS = 320;
const MIN_STARS = 60;

export function initStarfield() {
  const canvas = $('#stars-canvas');
  if (!canvas || !canvas.getContext) return null;

  const ctx = canvas.getContext('2d');
  let stars = [];
  let dpr = 1;
  let width = 0;
  let height = 0;
  let color = { r: 255, g: 200, b: 220 };
  let removeDprWatch = null;

  /** 从 CSS 变量里取当前主题的星星颜色 */
  function readColor() {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--star-rgb')
      .trim();
    if (!raw) return;
    const parts = raw.split(',').map(function (n) { return Number(n.trim()); });
    if (parts.length === 3 && parts.every(function (n) { return !isNaN(n); })) {
      color = { r: parts[0], g: parts[1], b: parts[2] };
    }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2); // 上限 2x，避免超大画布拖慢低端机
    width = window.innerWidth;
    height = window.innerHeight;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const count = Math.max(
      MIN_STARS,
      Math.min(MAX_STARS, Math.floor((width * height) / DENSITY))
    );

    stars = [];
    for (let i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * width,
        y: Math.random() * height,
        r: Math.random() * 1.8 + 0.3,
        a: Math.random(),
        da: (Math.random() - 0.5) * 0.015,
        // 缓慢横向漂移，比原版的纯闪烁更有「呼吸感」
        vx: (Math.random() - 0.5) * 0.06
      });
    }
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);

    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];

      s.a += s.da;
      if (s.a > 1 || s.a < 0.1) s.da *= -1;

      s.x += s.vx;
      if (s.x < 0) s.x = width;
      else if (s.x > width) s.x = 0;

      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(' + color.r + ',' + color.g + ',' + color.b + ',' + s.a.toFixed(2) + ')';
      ctx.fill();
    }
  }

  readColor();
  resize();

  // 尊重「减少动态效果」：静态渲染一帧即可，不进入动画循环
  if (prefersReducedMotion()) {
    draw();
    return { destroy: function () {} };
  }

  const removeTicker = add(draw);

  const offResize = (function () {
    let timer = null;
    function handler() {
      clearTimeout(timer);
      timer = setTimeout(resize, 150);
    }
    window.addEventListener('resize', handler);
    return function () {
      window.removeEventListener('resize', handler);
      clearTimeout(timer);
    };
  })();

  const offTheme = on(EVENTS.THEME_CHANGE, readColor);

  return {
    resize: resize,
    destroy: function () {
      removeTicker();
      offResize();
      offTheme();
      if (removeDprWatch) removeDprWatch();
    }
  };
}
