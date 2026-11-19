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

export function evaluateGate(i: GateInput): GateResult {
  if (i.idleMode) return { allowed: false, reason: "待机模式", retryInMs: 60_000 };
  if (i.userBusy) return { allowed: false, reason: "用户正在聊天", retryInMs: 60_000 };
  if (i.idleSeconds > 300) return { allowed: false, reason: "用户不在", retryInMs: 120_000 };
  if (i.lastDeliveryAt && i.now - i.lastDeliveryAt < i.cooldownMs) {
    // 冷却就是用户设的间隔本身：保证两次问候之间至少隔这么久
    return { allowed: false, reason: "还没到下次间隔", retryInMs: i.cooldownMs - (i.now - i.lastDeliveryAt) };
  }
  return { allowed: true };
}
