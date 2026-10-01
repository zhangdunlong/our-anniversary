/**
 * core/reveal.js —— 滚动进场揭示
 *
 * 重构动机：原实现监听 window scroll，每次滚动都遍历全部情书行、
 * 反复调用 getBoundingClientRect()，属于典型的布局抖动（layout thrashing）。
 * 改用 IntersectionObserver：由浏览器在合成线程判定，零滚动开销，
 * 且天然支持「只触发一次」。
 */

let observer = null;
let revealedCount = 0;

function ensureObserver() {
  if (observer) return observer;

  if (!('IntersectionObserver' in window)) return null;

  observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      const delay = Number(el.dataset.revealDelay || 0);
      window.setTimeout(function () {
        el.classList.add('visible');
      }, delay);
      observer.unobserve(el); // 一次性，触发后不再观察
      revealedCount++;
    });
  }, {
    root: null,
    rootMargin: '0px 0px -15% 0px',
    threshold: 0.08
  });

  return observer;
}

/**
 * 观察一批元素
 * @param {Element[]} elements
 * @param {number} [step] 相邻元素之间的错峰延迟（毫秒）
 */
export function observe(elements, step) {
  const list = elements || [];
  const gap = step == null ? 0 : step;
  const ob = ensureObserver();

  list.forEach(function (el, i) {
    if (!el) return;
    // 统一打标记：样式层的 [data-reveal] 负责「初始隐藏」，
    // 这样调用方无需在 HTML 里手写这个属性
    el.setAttribute('data-reveal', '');
    if (!ob) {
      el.classList.add('visible'); // 不支持 IO 的老浏览器：直接显示，保证内容可读
      return;
    }
    el.dataset.revealDelay = String(i * gap);
    ob.observe(el);
  });

  return list.length;
}

/** 已揭示的元素数量（供调试面板使用） */
export function count() {
  return revealedCount;
}

/** 断开全部观察 */
export function disconnect() {
  if (observer) observer.disconnect();
  observer = null;
}
