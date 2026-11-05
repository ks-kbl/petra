/**
 * 「自我状态」：让 AI 在长期相处中被"潜移默化"地改变一点点（纯函数 + 可单测）。
 *
 * 用户要求：人是会变的，希望 AI 也能在聊天中慢慢改变自己的认知/情感/人格，
 * 越来越像人；但**变化必须极其缓慢**（1~2 周才勉强能感觉到），而且绝不能变成另一个人。
 *
 * 所以这里刻意不做两件事：
 * 1. 不让模型自己改写人格文本 —— 那会漂移、自我强化、最后崩人设；
 * 2. 不让单条消息直接改维度 —— 那叫"情绪化"，不叫"潜移默化"。
 *
 * 做法是两级：
 *   每条消息 → 只在当天的计数器上打点（零成本、不写盘）
 *   跨天时 → 结算一次：同类事件够多才给维度 ±0.006，其余维度以 45 天半衰期回弹
 * 另外维度永远 clamp 在「基线 ±0.2」，核心设定（名字/身份/世界观）根本不在这个模型里。
 */

export const TRAIT_KEYS = [
  "playfulness", // 俏皮
  "patience", // 耐心
  "boldness", // 敢不敢开玩笑
  "warmth", // 温柔
  "sarcasm", // 吐槽
  "initiative", // 主动程度
] as const;
export type TraitKey = (typeof TRAIT_KEYS)[number];

export const SOCIAL_EVENTS = [
  "praised", // 被夸 / 被道谢
  "corrected", // 被纠正
  "joked", // 玩梗 / 一起笑
  "longChat", // 长聊
  "userLowMood", // 用户这几天状态低
  "ignoredGreeting", // 问候没人回
] as const;
export type SocialEventKey = (typeof SOCIAL_EVENTS)[number];

/** 各维度对事件的敏感度（正=涨，负=落）。数值刻意很小，慢是产品要求 */
const EVENT_EFFECT: Record<SocialEventKey, Partial<Record<TraitKey, number>>> = {
  praised: { warmth: 1, boldness: 0.6, playfulness: 0.5 },
  corrected: { patience: 1, sarcasm: -0.8, boldness: -0.4 },
  joked: { playfulness: 1, sarcasm: 0.8 },
  longChat: { patience: 0.4, warmth: 0.4 },
  userLowMood: { warmth: 1, sarcasm: -0.6, patience: 0.5 },
  ignoredGreeting: { initiative: -1, playfulness: -0.4 },
};

/** 基线：所有维度都从这里出发（0.5 = 中性，具体性格由 persona 决定） */
export const BASELINE = 0.5;
/** 单日每个维度最多动这么多 */
export const DAILY_TRAIT_CAP = 0.006;
/** 单日所有维度合计最多动这么多 */
export const DAILY_TOTAL_CAP = 0.013;
/** 当天同类事件至少这么多次才值得结算（避免被一句话带跑） */
export const MIN_EVENTS_PER_DAY = 2;
/** 偏离基线的上限：永远不会变成另一个人 */
export const MAX_DRIFT = 0.2;
/** 回弹半衰期（天）：变化比回弹快，符合"人变得比回头快" */
export const REBOUND_HALF_LIFE_DAYS = 45;
/** 累计变化到这个量才更新一次自我叙述 */
export const NARRATIVE_THRESHOLD = 0.06;
/** 自我叙述最短间隔（天） */
export const NARRATIVE_MIN_INTERVAL_DAYS = 3;

export interface SelfState {
  version: 1;
  traits: Record<TraitKey, number>;
  /** 当前这一天的事件计数（跨天结算后清空） */
  dayCounters: Partial<Record<SocialEventKey, number>>;
  /** 计数器所属的本地日期键 */
  dayKey: string;
  /** 上次结算时间 */
  lastSettledAt: number;
  /** 累计变化量（各维度 |val-base| 之和，用来决定要不要更新叙述） */
  totalDrift: number;
  /** 注入 prompt 的那一句自我叙述；空字符串 = 不注入 */
  narrative: string;
  narrativeAt: number;
  /** 变化日志（最近 30 天）：出问题时能倒查"她为什么变成这样" */
  log: Array<{ day: string; events: Partial<Record<SocialEventKey, number>>; delta: Partial<Record<TraitKey, number>> }>;
}

