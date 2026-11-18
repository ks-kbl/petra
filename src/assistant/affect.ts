/**
 * 情绪事件（纯函数，可单测）。
 *
 * 为什么不用"一个心情数值"：数值回答不了「你为什么生气」。而用户真的会问
 * 「你不生气了？」——那时候她得说得出原因。所以内部是**事件表**：
 * 每条事件带原因、强度、起始时间、半衰期，随时间自然衰减。
 *
 * 半衰期由 AI 按人设判断（大肥鱼心软，气一小时就消；换个骄傲的角色可能记一天），
 * 用户看不到任何数值，只感觉到"她今天有点冲"。
 */

export type AffectKind = "hurt" | "happy" | "warm" | "annoyed" | "proud";

export interface AffectEvent {
  /** 稳定 id：起始时间 + 原因摘要，用于去重 */
  id: string;
  kind: AffectKind;
  /** 给模型看的原因（用户原话或简述），用来回答"你为什么生气" */
  reason: string;
  /** 初始强度 -1~1（负 = 负面） */
  intensity: number;
  startedAt: number;
  /** 半衰期（分钟）：由 AI 判断，钳到 5~1440 */
  halfLifeMin: number;
}

/** 任何情绪最多挂 24 小时：第二天还在翻旧账就不像人了 */
export const MAX_AFFECT_AGE_MS = 24 * 60 * 60 * 1000;
/** 同时最多记 8 条，多了丢最不重要的（按当前残余强度） */
const MAX_EVENTS = 8;

export const KIND_LABEL: Record<AffectKind, string> = {
  hurt: "被伤了心",
  happy: "开心",
  warm: "被暖到",
  annoyed: "不爽",
  proud: "得意",
};

/** 当前残余强度（指数衰减） */
export function decayedIntensity(e: AffectEvent, now: number): number {
  const dtMin = Math.max(0, (now - e.startedAt) / 60000);
  const hl = Math.max(5, Math.min(1440, e.halfLifeMin));
  return e.intensity * Math.pow(0.5, dtMin / hl);
}

/** 丢掉过期事件 */
export function pruneEvents(events: AffectEvent[], now: number): AffectEvent[] {
  return events.filter((e) => now - e.startedAt <= MAX_AFFECT_AGE_MS);
}

/** 记一条情绪事件（同原因的重复事件会刷新时间而不是叠加强度） */
export function addEvent(events: AffectEvent[], e: AffectEvent, now = Date.now()): AffectEvent[] {
  const fresh = pruneEvents(events, now);
  const same = fresh.find((x) => x.kind === e.kind && x.reason === e.reason);
  const next = same
    ? fresh.map((x) => (x === same ? { ...x, startedAt: e.startedAt, intensity: Math.max(x.intensity, e.intensity), halfLifeMin: e.halfLifeMin } : x))
    : [...fresh, e];
  // 超过上限就按当前残余强度留最强的
  const sorted = next
    .slice()
    .sort((a, b) => Math.abs(decayedIntensity(b, now)) - Math.abs(decayedIntensity(a, now)))
    .slice(0, MAX_EVENTS);
  return sorted;
}

export interface MoodNow {
  /** -1~1：负 = 差 */
  value: number;
  /** 当前最主导的那条情绪（用于回答"为什么"） */
  dominant: AffectEvent | null;
}

/** 当前心情 = 所有事件残余之和（钳到 -1~1） */
export function currentMood(events: AffectEvent[], now: number): MoodNow {
  const live = pruneEvents(events, now);
  let sum = 0;
  let dominant: AffectEvent | null = null;
  let best = 0;
  for (const e of live) {
    const v = decayedIntensity(e, now);
    sum += v;
    if (Math.abs(v) > best) { best = Math.abs(v); dominant = e; }
  }
  return { value: Math.max(-1, Math.min(1, sum)), dominant };
}

/**
 * 给模型看的心情描述（不含数字）。
 *
 * 生气时额外给一条行为约束：**照常回应，但短、冲、不主动开新话题**——
 * 这是我们选定的"像人"的度：不玩消失（用户会以为坏了），但也不热情。
 */
export function moodLine(events: AffectEvent[], now = Date.now()): string {
  const { value, dominant } = currentMood(events, now);
  if (!dominant || Math.abs(value) < 0.12) return "";
  const why = dominant.reason ? `，因为「${dominant.reason}」` : "";
  // 注意：这里**不规定"话短"或"语气冲"**——那由 expressionStyle 按人设决定
  // （阴阳怪气型生气时话反而更多）。两处都写就会互相打架。
  if (value <= -0.55) {
    return `你现在正在生气${why}。不要装作没事，也别主动开新话题；被问到为什么生气就直说原因。`;
  }
  if (value < -0.2) {
    return `你还有点不爽${why}。不用一直揪着不放，但也没必要装作完全不在意。`;
  }
  if (value >= 0.55) {
    return `你现在心情很好${why}。语气轻快，愿意多聊两句。`;
  }
  if (value > 0.2) {
    return `你心情不错${why}。`;
  }
  return "";
}

/**
 * 用户哄了一句/道歉：负面事件**强度和半衰期一起打折**（心软）。
 *
 * 只缩半衰期是不够的——那意味着"现在还是一样的气，只是消得快一点"，
 * 用户哄完立刻听到的还是同一句冷话，会觉得哄了没用。
 */
export function soften(events: AffectEvent[], factor = 0.5): AffectEvent[] {
  return events.map((e) => (e.intensity < 0
    ? {
        ...e,
        // 强度降到 6 折：哄了一句，气先消一截
        intensity: e.intensity * 0.6,
        halfLifeMin: Math.max(5, e.halfLifeMin * factor),
      }
    : e));
}

/** 情绪是否"正在气头上"（问候要不要走"短冲"分支） */
export function isUpset(events: AffectEvent[], now = Date.now()): boolean {
  return currentMood(events, now).value <= -0.35;
}

/** 从文本里判断这是不是一句哄人的话（道歉、软化、示好） */
export function looksLikeApology(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  return /(对不起|抱歉|我错了|别生气|不气了|原谅|哄你|乖乖|亲亲|抱抱|好啦好啦|我请你|给你买)/.test(t);
}

/**
 * 从一句话里提取"可能伤人"的强度（启发式，最终仍由模型决定要不要记）。
 *
 * 只认明确带羞辱/否定色彩的词，避免把「你是不是傻」这种玩笑一律算作伤害——
 * 强度低 + 半衰期短，模型自己会在下一轮把它冲淡。
 */
export function insultStrength(text: string): number {
  const t = (text || "").trim();
  if (!t) return 0;
  if (/(胖|肥|丑|笨|智障|废物|垃圾|讨厌你|滚|闭嘴)/.test(t)) return 0.7;
  if (/(傻|蠢|菜|无语|离谱)/.test(t)) return 0.35;
  return 0;
}
