/**
 * modules/letter.js —— 情书逐行书写（核心功能 4/6）
 *
 * 重构点：
 *   1. 情书正文改由 config 渲染 —— 原版把 12 行文案硬编码在 HTML 里，
 *      想改一句话得在 760 行里翻找；
 *   2. 滚动监听换成 IntersectionObserver —— 原版在 scroll 事件里
 *      对每一行调用 getBoundingClientRect()，属于典型的布局抖动，
 *      滚动越久越卡；现在由浏览器在合成线程判定，滚动零开销；
 *   3. 揭示策略改为「容器触发 + 整体级联」——
 *      进入信纸范围后，12 行按 150ms 间隔依次浮现，像有人正在写；
 *      而不是「谁进视口谁出现」把一封信拆得七零八落；
 *   4. 延迟做了封顶，行数再多也不会让最后一行等到天荒地老；
 *   5. 提供 replay()：按钮点一下，重新书写一遍。
 *
 * 说明：这里没有复用 core/reveal.js，因为那个模块只负责「加个 class」，
 *       而情书需要「触发时执行一段编排逻辑」。二者职责不同，刻意分开。
 */

import { $, $$, create, clear } from '../core/dom.js';
import { prefersReducedMotion } from '../core/raf.js';

/** 单行最大等待倍率：超过这个序号的都按同一拍浮现，避免长文尾部空等 */
const MAX_STAGGER_INDEX = 8;

export function initLetter(config) {
  const box = $('#letter');
  if (!box || !config.letter) return null;

  const cfgLines = config.letter.lines || [];
  const step = config.letter.revealStep == null ? 150 : config.letter.revealStep;

  /* ------------------------------------------------------------------ 渲染 */
  clear(box);
  cfgLines.forEach(function (text) {
    box.appendChild(create('div', { class: 'line', text: text, 'data-reveal': '' }));
  });
  if (config.couple.signature) {
    box.appendChild(create('div', {
      class: 'signature',
      text: '—— ' + config.couple.signature + ' ❤',
      'data-reveal': ''
    }));
  }

  const lines = $$('.line', box);
  const all = lines.concat($$('.signature', box));
  const timers = [];
  let played = false;
  let observer = null;

  function clearTimers() {
    while (timers.length) window.clearTimeout(timers.pop());
  }

  /** 逐行书写 */
  function play() {
    if (played) return;
    played = true;
    clearTimers();

    if (prefersReducedMotion()) {
      all.forEach(function (el) { el.classList.add('visible'); });
      return;
    }

    lines.forEach(function (el, i) {
      const delay = Math.min(i, MAX_STAGGER_INDEX) * step;
      timers.push(window.setTimeout(function () {
        el.classList.add('visible');
      }, delay));
    });

    // 落款永远最后出现
    const sigDelay = Math.min(lines.length, MAX_STAGGER_INDEX) * step + 300;
    timers.push(window.setTimeout(function () {
      all.forEach(function (el) { el.classList.add('visible'); });  // 兜底，确保无遗漏
    }, sigDelay));
  }

  /** 重置：把整封信收回「未书写」状态，准备重放 */
  function reset() {
    played = false;
    clearTimers();
    all.forEach(function (el) { el.classList.remove('visible'); });
  }

  /* ------------------------------------------------------------------ 触发 */
  if (!('IntersectionObserver' in window)) {
    play();                                   // 老浏览器：直接显示，保证可读
  } else {
    observer = new IntersectionObserver(function (entries) {
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          play();
          observer.disconnect();              // 只触发一次
          break;
        }
      }
    }, {
      rootMargin: '0px 0px -18% 0px',
      threshold: 0.05
    });
    observer.observe(box);
  }

  // 兜底：若用户一直没滚到信纸，8 秒后也把它显示出来，
  // 避免「打印 / 另存为 PDF」或搜索引擎抓取时拿到一封空信
  timers.push(window.setTimeout(function () {
    if (!played) play();
  }, 8000));

  return {
    /** 重新书写一遍 */
    replay: function () {
      reset();                                // reset 会把 played 复位并清空定时器
      window.setTimeout(function () { play(); }, 120);
    },
    lines: lines.length,
    destroy: function () {
      clearTimers();
      if (observer) observer.disconnect();
    }
  };
}
