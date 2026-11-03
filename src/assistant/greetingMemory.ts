/**
 * 主动问候的"话题记忆"（纯函数 + 小存储适配）。
 *
 * 用户要求：一天之内多次问候不要老围着同一个话题；尤其上一次问候用户**没有回复**时，
 * 下一次除非当前观察到的内容真的和上次主题相关，否则必须换话题。
 *
 * 这里只做记录与筛选，不调用模型：
 * - `replied` 由用户下一条聊天消息标记；
 * - `previousUnansweredGreeting()` 找出最近一次未回复问候；
 * - `recentGreetingTopics()` 给 prompt 提供今天已经聊过的话题摘要。
 */

export interface GreetingRecord {
  /** 问候发出的时间戳 */
  at: number;
  /** AI 结合窗口检查 + 截图得到的当前情况摘要（内部用） */
  summary: string;
  /** 实际发出的问候文本 */
  greeting: string;
  /** 用户是否回复过这次问候 */
  replied: boolean;
}

/** 本地日期键（YYYY-MM-DD），按用户所在时区，不按 UTC */
export function greetingDayKey(at: number): string {
  const d = new Date(at);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 只要今天（本地自然日）的问候记录，按时间从旧到新 */
export function greetingsToday(records: GreetingRecord[], now: number): GreetingRecord[] {
  const today = greetingDayKey(now);
  return (records || [])
    .filter((r) => r && Number.isFinite(r.at) && greetingDayKey(r.at) === today)
    .sort((a, b) => a.at - b.at);
}

/** 最近一次"用户还没回复"的今日问候；没有则返回 null */
export function previousUnansweredGreeting(records: GreetingRecord[], now: number): GreetingRecord | null {
  const today = greetingsToday(records, now);
  for (let i = today.length - 1; i >= 0; i--) {
    if (!today[i].replied) return today[i];
  }
  return null;
}

/** 今天已经问候过的话题摘要（最近 limit 条，旧→新，供 prompt 避免重复） */
export function recentGreetingTopics(records: GreetingRecord[], now: number, limit = 3): string[] {
  const today = greetingsToday(records, now);
  return today
    .map((r) => (r.summary || r.greeting || "").trim())
    .filter(Boolean)
    .slice(-Math.max(1, limit));
}

/** 把最近一条未回复问候标记为已回复；返回是否有改动 */
export function markLatestGreetingReplied(records: GreetingRecord[], now: number): boolean {
  const today = greetingsToday(records, now);
  for (let i = today.length - 1; i >= 0; i--) {
    if (!today[i].replied) {
      today[i].replied = true;
      return true;
    }
  }
  return false;
}
