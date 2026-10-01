/**
 * core/bus.js —— 事件总线（发布 / 订阅）
 *
 * 作用：让模块之间「只依赖事件名，不依赖彼此的引用」。
 * 例：主题切换模块 emit('theme:change')，星空模块订阅后换色，
 *     两者互不 import，未来删掉任意一个都不会报错。
 */

const channels = Object.create(null);

/** 订阅，返回取消订阅函数 */
export function on(event, handler) {
  if (!channels[event]) channels[event] = [];
  channels[event].push(handler);
  return function off() {
    const list = channels[event];
    if (!list) return;
    const i = list.indexOf(handler);
    if (i > -1) list.splice(i, 1);
  };
}

/** 只订阅一次 */
export function once(event, handler) {
  const off = on(event, function (payload) {
    off();
    handler(payload);
  });
  return off;
}

/** 发布 */
export function emit(event, payload) {
  const list = channels[event];
  if (!list || !list.length) return;
  // 复制一份再遍历，防止订阅者在回调里取消订阅导致遍历错位
  list.slice().forEach(function (handler) {
    try {
      handler(payload);
    } catch (err) {
      console.warn('[love] 事件「' + event + '」的处理函数抛错：', err);
    }
  });
}

/** 事件名常量表 —— 集中声明可避免拼写错误 */
export const EVENTS = {
  THEME_CHANGE: 'theme:change',
  MUSIC_STATE: 'music:state',
  COUNTER_TICK: 'counter:tick',
  MILESTONE_HIT: 'milestone:hit',
  VISIBILITY: 'app:visibility'
};
