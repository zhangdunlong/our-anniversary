/**
 * core/time.js —— 时间计算层
 *
 * 全站所有与「时间」有关的逻辑集中在这里，好处是：
 *   1. 时区 / 解析格式只有一处实现，不会各模块各写一套；
 *   2. 边界条件（跨年、闰年 2-29、当天已过）集中测试；
 *   3. 单元可测 —— 纯函数，不依赖 DOM。
 */

const MS_DAY = 86400000;

/**
 * 解析本地时间字符串。
 * 兼容 'YYYY-MM-DD'、'YYYY-MM-DDTHH:mm:ss'、'YYYY/MM/DD HH:mm' 等写法。
 * 关键点：不使用 new Date(str)，因为 Safari / 部分内核会把
 * 'YYYY-MM-DD HH:mm:ss' 判为 Invalid Date。这里显式拆解数字。
 */
export function parseLocal(input) {
  if (input instanceof Date) return input;
  if (typeof input !== 'string') return new Date(NaN);

  const m = input.match(/^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (!m) return new Date(input);

  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3] || 1),
    Number(m[4] || 0),
    Number(m[5] || 0),
    Number(m[6] || 0)
  );
}

/** 两位补零 */
export function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * 把时间差拆成 天/时/分/秒。
 * 用「毫秒整除」而非本地日历差，避免夏令时造成的 ±1 小时偏移。
 * @returns {{total:number, days:number, hours:number, minutes:number, seconds:number}}
 */
export function splitDuration(from, to) {
  const diff = Math.max(0, (to ? to.getTime() : Date.now()) - from.getTime());
  const total = Math.floor(diff / 1000);
  return {
    total: total,
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60
  };
}

/** 自然日计数（去掉时分秒后相减），用于「第 N 天」这类展示 */
export function daysBetween(from, to) {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date((to || new Date()).getFullYear(), (to || new Date()).getMonth(), (to || new Date()).getDate());
  return Math.round((b - a) / MS_DAY);
}

/**
 * 计算某个「每年重复」的日期下一次出现的时间。
 * 处理两种边界：
 *   - 今年还没到 → 返回今年的那天
 *   - 今年已过   → 返回明年的那天
 *   - 2 月 29 日 → 非闰年顺延到 3 月 1 日
 */
export function nextAnnualOccurrence(month, day, from) {
  const now = from || new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  function build(year) {
    const d = new Date(year, month - 1, day);
    // 闰年回退：2-29 在非闰年会溢出成 3-01，这里显式修正语义
    if (d.getMonth() !== month - 1) d.setDate(d.getDate() + 1);
    return d;
  }

  let next = build(today.getFullYear());
  if (next < today) next = build(today.getFullYear() + 1);
  return next;
}

/**
 * 距离某个纪念日还有多少天 / 是否就是今天 / 已经过去了多久。
 * @param {string} dateStr 支持 'YYYY-MM-DD' 或 'MM-DD'
 * @param {boolean} recurring 是否每年重复
 */
export function describeDate(dateStr, recurring, from) {
  const now = from || new Date();
  const raw = parseLocal(dateStr);
  if (isNaN(raw.getTime())) return null;

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (!recurring) {
    const target = new Date(raw.getFullYear(), raw.getMonth(), raw.getDate());
    const days = Math.round((target - today) / MS_DAY);
    return { target: target, days: days, isToday: days === 0, passed: days < 0 };
  }

  const next = nextAnnualOccurrence(raw.getMonth() + 1, raw.getDate(), now);
  const days = Math.round((next - today) / MS_DAY);
  return { target: next, days: days, isToday: days === 0, passed: false };
}

/**
 * 进度：从 base 到 next 之间，now 走到了百分之几。
 * 用于「距离下个 100 天还差 xx%」这类进度条。
 */
export function progressBetween(base, next, now) {
  const start = base.getTime();
  const end = next.getTime();
  const cur = (now || new Date()).getTime();
  if (end <= start) return 1;
  return Math.min(1, Math.max(0, (cur - start) / (end - start)));
}

/** 格式化：2024年2月12日 */
export function formatCN(date) {
  return date.getFullYear() + '年' + (date.getMonth() + 1) + '月' + date.getDate() + '日';
}

/** 格式化：2023-05-20 */
export function formatISO(date) {
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

/** 格式化：2024.02.12 18:30 */
export function formatFull(date) {
  return formatISO(date).replace(/-/g, '.') + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

/**
 * 基于「日期」的确定性伪随机索引。
 * 同一天永远得到同一个结果 —— 这是「每日情话」不会刷新的关键。
 */
export function dailyIndex(seed, length) {
  const d = seed || new Date();
  const key = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  if (length <= 0) return 0;
  // 一个足够朴素的散列，目的是让相邻日期不会落在相邻文案上
  let h = key % 2147483647;
  h = (h * 48271) % 2147483647;
  return h % length;
}
