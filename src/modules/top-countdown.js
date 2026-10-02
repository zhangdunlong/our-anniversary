/**
 * modules/top-countdown.js —— 新增功能 ⑨：页面顶部「距离下一个纪念日」条
 *
 * 作用：
 *   后台管理里维护的纪念日，最需要「一眼可见」的那一条是**最近的那个**。
 *   本模块把「距离最近纪念日还有 N 天 / 今天是 XX」固定在页面顶部，
 *   让访客不必滚动到纪念日区块才知道结果。
 *
 * 数据来源与降级策略（关键）：
 *   1. 优先读 API（后台维护的数据，跨设备实时同步）；
 *   2. API 不可用（本地开发、静态托管、网络故障）→ 回退到 config 里的条目，
 *      保证页面永远不空白、也不出现加载失败的红字；
 *   3. 前端渲染完后再每 10 分钟重算一次，跨零点不会显示过期天数。
 *
 * 实现要点：
 *   - 只取「最近的一条」展示，不堆叠信息（顶部条太高会挤压首屏内容）；
 *   - 今天是纪念日 → 切一套文案 + 高亮，形成仪式感；
 *   - 天数用 core/time.js 的 describeDate 计算，与纪念日区块完全同一套语义，
 *     绝不会出现「顶部说 3 天、下面列表说 4 天」这种自相矛盾。
 */

import { $, create, clear } from '../core/dom.js';
import { describeDate } from '../core/time.js';
import { fetchAnniversaries } from './anniversaries.js';

/** 从一组条目里挑出「最近即将到来」的那条 */
function pickNearest(list, now) {
  let best = null;

  list.forEach(function (item) {
    const info = describeDate(item.date, item.recurring !== false, now);
    if (!info) return;
    // 已过去的非重复条目不参与「下一个」的竞争
    if (info.passed) return;

    if (!best || info.days < best.info.days) {
      best = { item: item, info: info };
    }
  });

  return best;
}

export function initTopCountdown(config) {
  const bar = $('#top-countdown');
  if (!bar) return null;

  const cfg = config.anniversaries || {};
  const couple = config.couple || {};

  /** 无网络时用的兜底数据：与 anniversaries.js 的降级口径保持一致 */
  function fallbackList() {
    const list = [];
    if (cfg.includeTogetherDay !== false && couple.togetherAt) {
      list.push({
        name: '在一起纪念日',
        icon: '❤️',
        date: couple.togetherAt.slice(0, 10),
        recurring: true
      });
    }
    (cfg.custom || []).forEach(function (c) {
      list.push({
        name: c.name,
        icon: c.icon || '🎂',
        date: c.date,
        recurring: c.recurring !== false
      });
    });
    return list;
  }

  function paint(list) {
    const nearest = pickNearest(list || [], new Date());

    if (!nearest) {
      bar.hidden = true;
      // 移除占位类，页头回到原本的顶部间距
      document.body.classList.remove('has-top-countdown');
      return;
    }

    const item = nearest.item;
    const info = nearest.info;

    clear(bar);

    const icon = create('span', { class: 'top-cd-icon', 'aria-hidden': 'true', text: item.icon || '🎂' });

    let textNode;
    if (info.isToday) {
      textNode = create('span', { class: 'top-cd-text is-today' }, [
        create('span', { class: 'top-cd-name', text: item.name }),
        document.createTextNode(' 就是今天 '),
        create('span', { class: 'top-cd-emoji', 'aria-hidden': 'true', text: '🎉' })
      ]);
    } else {
      textNode = create('span', { class: 'top-cd-text' }, [
        create('span', { class: 'top-cd-prefix', text: '距离 ' }),
        create('span', { class: 'top-cd-name', text: item.name }),
        create('span', { class: 'top-cd-prefix', text: ' 还有 ' }),
        create('strong', { class: 'top-cd-days', text: String(info.days) }),
        create('span', { class: 'top-cd-prefix', text: ' 天' })
      ]);
    }

    bar.appendChild(icon);
    bar.appendChild(textNode);
    bar.classList.toggle('is-today', !!info.isToday);
    bar.hidden = false;
    // 让容器多留出顶部空间，避免固定条压住页头标题
    document.body.classList.add('has-top-countdown');
  }

  let current = fallbackList();
  paint(current);

  // 异步拉取后台数据；成功就替换，失败静默保持兜底内容
  fetchAnniversaries().then(function (remote) {
    if (remote && remote.length) {
      current = remote;
      paint(current);
    }
  });

  // 跨零点 / 长时间挂机：每 10 分钟重算
  const timer = window.setInterval(function () { paint(current); }, 600000);

  return {
    /** 供后台改动后手动刷新（当前无跨页实时通信，预留接口） */
    refresh: function () { paint(current); },
    setData: function (list) { current = list || []; paint(current); },
    destroy: function () { window.clearInterval(timer); }
  };
}
