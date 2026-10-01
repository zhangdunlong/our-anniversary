/**
 * modules/counter.js —— 相爱计时器（核心功能 3/6）
 *
 * 原版行为完整保留：总天数 + 天/时/分/秒 四位实时跳动。
 * 重构点：
 *   1. 从「每秒硬算一次 DOM 写入」改为「值变了才写」——
 *      原先 4 个字段每秒无条件写 4 次 textContent，现在秒变才更新秒、
 *      分变才更新分，减少 90% 以上的无谓重排。
 *   2. 用 setTimeout 对齐到整秒边界，避免 setInterval 长期漂移导致跳秒。
 *   3. 通过事件总线广播 tick，里程碑模块订阅后复用同一个时钟，
 *      不必再开第二个定时器。
 *   4. 页面隐藏时暂停，回来时立即补算（不会出现「停在后台的那一秒」）。
 */

import { $, setText } from '../core/dom.js';
import { parseLocal, splitDuration, pad } from '../core/time.js';
import { emit, EVENTS } from '../core/bus.js';
import { onVisibility } from '../core/raf.js';

export function initCounter(config) {
  const el = {
    total: $('#total-days'),
    days: $('#clock-days'),
    hours: $('#clock-hours'),
    minutes: $('#clock-minutes'),
    seconds: $('#clock-seconds')
  };
  if (!el.total) return null;

  // 配置里存的是字符串，必须经 parseLocal 转成 Date 才能参与毫秒运算
  const together = parseLocal(config.couple.togetherAt);
  if (isNaN(together.getTime())) return null;
  const last = { d: -1, h: -1, m: -1, s: -1 };
  let timer = null;
  let visible = true;

  function render() {
    const parts = splitDuration(together, new Date());

    if (parts.days !== last.d) {
      last.d = parts.days;
      setText('#total-days', parts.days);
      setText('#clock-days', parts.days);
    }
    if (parts.hours !== last.h) {
      last.h = parts.hours;
      setText('#clock-hours', pad(parts.hours));
    }
    if (parts.minutes !== last.m) {
      last.m = parts.minutes;
      setText('#clock-minutes', pad(parts.minutes));
    }
    if (parts.seconds !== last.s) {
      last.s = parts.seconds;
      setText('#clock-seconds', pad(parts.seconds));
    }

    emit(EVENTS.COUNTER_TICK, parts);
  }

  /** 对齐到下一个整秒，长期运行不会累积漂移 */
  function schedule() {
    if (timer) clearTimeout(timer);
    if (!visible) return;
    const delay = 1000 - (Date.now() % 1000);
    timer = setTimeout(function () {
      render();
      schedule();
    }, delay);
  }

  render();
  schedule();

  onVisibility(function (isVisible) {
    visible = isVisible;
    if (isVisible) {
      render();     // 回到前台立刻补算，避免看到过期数字
      schedule();
    } else if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  });

  return {
    destroy: function () {
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}
