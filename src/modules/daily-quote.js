/**
 * modules/daily-quote.js —— 新增功能 ④：每日情话
 *
 * 作用：每天打开这一页，都会看到一句「今天专属」的话。
 *       这是让一个静态页面拥有「日更感」的最低成本方案 ——
 *       不需要后端、不需要数据库、不需要人工维护。
 *
 * 实现要点：
 *   - 用 core/time.js 的 dailyIndex()，以「年月日」作为散列种子，
 *     保证同一天无论刷新多少次、换什么设备，得到的都是同一句
 *     （这是「每日」而不是「随机」的关键）；
 *   - 「换一句」按钮在同一天内按顺序轮换，偏移量记在本地存储里，
 *     跨零点自动归零，第二天重新从当日专属那一句开始；
 *   - 文案清单来自 config.dailyQuotes，增删改都只改配置；
 *   - 附带显示今天的日期，强化「今日」的仪式感。
 */

import { $, create, clear } from '../core/dom.js';
import * as store from '../core/store.js';
import { dailyIndex, formatISO } from '../core/time.js';

const KEY = 'quote:offset';

export function initDailyQuote(config) {
  const box = $('#daily-quote');
  if (!box) return null;

  const quotes = (config.dailyQuotes || []).filter(Boolean);
  if (!quotes.length) {
    box.hidden = true;
    return null;
  }

  const textEl = $('#quote-text', box) || $('.quote-text', box);
  const dateEl = $('#quote-date', box) || $('.quote-date', box);

  const today = new Date();
  const todayKey = formatISO(today);
  const baseIndex = dailyIndex(today, quotes.length);

  // 跨天自动归零：存的是 {key, offset}，key 不等于今天就重置
  const saved = store.get(KEY, null);
  let offset = saved && saved.key === todayKey ? Number(saved.offset) || 0 : 0;

  function currentIndex() {
    return ((baseIndex + offset) % quotes.length + quotes.length) % quotes.length;
  }

  function render() {
    if (textEl) {
      // 淡入淡出过渡，避免文字硬切
      textEl.classList.add('is-fading');
      window.setTimeout(function () {
        textEl.textContent = quotes[currentIndex()];
        textEl.classList.remove('is-fading');
      }, 160);
    }
    if (dateEl) {
      dateEl.textContent = todayKey.replace(/-/g, ' / ');
    }
  }

  render();

  // 「换一句」
  const btn = $('#quote-next', box) || $('.quote-next', box);
  if (btn) {
    btn.addEventListener('click', function () {
      offset += 1;
      store.set(KEY, { key: todayKey, offset: offset });
      render();
    });
  }

  // 复制到剪贴板 —— 想把这句话发给对方时很有用
  const copyBtn = $('#quote-copy', box) || $('.quote-copy', box);
  if (copyBtn && navigator.clipboard) {
    copyBtn.hidden = false;
    copyBtn.addEventListener('click', function () {
      navigator.clipboard.writeText(quotes[currentIndex()]).then(function () {
        copyBtn.textContent = '已复制 ✓';
        window.setTimeout(function () { copyBtn.textContent = '复制'; }, 1600);
      }).catch(function () { /* 用户拒绝授权，静默失败即可 */ });
    });
  }

  return {
    get: function () { return quotes[currentIndex()]; },
    total: quotes.length
  };
}
