/**
 * core/dom.js —— 极简 DOM 工具层
 * 只做最基础的查询与创建，不引入任何框架、不产生全局副作用。
 */

/** 查询单个元素 */
export function $(selector, root) {
  return (root || document).querySelector(selector);
}

/** 查询多个元素，返回真数组（便于使用 map / filter） */
export function $$(selector, root) {
  return Array.prototype.slice.call((root || document).querySelectorAll(selector));
}

/**
 * 创建元素
 * @param {string} tag        标签名
 * @param {object} [attrs]    属性表；class / text / html / dataset / style 有特殊语义
 * @param {Array}  [children] 子节点
 */
export function create(tag, attrs, children) {
  const node = document.createElement(tag);
  const a = attrs || {};

  Object.keys(a).forEach(function (key) {
    const val = a[key];
    if (val === null || val === undefined || val === false) return;

    if (key === 'class') node.className = val;
    else if (key === 'text') node.textContent = val;
    else if (key === 'html') node.innerHTML = val;
    else if (key === 'dataset') {
      Object.keys(val).forEach(function (k) { node.dataset[k] = val[k]; });
    } else if (key === 'style' && typeof val === 'object') {
      Object.keys(val).forEach(function (k) { node.style[k] = val[k]; });
    } else if (key.charAt(0) === 'o' && key.charAt(1) === 'n' && typeof val === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), val);
    } else {
      node.setAttribute(key, val === true ? '' : val);
    }
  });

  (children || []).forEach(function (child) {
    if (child === null || child === undefined) return;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  });

  return node;
}

/** 绑定事件，返回解绑函数（便于模块 destroy 时清理） */
export function on(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  return function off() { target.removeEventListener(type, handler, options); };
}

/** 批量设置文本（空元素自动跳过，避免 null 报错） */
export function setText(selector, text, root) {
  const el = $(selector, root);
  if (el) el.textContent = text;
  return el;
}

/** 清空子节点 */
export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

/** 安全执行：任何一个模块抛错都不应该拖垮整页 */
export function safe(label, fn) {
  try {
    return fn();
  } catch (err) {
    console.warn('[love] 模块「' + label + '」初始化失败：', err);
    return null;
  }
}
