/**
 * modules/gallery.js —— 记忆卡片（核心功能 5/6）
 *
 * 重构点：内容改由 config 驱动（原版 4 张卡片写死在 HTML 中）。
 * 额外增强：卡片支持点击展开详情 —— 若 config 里配了 detail 字段，
 * 点击会翻面显示，没配则保持原样的纯展示行为，不改变原有观感。
 */

import { $, create, clear } from '../core/dom.js';
import { observe } from '../core/reveal.js';

export function initGallery(config) {
  const box = $('#gallery');
  if (!box) return null;

  const cards = config.gallery || [];
  clear(box);

  cards.forEach(function (item) {
    const detail = item.detail;
    const card = create('button', {
      class: 'card' + (detail ? ' card--clickable' : ''),
      type: 'button',
      'aria-label': item.title + '：' + (item.desc || '')
    }, [
      create('span', { class: 'icon', text: item.icon, 'aria-hidden': 'true' }),
      create('span', { class: 'title', text: item.title }),
      create('span', { class: 'desc', text: detail ? (item.desc || '') : (item.desc || '') }),
      detail ? create('span', { class: 'card-detail', text: detail }) : null
    ]);

    if (!detail) {
      card.disabled = true;     // 纯展示卡片不参与键盘 Tab 序列，保持原版语义
      card.tabIndex = -1;
    } else {
      card.addEventListener('click', function () {
        card.classList.toggle('is-open');
      });
    }

    box.appendChild(card);
  });

  observe(Array.prototype.slice.call(box.children), 90);

  return { count: cards.length };
}
