/**
 * modules/share-poster.js —— 新增功能 ⑥：一键生成分享海报
 *
 * 作用：把这一页最动人的信息（名字、相爱天数、起始日期）渲染成一张
 *       可以直接发微信 / 朋友圈的图片。这是整站「最实用」的一个功能 ——
 *       网页链接对方不一定会点开，但一张图一定会看。
 *
 * 实现要点：
 *   - 用离屏 <canvas> 手绘，不依赖 html2canvas 等任何第三方库，
 *     海报里的每个元素都是矢量绘制，缩放到任何尺寸都清晰；
 *   - 配色读取当前主题的 CSS 变量，所以「星夜」下单是暗金玫瑰、
 *     「晨光」下是粉白奶油，与页面视觉始终一致；
 *   - 导出走 canvas.toBlob()，再用 <a download> 触发下载，
 *     比 toDataURL 少一次 base64 编码，大图也不卡；
 *   - 移动端优先调用 Web Share API 直接分享到系统面板，
 *     不支持时才降级为下载；
 *   - 使用 devicePixelRatio 无关的固定坐标系（1080×1620），
 *     保证任何设备导出的图分辨率一致。
 */

import { $, create } from '../core/dom.js';
import { on, EVENTS } from '../core/bus.js';
import { parseLocal, splitDuration, formatISO, formatCN } from '../core/time.js';
import { showToast } from './confetti.js';

const W = 1080;
const H = 1620;

