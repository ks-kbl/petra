/**
 * "顺口问一句"：让 AI 偶尔主动提起一件很久没聊过的旧事（纯函数，可单测）。
 *
 * 为什么需要：画像和记忆都只是"模型知道了什么"，但人不主动提，用户感受不到差别 ——
 * "越聊越懂你"的体感，很大一部分来自对方**主动想起来**：
 *   "你上次说的那个接口后来解决了吗"
 * 而现在的 prompt 规则是"大部分回复用不到就当没看见"，等于永远不主动提。
 *
 * 所以这里做的是"频率受控的提醒"：
 * - 只挑重要、且确实很久没被提起过的记忆（刚聊过的再提就是复读）；
 * - 至少隔 3 小时、每天最多 2 次 —— 宁可少，不能变成念稿子；
 * - 只给一句提示，让模型自己判断这轮对话自不自然，不自然就不提。
 *
 * 依然不露任何界面：用户只会觉得"TA 居然记得"。
 */

export interface NudgeMemory {
  id: string;
  content: string;
  category: string;
  importance: number;
  lastUsedAt: number;
  createdAt: number;
}

export interface NudgeState {
  /** 上次真的给了提示的时间 */
  lastAt: number;
  /** 上次提示那天的日期键 YYYY-MM-DD */
  day: string;
  /** 当天已提示次数 */
  countToday: number;
  /** 上次提的「悬而未决」，避免连着两轮问同一件事 */
  lastLoop?: string;
}

export const NUDGE_MIN_IDLE_MS = 3 * 60 * 60 * 1000;   // 两次之间至少 3 小时
export const NUDGE_DAILY_MAX = 2;                     // 每天最多 2 次
export const NUDGE_MIN_AGE_DAYS = 2;                  // 太新的记忆不用"想起来"
export const NUDGE_MIN_IDLE_DAYS = 3;                 // 至少 3 天没被提起过

export function emptyNudgeState(): NudgeState {
  return { lastAt: 0, day: "", countToday: 0 };
}

/**
 * 从"悬而未决"里挑一条：这类是**这次的对话本身**留下的线头，
 * 比"很久没提的旧事实"更像熟人之间的关心（"你之前说的接口后来弄完了吗"）。
 */
export function pickOpenLoop(state: NudgeState | null | undefined, openLoops: string[] | null | undefined): string {
  const last = state?.lastLoop ?? "";
  const list = (openLoops ?? []).map((x) => (x || "").trim()).filter(Boolean);
  return list.find((x) => x !== last) ?? "";
}

export function normalizeNudgeState(raw: unknown): NudgeState {
  if (!raw || typeof raw !== "object") return emptyNudgeState();
  const r = raw as Record<string, unknown>;
  return {
    lastAt: Number.isFinite(r.lastAt) ? Number(r.lastAt) : 0,
    day: typeof r.day === "string" ? r.day : "",
    countToday: Number.isFinite(r.countToday) ? Math.max(0, Number(r.countToday)) : 0,
    lastLoop: typeof r.lastLoop === "string" ? r.lastLoop : undefined,
  };
}

export function nudgeDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 今天还能不能提（冷却 + 每日上限） */
export function shouldNudge(state: NudgeState | null | undefined, now: number = Date.now()): boolean {
  const s = state ?? emptyNudgeState();
  if (s.lastAt && now - s.lastAt < NUDGE_MIN_IDLE_MS) return false;
  const today = nudgeDayKey(now);
  const usedToday = s.day === today ? s.countToday : 0;
  return usedToday < NUDGE_DAILY_MAX;
}

/** 记一次提示（在真的把它塞进 prompt 之后调用） */
export function markNudged(
  state: NudgeState | null | undefined,
  now: number = Date.now(),
  lastLoop?: string,
): NudgeState {
  const s = state ?? emptyNudgeState();
  const today = nudgeDayKey(now);
  return {
    lastAt: now,
    day: today,
    countToday: (s.day === today ? s.countToday : 0) + 1,
    lastLoop: lastLoop ?? s.lastLoop,
  };
}

/**
 * 挑一件"可以顺口问问"的旧事。
 * 打分：越久没被提起越优先，其次重要度高、内容丰富。
 * 排除：身份/关系这类硬信息（问"你叫什么"很怪）、太新的、太短的、明显是任务细节的。
 */
export function pickNudgeCandidate(
  memories: NudgeMemory[],
  now: number = Date.now(),
): NudgeMemory | null {
  const dayMs = 86400000;
  const pool = (memories || []).filter((m) => {
    if (!m || !m.content) return false;
    if (m.category === "identity" || m.category === "relationship") return false;
    if (m.importance >= 3) return false;                       // 琐碎的不值得问
    if (m.content.trim().length < 6) return false;             // 太短没信息量
    if (now - m.createdAt < NUDGE_MIN_AGE_DAYS * dayMs) return false;      // 刚记下的不算"想起来"
    if (now - m.lastUsedAt < NUDGE_MIN_IDLE_DAYS * dayMs) return false;    // 刚聊过的别提
    return true;
  });
  if (!pool.length) return null;

  const score = (m: NudgeMemory) => {
    const idleDays = (now - m.lastUsedAt) / dayMs;
    return idleDays + (4 - m.importance) * 2 + Math.min(4, m.content.length / 20);
  };
  return pool.reduce((best, m) => (score(m) > score(best) ? m : best), pool[0]);
}

/** 注入 system prompt 的提示块；没有候选时返回空串 */
export function nudgeBlock(candidate: { content: string } | null | undefined): string {
  const c = candidate?.content?.trim();
  if (!c) return "";
  return (
    "【可以顺口问一句（不是任务）】\n" +
    `你想起他之前提过：${c}\n` +
    "只在**这轮对话自然接得上**的时候，顺口问一句近况（「对了，你之前说的…后来怎么样了」），" +
    "不要硬提、不要每轮都提、不要说「我记得你曾经说过」这种背诵感的话；接不上就当没看见。"
  );
}
