/**
 * 「这件事现在提合适吗」——记忆的时间分类与提及评分（纯函数，可单测）。
 *
 * 用户举的例子：上午问候时知道他在这化学网课，晚上的问候就不该再提，
 * 因为这两件事在人的脑子里没有必然联系；但"你上次说喜欢这首歌"过两周提也自然。
 *
 * 所以记忆要分三类，用三套不同寿命：
 *   现场情境（SIUATIONAL）：一两小时内有效，过期就当没发生过；
 *   事件记忆（EVENT）：按类型给半衰期，越久越少提；
 *   里程碑（MILESTONE）：永不过期，只在纪念日附近被主动提。
 *
 * 评分 = 相关性 × 新鲜度 × 当前情绪是否合适。最后一项常被忽略：
 * 心情很差的时候翻出开心旧事，反而像在敷衍。
 */

export type MemoryClass = "situational" | "event" | "milestone";

export interface MemoryLike {
  content: string;
  /** 记忆库里已有的分类（identity/preference/habit/event...） */
  category?: string;
  /** 发生/记录时间（ms） */
  at: number;
}

/** 现场情境：1.5 小时后基本没意义了 */
export const SITUATIONAL_TTL_MS = 90 * 60 * 1000;

/** 现场情境的用词特征：正在做什么、现在在哪 */
const SITUATIONAL_RE = /(正在|在上|在学|在开|在忙|刚刚在|现在在|这会儿|刚才在)/;
/** 里程碑的用词特征 */
const MILESTONE_RE = /(第一次|第一次见|认识第|纪念|生日|周年)/;

/** 事件记忆按类型给半衰期（分钟） */
const EVENT_HALF_LIFE_MIN: Record<string, number> = {
  event: 24 * 60,
  schedule: 12 * 60,
  habit: 30 * 24 * 60,
  preference: 30 * 24 * 60,
  relationship: 60 * 24 * 60,
  identity: 365 * 24 * 60,
  other: 24 * 60,
};

export function classifyMemory(m: MemoryLike, now = Date.now()): MemoryClass {
  if (MILESTONE_RE.test(m.content)) return "milestone";
  // 只要表述是"正在做什么"，就永远算现场情境——过没过期由 freshness 判 0。
  // 注意不能"过期后降级成普通事件"：11 小时前的"正在上网课"提起来比不提更糟，
  // 那正是用户举的反例（上午的课不能拿到晚上说）。
  if (SITUATIONAL_RE.test(m.content)) return "situational";
  return "event";
}

/** 新鲜度 0~1：半衰期模型，越久越低 */
export function freshness(m: MemoryLike, cls: MemoryClass, now = Date.now()): number {
  if (cls === "milestone") return 1;
  if (cls === "situational") {
    return now - m.at <= SITUATIONAL_TTL_MS ? 1 : 0;
  }
  const hl = EVENT_HALF_LIFE_MIN[m.category ?? "other"] ?? EVENT_HALF_LIFE_MIN.other;
  const dtMin = Math.max(0, (now - m.at) / 60000);
  return Math.pow(0.5, dtMin / hl);
}

export interface MentionContext {
  now: number;
  /** 当前心情 -1~1（差的时候别翻开心旧事） */
  mood?: number;
  /** 这条记忆和当前话题的相关性 0~1（来自检索分数，缺省按中等算） */
  relevance?: number;
}

export interface MentionScore {
  cls: MemoryClass;
  score: number;
  /** 该不该提 */
  should: boolean;
  /** 不该提的原因（调试用） */
  why?: string;
}

/**
 * 给一条记忆打分。
 *
 * 阈值 0.18 是经验值：低于它的基本已经是"很久以前的一件小事"，
 * 提出来只会让用户觉得"你怎么还记得这个"。
 */
export function scoreMention(m: MemoryLike, ctx: MentionContext): MentionScore {
  const cls = classifyMemory(m, ctx.now);
  const fresh = freshness(m, cls, ctx.now);
  const rel = ctx.relevance ?? 0.6;
  let score = cls === "milestone" ? Math.max(0.5, rel) : rel * fresh;
  // 心情差的时候，纯开心类记忆降权（不是不能提，是别在气头上提）
  if ((ctx.mood ?? 0) <= -0.35 && /(开心|好玩|笑|喜欢)/.test(m.content)) score *= 0.55;
  const should = score >= (cls === "milestone" ? 0.35 : 0.18);
  let why: string | undefined;
  if (!should) {
    why = cls === "situational" ? "现场情境已过期" : "太久远了，提起来会显得刻意";
  }
  return { cls, score, should, why };
}

/** 过滤一批记忆，只留下"现在提合适"的（保持原顺序） */
export function filterMentionable<T extends MemoryLike>(list: T[], ctx: MentionContext): T[] {
  return list.filter((m) => scoreMention(m, ctx).should);
}