/** 圆角矩形路径（兼容不支持 roundRect 的旧内核） */
function roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function readVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function initSharePoster(config) {
  const openBtn = $('#poster-open');
  const modal = $('#poster-modal');
  if (!openBtn || !modal) return null;

  const canvas = $('#poster-canvas');
  const ctx = canvas.getContext('2d');
  const downloadBtn = $('#poster-download');
  const shareBtn = $('#poster-share');
  const closeBtn = $('#poster-close');

  const couple = config.couple || {};
  const share = config.share || {};
  let lastBlob = null;

  canvas.width = W;
  canvas.height = H;

  /** 绘制海报 */
  function draw() {
    const theme = document.documentElement.getAttribute('data-theme') || 'night';
    const isNight = theme === 'night';

    const now = new Date();
    const together = parseLocal(couple.togetherAt);
    const days = splitDuration(together, now).days;

    const accent = share.accent || readVar('--primary', '#ff6b6b');

    const nameA = couple.nameA || '';
    const nameB = couple.nameB || '';

    /* ---------------------------------------------------------- 背景 */
    const g = ctx.createLinearGradient(0, 0, W, H);
    if (isNight) {
      g.addColorStop(0, '#1a0008');
      g.addColorStop(0.45, '#2d0a18');
      g.addColorStop(1, '#1a0a28');
    } else {
      g.addColorStop(0, '#fff5f7');
      g.addColorStop(0.5, '#ffe9f1');
      g.addColorStop(1, '#f6f0ff');
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    /* ---------------------------------------------------------- 前景光晕 */
    const glow = ctx.createRadialGradient(W / 2, H * 0.36, 0, W / 2, H * 0.36, W * 0.78);
    glow.addColorStop(0, isNight ? 'rgba(255,107,107,0.24)' : 'rgba(255,95,162,0.16)');
    glow.addColorStop(1, 'rgba(255,107,107,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    /* ---------------------------------------------------------- 背景星点 / 爱心 */
    for (let i = 0; i < 90; i++) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      const r = Math.random() * 3 + 0.6;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = isNight
        ? 'rgba(255,200,220,' + (0.2 + Math.random() * 0.5).toFixed(2) + ')'
        : 'rgba(255,120,170,' + (0.12 + Math.random() * 0.3).toFixed(2) + ')';
      ctx.fill();
    }

    const textMain = isNight ? '#ffe9ec' : '#3a2f52';
    const textSoft = isNight ? 'rgba(255,200,205,0.72)' : 'rgba(90,74,114,0.78)';
    const font = '"PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

    /* ---------------------------------------------------------- 顶部小标题 */
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.font = '300 34px ' + font;
    ctx.fillStyle = textSoft;
    ctx.fillText('· 以爱之名，岁月为证 ·', W / 2, 200);

    /* ---------------------------------------------------------- 头像心形 */
    ctx.font = '120px ' + font;
    ctx.fillText('❤️', W / 2, 360);

    /* ---------------------------------------------------------- 名字
       不能简单地把两个名字按固定偏移画在中心两侧 —— 名字长度一变就会和
       中间的 & 撞在一起。这里先用 measureText 量出实际宽度，再按
       「名字A + 间距 + & + 间距 + 名字B」整体居中排布。 */
    const NAME_SIZE = 76;
    const AMP_SIZE = 52;
    const NAME_GAP = 46;

    ctx.textAlign = 'left';

    ctx.font = '600 ' + NAME_SIZE + 'px ' + font;
    const wA = ctx.measureText(nameA).width;
    const wB = ctx.measureText(nameB).width;

    ctx.font = '500 ' + AMP_SIZE + 'px ' + font;
    const wAmp = ctx.measureText('&').width;

    const totalW = wA + NAME_GAP + wAmp + NAME_GAP + wB;
    let cursorX = (W - totalW) / 2;
    const nameY = 530;

    ctx.font = '600 ' + NAME_SIZE + 'px ' + font;
    ctx.fillStyle = textMain;
    ctx.fillText(nameA, cursorX, nameY);
    cursorX += wA + NAME_GAP;

    ctx.font = '500 ' + AMP_SIZE + 'px ' + font;
    ctx.fillStyle = accent;
    ctx.fillText('&', cursorX, nameY + 4);
    cursorX += wAmp + NAME_GAP;

    ctx.font = '600 ' + NAME_SIZE + 'px ' + font;
    ctx.fillStyle = textMain;
    ctx.fillText(nameB, cursorX, nameY);

    ctx.textAlign = 'center';

    /* ---------------------------------------------------------- 玻璃卡片 */
    const cardX = 120;
    const cardY = 680;
    const cardW = W - cardX * 2;
    const cardH = 560;

    ctx.save();
    roundRect(ctx, cardX, cardY, cardW, cardH, 48);
    ctx.fillStyle = isNight ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.72)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = isNight ? 'rgba(255,100,100,0.22)' : 'rgba(255,120,170,0.35)';
    ctx.stroke();
    ctx.restore();

    /* ---------------------------------------------------------- 大天数 */
    const dayStr = String(days);
    ctx.font = '200 190px ' + font;
    ctx.fillStyle = accent;
    ctx.shadowColor = 'rgba(255,107,107,0.45)';
    ctx.shadowBlur = 40;
    ctx.fillText(dayStr, W / 2, cardY + 230);
    ctx.shadowBlur = 0;

    ctx.font = '300 42px ' + font;
    ctx.fillStyle = textMain;
    ctx.fillText('相 爱 天 数', W / 2, cardY + 360);

    /* ---------------------------------------------------------- 起止日期 */
    ctx.font = '300 32px ' + font;
    ctx.fillStyle = textSoft;
    ctx.fillText(formatISO(together) + '  →  ' + formatISO(now), W / 2, cardY + 440);

    ctx.font = '300 28px ' + font;
    ctx.fillText('起始于 ' + formatCN(together), W / 2, cardY + 495);

    /* ---------------------------------------------------------- 落款 */
    ctx.font = 'italic 300 40px ' + font;
    ctx.fillStyle = isNight ? 'rgba(255,150,170,0.9)' : 'rgba(214,58,125,0.9)';
    ctx.fillText('—— ' + (couple.signature || nameA), W / 2, 1420);

    ctx.font = '300 28px ' + font;
    ctx.fillStyle = textSoft;
    ctx.fillText(share.footer || '', W / 2, 1490);

    if (config.meta && config.meta.siteUrl) {
      ctx.font = '300 26px ' + font;
      ctx.fillStyle = isNight ? 'rgba(255,200,205,0.5)' : 'rgba(90,74,114,0.55)';
      ctx.fillText(config.meta.siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''), W / 2, 1540);
    }

    return { days: days };
  }

  /* ------------------------------------------------------------------ 预览 & 导出 */
  function openModal() {
    const meta = draw();
    modal.hidden = false;
    modal.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    if (shareBtn) {
      shareBtn.hidden = !(navigator.canShare && navigator.share);
    }
    // 缓存 blob 供后续下载 / 分享
    canvas.toBlob(function (blob) {
      lastBlob = blob;
    }, 'image/png');
    return meta;
  }

  function closeModal() {
    modal.classList.remove('is-open');
    modal.hidden = true;
    document.body.style.overflow = '';
  }

  function fileName() {
    const prefix = share.fileNamePrefix || 'our-love';
    return prefix + '-' + formatISO(new Date()) + '.png';
  }

  function withBlob(cb) {
    if (lastBlob) { cb(lastBlob); return; }
    canvas.toBlob(function (blob) {
      lastBlob = blob;
      cb(blob);
    }, 'image/png');
  }

  openBtn.addEventListener('click', openModal);
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', function (e) {
    if (e.target === modal) closeModal();   // 点遮罩关闭
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  if (downloadBtn) {
    downloadBtn.addEventListener('click', function () {
      withBlob(function (blob) {
        const url = URL.createObjectURL(blob);
        const a = create('a', { href: url, download: fileName() });
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        showToast('海报已保存到下载目录 📸');
      });
    });
  }

  if (shareBtn) {
    shareBtn.addEventListener('click', function () {
      withBlob(function (blob) {
        const file = new File([blob], fileName(), { type: 'image/png' });
        if (!navigator.canShare || !navigator.canShare({ files: [file] })) return;
        navigator.share({
          files: [file],
          title: config.meta ? config.meta.title : '我们的纪念日',
          text: '分享我们的第 ' + splitDuration(parseLocal(couple.togetherAt), new Date()).days + ' 天 ❤'
        }).catch(function () { /* 用户取消分享 */ });
      });
    });
  }

  // 主题切换后若海报还开着，重新绘制，保证配色跟着变
  const offTheme = on(EVENTS.THEME_CHANGE, function () {
    if (!modal.hidden) draw();
  });

  return {
    draw: draw,
    open: openModal,
    close: closeModal,
    destroy: function () { offTheme(); }
  };
}