export function emptySelfState(now = Date.now()): SelfState {
  return {
    version: 1,
    traits: { playfulness: BASELINE, patience: BASELINE, boldness: BASELINE, warmth: BASELINE, sarcasm: BASELINE, initiative: BASELINE },
    dayCounters: {},
    dayKey: dayKeyOf(now),
    lastSettledAt: now,
    totalDrift: 0,
    narrative: "",
    narrativeAt: 0,
    log: [],
  };
}

export function dayKeyOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function clampTrait(v: number): number {
  return Math.max(BASELINE - MAX_DRIFT, Math.min(BASELINE + MAX_DRIFT, v));
}

export function normalizeSelfState(raw: unknown, now = Date.now()): SelfState {
  const base = emptySelfState(now);
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const t = (r.traits && typeof r.traits === "object" ? r.traits : {}) as Record<string, unknown>;
  for (const k of TRAIT_KEYS) {
    const v = Number(t[k]);
    (base.traits as Record<TraitKey, number>)[k] = Number.isFinite(v) ? clampTrait(v) : BASELINE;
  }
  base.dayCounters = (r.dayCounters && typeof r.dayCounters === "object" ? r.dayCounters : {}) as SelfState["dayCounters"];
  base.dayKey = typeof r.dayKey === "string" ? r.dayKey : base.dayKey;
  base.lastSettledAt = Number.isFinite(r.lastSettledAt) ? Number(r.lastSettledAt) : now;
  base.totalDrift = Number.isFinite(r.totalDrift) ? Number(r.totalDrift) : 0;
  base.narrative = typeof r.narrative === "string" ? r.narrative : "";
  base.narrativeAt = Number.isFinite(r.narrativeAt) ? Number(r.narrativeAt) : 0;
  base.log = Array.isArray(r.log) ? (r.log as SelfState["log"]).slice(-30) : [];
  return base;
}

/** 每条用户消息打一个点（纯内存、零成本，不写盘） */
export function recordEvent(state: SelfState, event: SocialEventKey, now = Date.now()): SelfState {
  const today = dayKeyOf(now);
  const counters = state.dayKey === today ? { ...state.dayCounters } : {};
  counters[event] = (counters[event] ?? 0) + 1;
  return { ...state, dayKey: today, dayCounters: counters };
}

/**
 * 跨天结算（每天最多真正动一次；同一天反复调用是幂等的）。
 * 规则：同类事件够 MIN_EVENTS_PER_DAY 才推动对应维度，单维度 ≤ DAILY_TRAIT_CAP、合计 ≤ DAILY_TOTAL_CAP；
 * 没被推动的维度按 45 天半衰期向基线回弹。
 */
export function settleDay(state: SelfState, now = Date.now()): SelfState {
  const today = dayKeyOf(now);
  if (state.dayKey === today && state.lastSettledAt > 0 && dayKeyOf(state.lastSettledAt) === today) {
    return state; // 今天已经结算过
  }
  const events = state.dayKey === today ? state.dayCounters : state.dayCounters; // 结算的是"昨天及之前"攒下的
  const delta: Partial<Record<TraitKey, number>> = {};
  let budget = DAILY_TOTAL_CAP;

  for (const ev of SOCIAL_EVENTS) {
    const count = events[ev] ?? 0;
    if (count < MIN_EVENTS_PER_DAY) continue;
    const effect = EVENT_EFFECT[ev];
    const strength = Math.min(1, count / 4); // 4 次封顶，别让刷屏推动人格
    for (const k of TRAIT_KEYS) {
      const w = effect[k];
      if (!w) continue;
      const want = w * DAILY_TRAIT_CAP * strength;
      const room = DAILY_TRAIT_CAP - Math.abs(delta[k] ?? 0);
      if (room <= 0) continue;
      const step = Math.sign(want) * Math.min(Math.abs(want), room, budget);
      if (step === 0) continue;
      delta[k] = (delta[k] ?? 0) + step;
      budget -= Math.abs(step);
    }
    if (budget <= 0) break;
  }

  // 回弹：没有事件推动的维度，每天朝基线走一点点（45 天半衰期）
  const rebound = 1 - Math.pow(0.5, 1 / REBOUND_HALF_LIFE_DAYS);
  const traits = { ...state.traits };
  for (const k of TRAIT_KEYS) {
    const moved = delta[k] ?? 0;
    traits[k] = clampTrait(traits[k] + moved + (BASELINE - traits[k]) * rebound);
  }

  const totalDrift = TRAIT_KEYS.reduce((s, k) => s + Math.abs(traits[k] - BASELINE), 0);
  let narrative = state.narrative;
  let narrativeAt = state.narrativeAt;
  const daysSinceNarrative = (now - state.narrativeAt) / 86400000;
  if (totalDrift >= NARRATIVE_THRESHOLD && daysSinceNarrative >= NARRATIVE_MIN_INTERVAL_DAYS) {
    narrative = buildNarrative(traits);
    narrativeAt = now;
  }

  const log = [...state.log, { day: state.dayKey, events: { ...events }, delta }].slice(-30);
  return {
    ...state,
    traits,
    dayCounters: {},
    dayKey: today,
    lastSettledAt: now,
    totalDrift,
    narrative,
    narrativeAt,
    log,
  };
}

