/**
 * modules/theme.js —— 新增功能 ①：昼夜双主题
 *
 * 作用：深夜是星夜，白天是晨光。原版只有一套深色皮肤，白天看屏幕偏暗、
 *       发给长辈看也不够友好。现在可以在「星夜 / 晨光」之间切换，
 *       默认跟随系统设置，选择结果会被记住。
 *
 * 实现要点：
 *   - 所有颜色都收敛为 CSS 自定义属性（见 styles/tokens.css），
 *     切换主题 = 改 <html data-theme>，一行属性带动整页换肤，
 *     JS 完全不碰任何具体颜色值；
 *   - 用 matchMedia('(prefers-color-scheme: dark)') 监听系统偏好，
 *     系统切换时（如手机日落自动变暗）页面实时跟随；
 *   - 主题变更通过事件总线广播，星空 / 海报 / 地图等模块各自响应，
 *     互不引用；
 *   - 同步更新 <meta name="theme-color">，手机浏览器地址栏也随之变色。
 */

import { $ } from '../core/dom.js';
import * as store from '../core/store.js';
import { emit, EVENTS } from '../core/bus.js';

const THEMES = ['night', 'dawn'];
const KEY = 'theme';

export function initTheme(config) {
  const cfg = (config.theme) || {};
  const root = document.documentElement;
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  /** 解析出实际生效的主题（把 'auto' 落地成具体值） */
  function resolve() {
    const saved = store.get(KEY, null);
    const mode = saved || cfg.default || 'auto';
    if (mode === 'auto') return mq && mq.matches ? 'night' : 'dawn';
    return THEMES.indexOf(mode) > -1 ? mode : 'night';
  }

  function apply(theme, persist) {
    root.setAttribute('data-theme', theme);
    if (persist) store.set(KEY, theme);

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', theme === 'night' ? '#1a0008' : '#fff5f7');
    }

    const btn = $('#theme-btn');
    if (btn) {
      const isNight = theme === 'night';
      btn.textContent = isNight ? '🌙' : '☀️';
      btn.setAttribute('aria-label', isNight ? '切换到晨光主题' : '切换到星夜主题');
      btn.title = isNight ? '切换到晨光主题' : '切换到星夜主题';
    }

    emit(EVENTS.THEME_CHANGE, { theme: theme });
    return theme;
  }

  let current = apply(resolve(), false);

  // 系统主题变化时，仅在用户没手动指定过的情况下跟随
  if (mq) {
    const onChange = function () {
      if (store.get(KEY, null)) return;
      current = apply(resolve(), false);
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  // 绑定切换按钮
  const btn = $('#theme-btn');
  if (btn && cfg.switcher !== false) {
    btn.hidden = false;
    btn.addEventListener('click', function () {
      const next = current === 'night' ? 'dawn' : 'night';
      current = apply(next, true);
    });
  }

  return {
    get: function () { return current; },
    set: function (t) { current = apply(t, true); }
  };
}
