/**
 * core/store.js —— 本地持久化层
 *
 * 为什么需要它：直接裸用 localStorage 有三个坑 ——
 *   1. 隐私模式 / 禁用 Cookie 时会直接抛异常，拖垮整页脚本；
 *   2. 存进去的是字符串，取出来还得手动 JSON.parse，各处重复；
 *   3. 键名散落各处，容易撞车、难以统一清理。
 *
 * 本模块用一个命名空间前缀 + 内存降级（localStorage 不可用就退化成纯内存），
 * 把这些问题一次性解决。
 */

const PREFIX = 'love:';
const memory = Object.create(null);

let available = false;
try {
  const probe = '__love_probe__';
  window.localStorage.setItem(probe, '1');
  window.localStorage.removeItem(probe);
  available = true;
} catch (err) {
  available = false;
}

function fullKey(key) {
  return PREFIX + key;
}

/** 读取；解析失败或不存在时返回 fallback */
export function get(key, fallback) {
  const k = fullKey(key);
  try {
    const raw = available ? window.localStorage.getItem(k) : memory[k];
    if (raw === null || raw === undefined) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

/** 写入；存储不可用时静默降级到内存，功能不中断（只是刷新后丢失） */
export function set(key, value) {
  const k = fullKey(key);
  const raw = JSON.stringify(value);
  try {
    if (available) window.localStorage.setItem(k, raw);
    else memory[k] = raw;
  } catch (err) {
    memory[k] = raw;
  }
  return value;
}

/** 删除单个键 */
export function remove(key) {
  const k = fullKey(key);
  try {
    if (available) window.localStorage.removeItem(k);
  } catch (err) { /* ignore */ }
  delete memory[k];
}

/** 清空本应用写入的所有键（不影响同域其它项目） */
export function clearAll() {
  try {
    if (available) {
      Object.keys(window.localStorage)
        .filter(function (k) { return k.indexOf(PREFIX) === 0; })
        .forEach(function (k) { window.localStorage.removeItem(k); });
    }
  } catch (err) { /* ignore */ }
  Object.keys(memory).forEach(function (k) { delete memory[k]; });
}

/** 存储是否真正可用（供 UI 做提示） */
export function isPersistent() {
  return available;
}
