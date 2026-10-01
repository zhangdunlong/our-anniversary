/**
 * modules/music.js —— 背景音乐播放器（核心功能 6/6 + 增强）
 *
 * 原版行为保留：右上角圆形按钮、🔇/🎵 图标切换、播放时的涟漪扩散动画、
 * 键盘可达（Enter / Space）、播放失败时回到静音态。
 *
 * 增强点（原版没有的能力）：
 *   1. 播放进度环 —— 用 conic-gradient 在按钮外圈画进度，不占额外空间；
 *   2. 记忆播放位置 —— 刷新 / 下次打开接着上次的位置继续听；
 *   3. 音量控制 + 记忆；
 *   4. 首次交互自动续播（规避浏览器自动播放策略）；
 *   5. 页面切到后台自动暂停（避免后台偷偷占着音频通道）。
 */

import { $, create } from '../core/dom.js';
import * as store from '../core/store.js';
import { emit, on, EVENTS } from '../core/bus.js';
import { onVisibility } from '../core/raf.js';

const KEY_POS = 'music:position';
const KEY_VOL = 'music:volume';

function formatTime(sec) {
  if (!isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

export function initMusic(config) {
  const cfg = config.music || {};
  const audio = $('#bgm');
  const btn = $('#music-btn');
  if (!audio || !btn) return null;

  const icon = $('#music-icon');
  const ripple = $('#music-ripple');
  const panel = $('#music-panel');
  const bar = $('#music-progress');
  const timeEl = $('#music-time');
  const volEl = $('#music-volume');
  const titleEl = $('#music-title');

  let playing = false;
  let userPaused = false;   // 用户主动暂停后，不再自动续播
  let positionTimer = null;

  /* ---------------------------------------------------------------- 挂载音源 */
  // 由配置决定音频地址；没配就整块控件隐藏，不留一个点不动的按钮
  if (cfg.src) {
    audio.preload = 'metadata';
    audio.src = cfg.src;
  } else {
    if (btn) btn.hidden = true;
  }

  /* ---------------------------------------------------------------- 初始化状态 */
  if (titleEl && cfg.title) titleEl.textContent = cfg.title;

  const savedVol = typeof cfg.volume === 'number' ? cfg.volume : 0.7;
  audio.volume = Math.min(1, Math.max(0, store.get(KEY_VOL, savedVol)));
  if (volEl) volEl.value = String(audio.volume);

  // 恢复上次的播放位置（放在 loadedmetadata 里，因为此刻 duration 才有效）
  if (cfg.rememberPosition) {
    audio.addEventListener('loadedmetadata', function restore() {
      const pos = store.get(KEY_POS, 0);
      if (pos > 0 && isFinite(audio.duration) && pos < audio.duration - 2) {
        audio.currentTime = pos;
      }
      audio.removeEventListener('loadedmetadata', restore);
    });
    // 若元数据已加载完毕（缓存命中），直接恢复
    if (audio.readyState >= 1) {
      const pos = store.get(KEY_POS, 0);
      if (pos > 0 && isFinite(audio.duration) && pos < audio.duration - 2) {
        audio.currentTime = pos;
      }
    }
  }

  function setState(next) {
    playing = next;
    if (icon) icon.textContent = next ? '🎵' : '🔇';
    btn.classList.toggle('playing', next);
    if (ripple) ripple.style.display = next ? 'block' : 'none';
    btn.setAttribute('aria-label', next ? '暂停音乐' : '播放音乐');
    btn.title = next ? '暂停音乐' : '播放音乐';
    emit(EVENTS.MUSIC_STATE, { playing: next });
  }

  setState(false);

  function persistPosition() {
    if (!cfg.rememberPosition) return;
    if (isFinite(audio.currentTime) && audio.currentTime > 0) {
      store.set(KEY_POS, Math.floor(audio.currentTime));
    }
  }

  function startPositionKeeper() {
    stopPositionKeeper();
    positionTimer = window.setInterval(persistPosition, 5000);
  }
  function stopPositionKeeper() {
    if (positionTimer) window.clearInterval(positionTimer);
    positionTimer = null;
  }

  /* ---------------------------------------------------------------- 播放控制 */
  function play() {
    const p = audio.play();
    if (!p || !p.then) {                       // 老内核：play() 不返回 Promise
      setState(true);
      startPositionKeeper();
      return;
    }
    p.then(function () {
      setState(true);
      startPositionKeeper();
    }).catch(function () {
      setState(false);                         // 被浏览器拦截，保持静音态
    });
  }

  function pause() {
    audio.pause();
    setState(false);
    persistPosition();
    stopPositionKeeper();
  }

  function toggle() {
    if (playing) {
      userPaused = true;
      pause();
    } else {
      userPaused = false;
      play();
    }
  }

  btn.addEventListener('click', toggle);
  btn.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });

  /* ---------------------------------------------------------------- 进度环 & 进度条 */
  function renderProgress() {
    const dur = audio.duration;
    const cur = audio.currentTime;
    const ratio = isFinite(dur) && dur > 0 ? cur / dur : 0;

    btn.style.setProperty('--progress', (ratio * 100).toFixed(2));

    if (bar && document.activeElement !== bar) bar.value = String(Math.round(ratio * 1000));
    if (timeEl) timeEl.textContent = formatTime(cur) + ' / ' + formatTime(dur);
  }

  audio.addEventListener('timeupdate', renderProgress);
  audio.addEventListener('loadedmetadata', renderProgress);

  if (bar) {
    bar.addEventListener('input', function () {
      if (!isFinite(audio.duration)) return;
      audio.currentTime = (Number(bar.value) / 1000) * audio.duration;
    });
  }

  if (volEl) {
    volEl.addEventListener('input', function () {
      audio.volume = Number(volEl.value);
      store.set(KEY_VOL, audio.volume);
    });
  }

  audio.addEventListener('ended', function () { setState(false); stopPositionKeeper(); });
  audio.addEventListener('error', function () { setState(false); stopPositionKeeper(); });

  // 页面隐藏时暂停：手机上切走 App 不该继续消耗流量和电量
  onVisibility(function (visible) {
    if (!visible && playing) pause();
  });

  /* ---------------------------------------------------------------- 首次交互自动续播 */
  let autoOff = null;
  if (cfg.autoPlayOnInteract) {
    const opts = { passive: true };
    function handler() {
      // 用户此前手动暂停过就不打扰；已在播放则无需处理
      if (!userPaused && !playing) play();
    }
    function cleanup() {
      if (!autoOff) return;
      autoOff();
      autoOff = null;
    }
    document.addEventListener('pointerdown', handler, opts);
    document.addEventListener('keydown', handler, opts);
    // 一旦播放成功或用户手动点了按钮，就彻底摘掉这两个监听
    const offState = on(EVENTS.MUSIC_STATE, function (s) {
      if (s.playing) { cleanup(); offState(); }
    });
    autoOff = function () {
      document.removeEventListener('pointerdown', handler, opts);
      document.removeEventListener('keydown', handler, opts);
    };
  }

  return {
    isPlaying: function () { return playing; },
    destroy: function () {
      stopPositionKeeper();
      persistPosition();
      if (autoOff) autoOff();
    }
  };
}
