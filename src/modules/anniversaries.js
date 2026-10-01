/**
 * modules/anniversaries.js —— 新增功能 ②：纪念日倒计时
 *
 * 作用：把「还有多少天到生日 / 纪念日 / 情人节」一次算清，按临近程度排序。
 *       原版只有一个「在一起了多少天」的累计计时，属于「回望」；
 *       这个模块补上了「向前看」的那一半。
 *
 * 实现要点：
 *   - 数据源分三类：在一起纪念日（由 config 推算）、公共节日（客观日历）、
 *     用户自定义（生日等在 config.anniversaries.custom 里填）；
 *   - 全部交给 core/time.js 的 nextAnnualOccurrence 计算下一次出现时间，
 *     闰年 2-29 会顺延到 3-1，不会算成 Invalid Date；
 *   - 支持非重复型纪念日（recurring:false），用于「距离某一天」的倒计时；
 *   - 当天命中的纪念日会高亮并自动撒花，形成仪式感峰值；
 *   - 每 10 分钟自刷新一次，长开的页面跨零点后不会显示过期天数。
 */

import { $, create, clear } from '../core/dom.js';
import { describeDate, formatCN } from '../core/time.js';
import { observe } from '../core/reveal.js';
import { celebrate } from './confetti.js';

/** 公共节日：客观日历日期，不含任何个人隐私信息 */
const FESTIVALS = [
  { name: '情人节', icon: '🌹', date: '02-14' },
  { name: '520 我爱你', icon: '💌', date: '05-20' },
  { name: '521 我愿意', icon: '💐', date: '05-21' },
  { name: '七夕心愿', icon: '🎋', date: '08-25' },
  { name: '圣诞夜', icon: '🎄', date: '12-25' },
  { name: '元旦', icon: '🎆', date: '01-01' }
];

export function initAnniversaries(config) {
  const box = $('#anniversary-list');
  if (!box) return null;

  const cfg = config.anniversaries || {};
  const couple = config.couple || {};
  const together = couple.togetherAt;

  /** 组装出待计算的条目列表 */
  function collect() {
    const items = [];

    if (cfg.includeTogetherDay !== false && together) {
      const d = together.length >= 10 ? together.slice(0, 10) : together;
      items.push({
        name: '在一起纪念日',
        icon: '❤️',
        date: d,
        recurring: true,
        highlight: true,
        note: '从 ' + d.replace(/-/g, '.') + ' 开始'
      });
    }

    if (cfg.includeFestivals !== false) {
      FESTIVALS.forEach(function (f) {
        items.push({ name: f.name, icon: f.icon, date: f.date, recurring: true, note: '每年' });
      });
    }

    (cfg.custom || []).forEach(function (c) {
      items.push({
        name: c.name,
        icon: c.icon || '🎂',
        date: c.date,
        recurring: c.recurring !== false,
        note: c.note || (c.recurring === false ? '仅此一次' : '每年')
      });
    });

    return items;
  }

  /** 计算 + 排序 + 渲染 */
  function render() {
    const now = new Date();
    const rows = [];

    collect().forEach(function (item) {
      const info = describeDate(item.date, item.recurring, now);
      if (!info) return;
      rows.push({
        name: item.name,
        icon: item.icon,
        note: item.note,
        highlight: !!item.highlight,
        days: info.days,
        isToday: info.isToday,
        passed: info.passed,
        target: info.target
      });
    });

    // 已过去的非重复纪念日排到最后，其余按剩余天数升序
    rows.sort(function (a, b) {
      if (a.passed !== b.passed) return a.passed ? 1 : -1;
      return a.days - b.days;
    });

    clear(box);

    rows.forEach(function (row) {
      // 数字与后缀分离，today / passed 三种状态各有一套文案
      const numText = row.passed || row.isToday ? String(Math.abs(row.days)) : String(row.days);
      const labelText = row.passed ? '天前' : (row.isToday ? '就是今天 🎉' : '天后');

      const daysBox = create('span', { class: 'anniv-days' }, [
        create('span', { class: 'anniv-days-num', text: numText }),
        create('span', { class: 'anniv-days-label', text: labelText })
      ]);
      if (row.isToday) daysBox.classList.add('is-today-num');

      const card = create('div', {
        class: 'anniv' +
          (row.isToday ? ' is-today' : '') +
          (row.highlight ? ' is-highlight' : '') +
          (row.passed ? ' is-passed' : '')
      }, [
        create('span', { class: 'anniv-icon', text: row.icon, 'aria-hidden': 'true' }),
        create('span', { class: 'anniv-main' }, [
          create('span', { class: 'anniv-name', text: row.name }),
          create('span', { class: 'anniv-date', text: formatCN(row.target) + ' · ' + row.note })
        ]),
        daysBox
      ]);

      box.appendChild(card);
    });

    observe(Array.prototype.slice.call(box.children), 60);

    // 今天是纪念日 → 自动撒花
    if (rows.some(function (r) { return r.isToday; })) {
      window.setTimeout(function () { celebrate(); }, 900);
    }

    return rows.length;
  }

  const count = render();

  // 跨零点 / 长时间挂机：每 10 分钟重算，避免显示过期天数
  const timer = window.setInterval(render, 600000);

  return {
    count: count,
    refresh: render,
    destroy: function () { window.clearInterval(timer); }
  };
}
