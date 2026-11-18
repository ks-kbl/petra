/**
 * 话头复核（纯函数，可单测）。
 *
 * 场景：她主动问了一句「你那个报错弄好了吗」，用户没回；两小时后用户说话了，
 * 如果不管，下一轮她可能又问一遍同样的问题——这是最"AI"的行为之一。
 *
 * 做法很轻：主动问候如果以问句结尾，就记成一条"待复核"的话头；
 * 用户之后第一次开口，就把这条标成 answered，并在上下文里说明
 * "这个话题主人已经回应过了，不要重复追问"。
 * 真正的语义判断留给模型（上下文里给原文），我们只负责状态与去重。
 */

export type LoopStatus = "open" | "answered";

export interface PendingLoop {
  /** 稳定键：发送时刻 + 文本摘要 */
  key: string;
  /** 当时问出去的原文（给模型看） */
  text: string;
  askedAt: number;
  status: LoopStatus;
}

/** 48 小时后自动作废：再追问就变成骚扰了 */
export const LOOP_TTL_MS = 48 * 60 * 60 * 1000;

export function addLoop(loops: PendingLoop[], text: string, now = Date.now()): PendingLoop[] {
  const t = (text || "").trim();
  if (!t) return loops;
  // 只记问句：陈述句不需要复核
  if (!/[？?]\s*$/.test(t)) return loops;
  const key = `${now}:${t.slice(0, 12)}`;
  if (loops.some((l) => l.key === key)) return loops;
  const next = [...loops, { key, text: t, askedAt: now, status: "open" as LoopStatus }];
  // 只留最近 6 条，超过就丢最旧的
  return next.slice(-6);
}

/** 用户开口了：把所有还没响应的话头标成 answered */
export function markAnswered(loops: PendingLoop[], now = Date.now()): PendingLoop[] {
  return loops.map((l) => (l.status === "open" && now - l.askedAt <= LOOP_TTL_MS
    ? { ...l, status: "answered" as LoopStatus }
    : l));
}

/** 还值得提的话头（超过 48h 的不算） */
export function activeLoops(loops: PendingLoop[], now = Date.now()): PendingLoop[] {
  return loops.filter((l) => now - l.askedAt <= LOOP_TTL_MS);
}

/** 给模型看的一段说明；没有就返回空串 */
export function loopLine(loops: PendingLoop[], now = Date.now()): string {
  const list = activeLoops(loops, now);
  if (!list.length) return "";
  const open = list.filter((l) => l.status === "open");
  const answered = list.filter((l) => l.status === "answered");
  const parts: string[] = [];
  if (open.length) {
    parts.push(`你之前问过「${open[open.length - 1].text}」，主人还没正面回答——不要重复问同一件事，可以自然地带一句。`);
  }
  if (answered.length) {
    parts.push(`「${answered[answered.length - 1].text}」这个话题主人已经回应过了，别再追问。`);
  }
  return parts.join("\n");
}
