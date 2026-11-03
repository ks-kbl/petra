/**
 * 主动问候的计时规则（纯函数，便于单测）。
 *
 * 产品要求：**用户在设置里改完问候间隔后，下一次问候要按新间隔从"改完这一刻"重新计时**，
 * 而不是继续沿用「距上次问候」的旧节奏；重新打开小助手时同理。
 *
 * 之前这套算术散落在 main.ts 的 setTimeout 里，改设置/开关助手时很容易漏掉某条路径
 * （例如关闭小助手后再打开：定时器早被清掉，却又没人重新排一次）。抽出来后：
 * - `nextGreetingDueAt()` 统一算「锚点 + 间隔」；
 * - `clampGreetInterval()` 统一钳制用户输入；
 * - `hasGreetingIntervalElapsed()` 统一判断是否真的到点。
 */

export const GREET_INTERVAL_MIN_MINUTES = 5;
export const GREET_INTERVAL_MAX_MINUTES = 120;
export const GREET_INTERVAL_DEFAULT_MINUTES = 20;

/** 把用户输入的分钟数钳制到产品允许的 5~120 分钟；非法值回落到默认 20 */
export function clampGreetInterval(value: unknown, fallback = GREET_INTERVAL_DEFAULT_MINUTES): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(GREET_INTERVAL_MIN_MINUTES, Math.min(GREET_INTERVAL_MAX_MINUTES, Math.round(n)));
}

/** 分钟 → 毫秒（内部同样走一遍钳制，调用方传什么都不会算出 0 或负数） */
export function greetIntervalMs(minutes: unknown): number {
  return clampGreetInterval(minutes) * 60 * 1000;
}

/**
 * 下一次问候的到期时刻（绝对时间戳）。
 *
 * @param anchorAt     计时锚点：上次真正问候的时刻，或用户刚改完设置 / 刚开启助手的时刻
 * @param minutes      用户设置的间隔（分钟）
 * @param now          当前时刻
 * @param minDelayMs   最短延迟：锚点很旧（例如关掉助手很久）时不要一启动就立刻问候
 */
export function nextGreetingDueAt(
  anchorAt: number,
  minutes: unknown,
  now: number,
  minDelayMs = 5000,
): number {
  return Math.max(anchorAt + greetIntervalMs(minutes), now + Math.max(0, minDelayMs));
}

/** 从锚点起算，是否已经走完用户设置的完整间隔 */
export function hasGreetingIntervalElapsed(anchorAt: number, minutes: unknown, now: number): boolean {
  return now - anchorAt >= greetIntervalMs(minutes);
}

/**
 * 用户改完设置 / 重新开启小助手时的新锚点。
 *
 * 单独抽成函数是为了把"重新计时"这个意图写死在调用点：返回值就是当下，
 * 下一次到期 = 当下 + 新间隔。以后如果要做"从整点开始算"，也只改这里。
 */
export function greetingAnchorAfterReset(now: number): number {
  return now;
}
