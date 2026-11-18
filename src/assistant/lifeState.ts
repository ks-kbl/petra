/**
 * 桌宠的「生活状态」：精力、心情、睡眠阶段（纯函数，可单测）。
 *
 * 为什么要它：以前的问候只看"距上次问候多久"，所以永远问得出来"吃了吗"这种
 * 没有由头的话。有了状态之后，问候的由头是"她自己的状态"——
 * 刚睡醒、忙了一下午有点累、深夜犯困——同一句话听起来就是另一个意思。
 *
 * 设计约束（按项目准则）：
 * - **不向用户暴露任何数值**，用户只会感觉到"她今天有点蔫"；
 * - 全部由时间自动演进，不需要用户配置；
 * - 每次演进必须幂等：同一时刻算两次结果一样（tick 可能重复调用）。
 */

export type SleepStage = "awake" | "waking" | "asleep";

export interface LifeState {
  /** 精力 0~1 */
  energy: number;
  /** 心情 -1~1（0 = 平静） */
  mood: number;
  sleep: SleepStage;
  /** 最近一次和用户互动的时间（ms），0 = 还没有过 */
  lastInteractionAt: number;
  /** 上次演进到的时刻（ms）：用它算经过了多少分钟 */
  updatedAt: number;
}

/** 睡觉时段：23:30 睡，07:00 起（分钟数，便于比较） */
export const SLEEP_START_MIN = 23 * 60 + 30;
export const SLEEP_END_MIN = 7 * 60;
/** 刚醒来的宽限期（分钟）：这段时间精力还没回满、说话更短 */
export const WAKING_GRACE_MIN = 25;

const MINUTE = 60 * 1000;

export function defaultLifeState(now = Date.now()): LifeState {
  return { energy: 0.82, mood: 0.15, sleep: "awake", lastInteractionAt: 0, updatedAt: now };
}

/** 当地时间的"当天第几分钟" */
export function minuteOfDay(now: number): number {
  const d = new Date(now);
  return d.getHours() * 60 + d.getMinutes();
}

/** 现在是不是睡觉时段（跨午夜） */
export function isSleepWindow(now: number): boolean {
  const m = minuteOfDay(now);
  return m >= SLEEP_START_MIN || m < SLEEP_END_MIN;
}

/**
 * 推进状态。
 *
 * @param interacted 这段时间里用户有没有说话（有则掉精力更快、心情回一点）
 */
export function advanceLifeState(
  prev: LifeState,
  now: number,
  opts: { interacted?: boolean } = {},
): LifeState {
  // tick 可能重复或时钟被改：截断到 0~24h，绝不倒退
  const elapsedMin = Math.max(0, Math.min(24 * 60, (now - prev.updatedAt) / MINUTE));
  if (elapsedMin <= 0) {
    return { ...prev, sleep: stageFor(now), lastInteractionAt: opts.interacted ? now : prev.lastInteractionAt };
  }

  const sleeping = isSleepWindow(now);
  let energy = prev.energy;
  let mood = prev.mood;

  if (sleeping) {
    // 睡觉回精力，但回得慢（这是"她"在睡觉，不是充电）
    energy = Math.min(1, energy + elapsedMin * 0.008);
    mood += (0 - mood) * Math.min(1, elapsedMin * 0.004);
  } else {
    const drain = opts.interacted ? 0.012 : 0.0045;
    energy = Math.max(0.08, energy - elapsedMin * drain);
    // 心情慢慢回落到平静；互动会往上抬一点（见 noteInteraction）
    mood += (0 - mood) * Math.min(1, elapsedMin * 0.006);
  }

  const stage = stageFor(now);
  // 刚醒的一小段时间里精力打个折：听起来才是"刚爬起来"
  if (stage === "waking" && prev.sleep === "asleep") {
    energy = Math.min(energy, 0.55);
  }

  return {
    energy: clamp01(energy),
    mood: Math.max(-1, Math.min(1, mood)),
    sleep: stage,
    lastInteractionAt: opts.interacted ? now : prev.lastInteractionAt,
    updatedAt: now,
  };
}

/** 互动一下：心情往上抬一点，精力掉一点 */
export function noteInteraction(prev: LifeState, now = Date.now()): LifeState {
  return {
    ...prev,
    mood: Math.max(-1, Math.min(1, prev.mood + 0.05)),
    energy: Math.max(0.08, prev.energy - 0.01),
    lastInteractionAt: now,
    updatedAt: now,
  };
}

export function stageFor(now: number): SleepStage {
  if (isSleepWindow(now)) return "asleep";
  const m = minuteOfDay(now);
  if (m < SLEEP_END_MIN + WAKING_GRACE_MIN) return "waking";
  return "awake";
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * 把状态翻译成一句给模型看的中文（**不含数字**，避免它把"精力 62%"念出来）。
 *
 * 这段文字会进问候 prompt，让问候有由头：刚醒、犯困、忙累了、精神很好。
 */
export function lifeLine(state: LifeState, now = Date.now()): string {
  const parts: string[] = [];
  if (state.sleep === "asleep") {
    parts.push("你正在睡觉，如果被叫醒会是迷糊、短句、不想多说的状态");
  } else if (state.sleep === "waking") {
    parts.push("你刚睡醒不久，脑子还有点钝，说话偏短、偶尔走神");
  } else if (state.energy < 0.3) {
    parts.push("你有点累了，说话更懒、更容易敷衍或想找地方躺一下");
  } else if (state.energy > 0.75) {
    parts.push("你精神很好，语气轻快、愿意多说两句");
  } else {
    parts.push("你状态平常，不特别亢奋也不累");
  }

  // 注意：这里**不报心情**。心情由 affect.ts 的事件表统一负责（有原因、会衰减），
  // 两处各说一句会出现"情绪平稳 + 你现在正在生气"这种自相矛盾的上下文。

  const since = state.lastInteractionAt ? now - state.lastInteractionAt : 0;
  if (state.lastInteractionAt && since < 30 * MINUTE) parts.push("刚和主人说过话");
  else if (state.lastInteractionAt && since > 6 * 60 * MINUTE) parts.push("已经有一阵子没人理你了");

  return parts.join("；");
}