/**
 * 把数值翻译成一句人话（注入 prompt 用）。
 * 刻意模糊、不给数字、也不说"我被你改变了"——只说"现在的自己是什么样"。
 */
function buildNarrative(t: Record<TraitKey, number>): string {
  const pick = (k: TraitKey) => t[k] - BASELINE;
  const lines: string[] = [];
  if (pick("playfulness") > 0.06) lines.push("说话比以前放松，偶尔会主动起个玩笑");
  else if (pick("playfulness") < -0.06) lines.push("这段时间话少一些，不太开玩笑");
  if (pick("warmth") > 0.06) lines.push("比刚认识时更愿意照顾他的情绪");
  if (pick("sarcasm") > 0.06) lines.push("熟起来之后更敢损他两句");
  else if (pick("sarcasm") < -0.06) lines.push("被他纠正过几次，说话收敛了不少");
  if (pick("patience") > 0.06) lines.push("耐心比以前好，会多等他把话说完");
  if (pick("initiative") < -0.06) lines.push("不像以前那么爱主动搭话了");
  if (pick("boldness") > 0.06) lines.push("在他面前更放得开");
  return lines.slice(0, 3).join("；");
}

/** 注入用的文本块：没有积累到一定程度就返回空串（大多数时候是空的） */
export function selfBlock(state: SelfState | null | undefined): string {
  const text = state?.narrative?.trim();
  if (!text) return "";
  return (
    "【你现在的状态（长期相处形成的，不是他刚说的）】\n" +
    text +
    "\n【怎么用】这会影响你的语气和分寸，但不要说破、不要解释自己为什么变了、不要提「状态/数值/记忆」这类词。"
  );
}

/** 夸奖 / 道谢 */
const PRAISE_RE = /(厉害|好棒|真棒|不错|可爱|喜欢你|谢谢|辛苦了|真乖|靠谱|牛啊|牛批|绝了|太强了)/;
/** 玩梗 / 一起笑 */
const JOKE_RE = /(哈哈|hhh|233|笑死|草|梗|乐死|绷不住)/;
/** 用户在讲自己状态不好 */
const LOW_MOOD_RE = /(累死|好累|难过|烦死|崩溃|难受|失眠|不想活|压力大|emo|心累)/;

/**
 * 从一条用户消息里识别"社交事件"（纯规则、零成本）。
 *
 * 只挑**对关系/性格有长期意义**的信号；"被纠正"由 correction.ts 那边单独记，
 * 避免两套正则打架。返回的是事件数组，调用方逐条 recordEvent 即可。
 */
export function detectSocialEvents(text: string): SocialEventKey[] {
  const t = (text || "").trim();
  if (!t) return [];
  const out: SocialEventKey[] = [];
  if (PRAISE_RE.test(t)) out.push("praised");
  if (JOKE_RE.test(t)) out.push("joked");
  if (LOW_MOOD_RE.test(t)) out.push("userLowMood");
  if (t.length >= 60) out.push("longChat"); // 愿意长篇讲，说明这次聊进去了
  return out;
}

/** 当前各维度相对基线的偏离（面板/调试用，不进 prompt） */
export function traitOffsets(state: SelfState | null | undefined): Record<TraitKey, number> {
  const t = state?.traits;
  const out = {} as Record<TraitKey, number>;
  for (const k of TRAIT_KEYS) out[k] = Math.round(((t?.[k] ?? BASELINE) - BASELINE) * 1000) / 1000;
  return out;
}
