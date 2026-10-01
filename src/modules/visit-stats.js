/**
 * modules/visit-stats.js —— 新增功能 ⑧：本地访问足迹
 *
 * 作用：在页脚留下「你是第几次来、已经连续来了多少天、第一次来是什么时候」。
 *       对一个只有两个人的网站来说，这行字比任何「访问量统计报表」都更有温度。
 *
 * 实现要点：
 *   - 全部数据存在访问者自己的浏览器里（localStorage），
 *     不产生任何网络请求、不上报、不需要后端 —— 隐私零风险；
 *   - 「连续天数」用自然日对比：昨天来过 → +1，今天已来过 → 不变，
 *     中间断开 → 重置为 1；刻意用「删掉时分秒」的日期对象比较，
 *     避免 23:59 和次日 00:01 被判成同一天；
 *   - 「次数」用 sessionStorage 做去重标记，同一次浏览刷新页面不会重复计数；
 *   - 浏览器禁用存储时（隐私模式）自动降级：整块内容隐藏，不报错、不留白。
 */

import { $, setText } from '../core/dom.js';
import * as store from '../core/store.js';
import { formatISO, daysBetween, parseLocal } from '../core/time.js';

const KEY_STATS = 'visit:stats';
const KEY_SESSION = 'visit:counted';

/** 把日期归一化到「当天 00:00」，用于自然日比较 */
function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function initVisitStats(config) {
  const box = $('#visit-stats');
  if (!box) return null;

  if (!store.isPersistent()) {   // 隐私模式下不做展示，也不假装有数据
    box.hidden = true;
    return null;
  }

  const now = new Date();
  const todayISO = formatISO(now);

  let stats = store.get(KEY_STATS, null);
  if (!stats || !stats.firstVisit) {
    stats = { firstVisit: todayISO, visits: 0, lastVisit: null, streak: 0 };
  }

  // 同一次会话只计一次数
  let counted = false;
  try {
    counted = window.sessionStorage.getItem('love:' + KEY_SESSION) === '1';
    if (!counted) window.sessionStorage.setItem('love:' + KEY_SESSION, '1');
  } catch (err) {
    counted = false;
  }

  if (!counted) {
    stats.visits = (Number(stats.visits) || 0) + 1;

    if (stats.lastVisit) {
      const last = parseLocal(stats.lastVisit);
      const diff = daysBetween(last, now);      // 自然日差
      if (diff === 0) {
        // 今天已经来过，连续天数不变
      } else if (diff === 1) {
        stats.streak = (Number(stats.streak) || 0) + 1;
      } else {
        stats.streak = 1;
      }
    } else {
      stats.streak = 1;
    }

    stats.lastVisit = todayISO;
    store.set(KEY_STATS, stats);
  }

  /* ------------------------------------------------------------------ 渲染 */
  const first = parseLocal(stats.firstVisit);
  const knownDays = daysBetween(first, now) + 1;

  setText('#visit-text',
    '这是你第 ' + stats.visits + ' 次来到这里 · 已连续 ' + stats.streak + ' 天' +
    ' · 从 ' + stats.firstVisit.replace(/-/g, '.') + ' 至今 ' + knownDays + ' 天'
  );

  box.hidden = false;

  return {
    stats: stats,
    /** 提供清空入口，方便调试或换设备重来 */
    reset: function () {
      store.remove(KEY_STATS);
      box.hidden = true;
    }
  };
}
