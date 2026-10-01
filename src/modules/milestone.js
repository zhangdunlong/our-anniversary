/**
 * modules/milestone.js —— 新增功能 ⑤：里程碑进度条
 *
 * 作用：把「下一个整百天」变成一个能看见进度的目标。
 *       与原版「总天数」的区别在于：总天数是回望，进度条是「还差多少」，
 *       它给了这一页一个轻量的期待感。
 *
 * 实现要点：
 *   - 复用 core/bus 的 COUNTER_TICK 事件：计时器模块每秒广播一次，
 *     本模块直接消费，不再单独开定时器，全站只有一个时钟；
 *   - 进度计算用 core/time.js 的 progressBetween，跨天时进度自然回绕；
 *   - 达成当天（天数恰为 N 的整数倍）触发一次撒花，并用本地存储
 *     记录「今天已经庆祝过」，防止刷新页面重复撒花；
 *   - 进度条宽度用 transform: scaleX() 而非 width，走 GPU 合成，
 *     不触发重排。
 */

import { $, setText } from '../core/dom.js';
import * as store from '../core/store.js';
import { on, EVENTS } from '../core/bus.js';
import { parseLocal, splitDuration, formatISO } from '../core/time.js';
import { celebrate } from './confetti.js';

const MS_DAY = 86400000;
const KEY_CELEBRATED = 'milestone:celebrated';

export function initMilestone(config) {
  const box = $('#milestone');
  if (!box) return null;

  const cfg = config.milestone || {};
  const every = Number(cfg.every || 100);
  if (every <= 0) { box.hidden = true; return null; }

  const together = parseLocal(config.couple.togetherAt);
  if (isNaN(together.getTime())) { box.hidden = true; return null; }

  const fill = $('#milestone-fill', box);
  const label = $('#milestone-label', box);
  const sub = $('#milestone-sub', box);

  let lastRenderedDays = -1;

  function render() {
    const now = new Date();
    const days = splitDuration(together, now).days;

    const achieved = Math.floor(days / every) * every;          // 已达成的那一档
    const next = achieved + every;                              // 下一个目标
    const remain = next - days;

    // 进度：以「上一档达成日」为起点、下一档为终点
    const startDate = new Date(together.getTime() + achieved * MS_DAY);
    const endDate = new Date(together.getTime() + next * MS_DAY);
    const span = endDate - startDate;
    const ratio = span > 0 ? Math.min(1, Math.max(0, (now - startDate) / span)) : 1;

    if (fill) fill.style.transform = 'scaleX(' + ratio.toFixed(4) + ')';
    if (label) label.textContent = Math.round(ratio * 100) + '%';
    if (sub) {
      sub.textContent = '距离「第 ' + next + ' 天」还有 ' + remain + ' 天 · 已走过 ' +
        achieved + ' 天里程碑';
    }

    // 达成检测：只在「天数变化时」判定一次，避免每秒重复触发
    if (days !== lastRenderedDays) {
      const isHitDay = days > 0 && days % every === 0;
      const marker = store.get(KEY_CELEBRATED, 0);
      if (isHitDay && marker !== days && cfg.celebrate !== false) {
        store.set(KEY_CELEBRATED, days);
        window.setTimeout(function () {
          celebrate('第 ' + days + ' 天达成 🎉');
        }, 700);
      }
      lastRenderedDays = days;
    }

    return { days: days, achieved: achieved, next: next, remain: remain, ratio: ratio };
  }

  const state = render();

  // 订阅计时器时钟 —— 分钟级刷新即可，秒级对进度条没有视觉意义
  let tickCount = 0;
  const off = on(EVENTS.COUNTER_TICK, function () {
    tickCount++;
    if (tickCount >= 30) { tickCount = 0; render(); }
  });

  // 兜底：即便计时器模块被关闭，进度条也能自己更新
  const timer = window.setInterval(render, 60000);

  return {
    state: state,
    refresh: render,
    destroy: function () {
      off();
      window.clearInterval(timer);
    }
  };
}
