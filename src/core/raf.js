/**
 * core/raf.js —— 动画帧调度层
 *
 * 重构动机：原实现里星空用 requestAnimationFrame 无限循环，
 * 页面切到后台 / 手机锁屏后依然在跑，是纯粹的耗电大户。
 * 这里统一提供「可暂停的 ticker」，并尊重系统的「减少动态效果」偏好。
 */

import { EVENTS, emit } from './bus.js';

const runners = new Set();
let rafId = null;
let running = false;

function step(timestamp) {
  runners.forEach(function (fn) {
    try {
      fn(timestamp);
    } catch (err) {
      console.warn('[love] 动画帧回调抛错：', err);
      runners.delete(fn); // 出错即摘除，避免刷屏 + 卡死主线程
    }
  });
  if (running) rafId = window.requestAnimationFrame(step);
}

function start() {
  if (running) return;
  running = true;
  rafId = window.requestAnimationFrame(step);
}

function stop() {
  running = false;
  if (rafId !== null) {
    window.cancelAnimationFrame(rafId);
    rafId = null;
  }
}

/**
 * 注册一个每帧执行的回调
 * @param {(timestamp:number)=>void} fn
 * @returns {()=>void} 注销函数
 */
export function add(fn) {
  runners.add(fn);
  start();
  return function remove() {
    runners.delete(fn);
    if (runners.size === 0) stop();
  };
}

/** 当前是否开启了「减少动态效果」——无障碍与省电双重收益 */
export function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** 文档可见时才执行 fn，隐藏时执行 onHide（用于省电 / 暂停媒体） */
export function onVisibility(handler) {
  function fire() {
    const visible = !document.hidden;
    handler(visible);
    emit(EVENTS.VISIBILITY, visible);
  }
  document.addEventListener('visibilitychange', fire);
  return function off() { document.removeEventListener('visibilitychange', fire); };
}

// 页面切到后台自动挂起全部动画帧，回到前台自动恢复
onVisibility(function (visible) {
  if (visible) {
    if (runners.size > 0 && !running) start();
  } else {
    stop();
  }
});
