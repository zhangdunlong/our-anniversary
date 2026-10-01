/**
 * modules/timeline.js —— 新增功能 ③：恋爱时间轴（时光机）
 *
 * 作用：把「在一起」这件事从「一个数字」变成「一条线」。
 *       原版只有当前累计天数，看不到来路；时间轴把已经走过的
 *       每个百天里程碑、以及用户自己填写的真实事件，按时间顺序串起来。
 *
 * 实现要点：
 *   - 节点来源三类：
 *       ① 起点（在一起的日期）—— 由 config 推算
 *       ② 自动里程碑 —— 按 config.timeline.autoMilestoneEvery 生成，
 *          只生成「已发生」的，并用 autoMilestoneMax 封顶防止节点无限膨胀
 *       ③ 自定义事件 —— config.timeline.custom，用于记录真实事件
 *   - 特意不做任何事实编造：没配置自定义事件时，时间轴只展示
 *     客观可推算的里程碑，不会凭空生成「初次相遇」这类假信息；
 *   - 已发生 / 即将到来的节点用不同视觉区分，起点和终点（下个里程碑）
 *     分别有特殊样式，形成「来路 — 此刻 — 去向」的叙事结构；
 *   - 渲染后统一交给 core/reveal 做滚动进场。
 */

import { $, create, clear } from '../core/dom.js';
import { parseLocal, splitDuration, formatISO } from '../core/time.js';
import { observe } from '../core/reveal.js';

const MS_DAY = 86400000;

export function initTimeline(config) {
  const box = $('#timeline');
  if (!box) return null;

  const cfg = config.timeline || {};
  const together = parseLocal(config.couple.togetherAt);
  if (isNaN(together.getTime())) return null;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const elapsedDays = splitDuration(together, now).days;

  const nodes = [];

  /* ---------------------------------------------------------------- ① 起点 */
  nodes.push({
    date: together,
    title: '我们在一起了',
    desc: '从这一天起，日子开始有了另一个人的重量',
    icon: '💞',
    kind: 'start'
  });

  /* ---------------------------------------------------------------- ② 自动里程碑 */
  const every = Number(cfg.autoMilestoneEvery || 0);
  const maxAuto = Number(cfg.autoMilestoneMax || 12);

  if (every > 0) {
    const total = Math.floor(elapsedDays / every);      // 已经达成的里程碑个数
    // 从最近的一个往前取，最多 maxAuto 个，避免时间轴被 100 天节点淹没
    const startIndex = Math.max(1, total - maxAuto + 1);
    for (let i = startIndex; i <= total; i++) {
      nodes.push({
        date: new Date(together.getTime() + i * every * MS_DAY),
        title: '第 ' + i * every + ' 天',
        desc: '在一起满 ' + i * every + ' 天，我们还在往前走',
        icon: '🏅',
        kind: 'milestone'
      });
    }
  }

  /* ---------------------------------------------------------------- ③ 自定义事件 */
  (cfg.custom || []).forEach(function (item) {
    const d = parseLocal(item.date);
    if (isNaN(d.getTime())) return;
    nodes.push({
      date: d,
      title: item.title || '值得记住的一天',
      desc: item.desc || '',
      icon: item.icon || '🎉',
      kind: 'custom'
    });
  });

  /* ---------------------------------------------------------------- ④ 下一个里程碑（未来） */
  if (every > 0) {
    const nextIndex = Math.floor(elapsedDays / every) + 1;
    const nextDate = new Date(together.getTime() + nextIndex * every * MS_DAY);
    nodes.push({
      date: nextDate,
      title: '第 ' + nextIndex * every + ' 天',
      desc: '还有 ' + Math.ceil((nextDate - today) / MS_DAY) + ' 天',
      icon: '⏳',
      kind: 'future'
    });
  }

  /* ---------------------------------------------------------------- 排序渲染 */
  nodes.sort(function (a, b) { return a.date - b.date; });

  clear(box);

  nodes.forEach(function (node, index) {
    const isFuture = node.kind === 'future';
    const item = create('li', {
      class: 'tl-item tl-item--' + node.kind + (isFuture ? ' is-future' : '')
    }, [
      create('span', { class: 'tl-dot', text: node.icon, 'aria-hidden': 'true' }),
      create('div', { class: 'tl-card' }, [
        create('time', { class: 'tl-date', text: formatISO(node.date) }),
        create('h4', { class: 'tl-title', text: node.title }),
        node.desc ? create('p', { class: 'tl-desc', text: node.desc }) : null
      ])
    ]);
    // 交替左右布局由 CSS 依据 nth-child 处理，这里只补一个序号便于调试
    item.dataset.index = String(index);
    box.appendChild(item);
  });

  observe(Array.prototype.slice.call(box.children), 70);

  return {
    count: nodes.length,
    /** 把节点数组交给外部（例如海报生成）复用 */
    nodes: nodes
  };
}
