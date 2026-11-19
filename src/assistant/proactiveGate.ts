/**
 * 主动消息的「闸门」（纯函数，可单测）。
 *
 * 以前只有一条规则：距上次问候够久就发。于是出现两种难看的场面：
 * 深夜两点来一句"在忙吗"；或者用户刚说完话，机器人又来一句没头没尾的问候。
 * 现在把该拦的都拦下来，且**拦下来时给一个"多久之后再试"**，而不是直接丢掉。
 */

export interface GateInput {
  /** 当前时刻 */
  now: number;
  /** 上次成功投递的时刻，0 = 从没发过 */
  lastDeliveryAt: number;
  /** 今天已经主动发了几次 */
  deliveredToday: number;
  /**
   * 最近的投递时刻（ms，任意顺序，函数内部自己算窗口）。
   *
   * 为什么不用"每天 N 次"：默认间隔 20 分钟时，一天能说 40 多次，
   * 用一个日额度（比如 8 次）会在上午就把额度用完，然后**一下午一句话都没有**——
   * 用户看到的就是"定时问候坏了"。改成滑动窗口：短时间内别刷屏，长时段内保持存在感。
   */
  recentDeliveries?: number[];
  /** 今天最多几次 */
  dailyLimit: number;
  /** 两次之间的最小间隔（ms） */
  cooldownMs: number;
  /** 用户是不是正在聊天（对话框开着 / 上一轮还没完） */
  userBusy: boolean;
  /** 用户空闲了多少秒（>300 视为离开） */
  idleSeconds: number;
  /** 系统待机（缩到托盘睡觉） */
  idleMode: boolean;
}

export interface GateResult {
  allowed: boolean;
  /** 不允许时的原因（写日志用） */
  reason?: string;
  /** 建议多久之后再试（ms）；不填则走默认 */
  retryInMs?: number;
}

/** 免打扰时段：23:00 ~ 07:30（分钟数，跨午夜） */
export const QUIET_START_MIN = 23 * 60;
export const QUIET_END_MIN = 7 * 60 + 30;

export function inQuietHours(now: number): boolean {
  const d = new Date(now);
  const m = d.getHours() * 60 + d.getMinutes();
  return m >= QUIET_START_MIN || m < QUIET_END_MIN;
}

/** 到下一个"允许说话"的时刻（免打扰结束后再等 15 分钟，别卡着点弹） */
export function nextQuietEnd(now: number): number {
  const d = new Date(now);
  const m = d.getHours() * 60 + d.getMinutes();
  if (m < QUIET_END_MIN) {
    d.setHours(Math.floor(QUIET_END_MIN / 60), QUIET_END_MIN % 60, 0, 0);
  } else {
    d.setDate(d.getDate() + 1);
    d.setHours(Math.floor(QUIET_END_MIN / 60), QUIET_END_MIN % 60, 0, 0);
  }
  return d.getTime() + 15 * 60 * 1000;
}

/** 短窗口：90 分钟内最多一次 */
export const SHORT_WINDOW_MS = 90 * 60 * 1000;
/** 长窗口：6 小时内最多 4 次 */
export const LONG_WINDOW_MS = 6 * 60 * 60 * 1000;
export const LONG_WINDOW_LIMIT = 4;

export function evaluateGate(i: GateInput): GateResult {
  if (i.idleMode) return { allowed: false, reason: "待机模式", retryInMs: 60_000 };
  if (i.userBusy) return { allowed: false, reason: "用户正在聊天", retryInMs: 60_000 };
  if (inQuietHours(i.now)) return { allowed: false, reason: "免打扰时段", retryInMs: Math.max(60_000, nextQuietEnd(i.now) - i.now) };
  if (i.idleSeconds > 300) return { allowed: false, reason: "用户不在", retryInMs: 120_000 };
  const recent = (i.recentDeliveries ?? []).filter((t) => Number.isFinite(t) && t <= i.now);
  // ① 短窗口：90 分钟内最多 1 次（比"间隔"更宽，但能挡住连发）
  const inShort = recent.filter((t) => i.now - t < SHORT_WINDOW_MS);
  if (inShort.length >= 1) {
    return { allowed: false, reason: "90 分钟内已经说过一次", retryInMs: SHORT_WINDOW_MS - (i.now - inShort[inShort.length - 1]) };
  }
  // ② 长窗口：6 小时内最多 4 次（保证下午/晚上不会彻底哑火，也不会唠叨）
  const inLong = recent.filter((t) => i.now - t < LONG_WINDOW_MS);
  if (inLong.length >= LONG_WINDOW_LIMIT) {
    const oldest = Math.min(...inLong);
    return { allowed: false, reason: "6 小时内说得有点多了", retryInMs: LONG_WINDOW_MS - (i.now - oldest) };
  }
  // ③ 日硬顶：兜住极端情况（不算正常节奏）
  if (i.deliveredToday >= i.dailyLimit) return { allowed: false, reason: "今日次数超上限", retryInMs: 60 * 60_000 };
  if (i.lastDeliveryAt && i.now - i.lastDeliveryAt < i.cooldownMs) {
    return { allowed: false, reason: "距上次太近", retryInMs: i.cooldownMs - (i.now - i.lastDeliveryAt) };
  }
  return { allowed: true };
}
