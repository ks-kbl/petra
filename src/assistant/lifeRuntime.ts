/**
 * 生活状态的运行时外壳：把纯逻辑（lifeState / dayPlan / anniversary / gate）
 * 接到 localStorage 上，并给界面层一个「一段文字」的接口。
 *
 * 为什么集中在一个模块：这些状态要被三处同时读到——问候 prompt、控制面板快照、
 * 60 秒 tick。散着放最容易出现"两处各算一次、结果不一致"。
 * 所有对外暴露的都是**文字**，不暴露数值（项目准则：AI 的内部机制不摊给用户）。
 */

import {
  advanceLifeState, defaultLifeState, lifeLine, noteInteraction, stageFor, type LifeState,
} from "./lifeState";
import { buildDayPlan, dayKey, planForPrompt, type PlanItem } from "./dayPlan";
import { upcomingAnniversaries } from "./anniversary";
import { habitsLine, learnHabits } from "./speechHabits";
import { addLoop, loopLine, markAnswered, type PendingLoop } from "./openLoopReview";
import { evaluateGate, type GateResult } from "./proactiveGate";
import {
  addEvent, currentMood, isUpset, looksLikeApology, moodLine, pruneEvents, soften, insultStrength,
  type AffectEvent, type AffectKind,
} from "./affect";
import { applyAffect, decay, defaultFavor, favorLine, toneLine, type Favor } from "./favor";
import { detectTraits, type RoutineTrait } from "./personaRoutine";
import { addressLine, addressTier, deriveAddressForms, type AddressForms } from "./address";
import { deriveExpressionStyle, styleLine, type ExpressionStyle } from "./expressionStyle";
import { refusalLine, shouldRefuse } from "./refusal";

const STORE_KEY = "petra.life.v1";
/** 最近保留多少条用户原话用于学口头禅 */
const RECENT_USER_MAX = 200;

interface Deliveries {
  /** 当天日期键 */
  day: string;
  /** 当天已主动投递次数 */
  count: number;
  /** 上次投递时刻 */
  lastAt: number;
}

interface Persisted {
  state: LifeState;
  /** 第一次见到用户（首次启动）的时刻，用于纪念日 */
  firstMetAt: number;
  deliveries: Deliveries;
  loops: PendingLoop[];
  habits: string[];
  recentUser: string[];
  /** 情绪事件表（有原因、有半衰期） */
  affect: AffectEvent[];
  /** 长期好感度 */
  favor: Favor;
  /** 从人设识别出的生活特征 */
  traits: RoutineTrait[];
  /** 三档称呼（人设推导） */
  address: AddressForms;
  /** 生气时的表达型（人设推导） */
  style: ExpressionStyle;
  /** 拒绝执行记账：今天拒了几次、拒过哪些请求 */
  refusals: { day: string; count: number; keys: string[] };
}

let data: Persisted | null = null;
/** 同一天只重算一次节目单 */
let planCache: { day: string; plan: PlanItem[] } | null = null;

function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function fresh(now: number): Persisted {
  return {
    state: defaultLifeState(now),
    firstMetAt: now,
    deliveries: { day: dayKey(now), count: 0, lastAt: 0 },
    loops: [],
    habits: [],
    recentUser: [],
    affect: [],
    favor: defaultFavor(now),
    traits: [],
    address: { close: "你", neutral: "你", cold: "喂" },
    style: "sarcastic",
    refusals: { day: dayKey(now), count: 0, keys: [] },
  };
}

/** 读盘；损坏就重建（宁可丢状态，也不能让启动崩掉） */
export function load(now = Date.now()): Persisted {
  if (data) return data;
  const s = storage();
  if (s) {
    try {
      const raw = s.getItem(STORE_KEY);
      if (raw) {
        const j = JSON.parse(raw) as Partial<Persisted>;
        const base = fresh(now);
        data = {
          state: { ...base.state, ...(j.state ?? {}) },
          firstMetAt: Number(j.firstMetAt) || now,
          deliveries: { ...base.deliveries, ...(j.deliveries ?? {}) },
          loops: Array.isArray(j.loops) ? (j.loops as PendingLoop[]).slice(-6) : [],
          habits: Array.isArray(j.habits) ? (j.habits as string[]).slice(0, 3) : [],
          recentUser: Array.isArray(j.recentUser) ? (j.recentUser as string[]).slice(-RECENT_USER_MAX) : [],
          affect: Array.isArray(j.affect) ? (j.affect as AffectEvent[]).slice(-8) : [],
          favor: j.favor && typeof j.favor.score === "number" ? (j.favor as Favor) : base.favor,
          traits: Array.isArray(j.traits) ? (j.traits as RoutineTrait[]) : [],
          address: (j.address as AddressForms) ?? base.address,
          style: (j.style as ExpressionStyle) ?? base.style,
          refusals: { ...base.refusals, ...(j.refusals ?? {}) },
        };
        return data;
      }
    } catch { /* 读坏了就重建 */ }
  }
  data = fresh(now);
  return data;
}

function save(): void {
  const s = storage();
  if (!s || !data) return;
  try { s.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* 配额满了就算了 */ }
}

/** 60 秒 tick 调用：推进状态、跨天清零额度 */
export function tick(now = Date.now()): void {
  const d = load(now);
  d.state = advanceLifeState(d.state, now);
  d.affect = pruneEvents(d.affect, now);
  d.favor = decay(d.favor, now);
  const today = dayKey(now);
  if (d.deliveries.day !== today) {
    d.deliveries = { day: today, count: 0, lastAt: d.deliveries.lastAt };
  }
  save();
}

/** 用户说了一句话：涨心情、掉精力、记原话、复核话头 */
export function noteUserMessage(text: string, now = Date.now()): void {
  const d = load(now);
  d.state = noteInteraction(d.state, now);
  const t = (text || "").trim();
  if (t) {
    d.recentUser.push(t.slice(0, 200));
    if (d.recentUser.length > RECENT_USER_MAX) d.recentUser = d.recentUser.slice(-RECENT_USER_MAX);
    d.habits = learnHabits(d.recentUser, d.habits);
  }
  d.loops = markAnswered(d.loops, now);
  // 道歉/哄人：负面情绪的半衰期打折（心软），好感小涨
  if (looksLikeApology(t)) {
    d.affect = soften(d.affect, 0.5);
    d.favor = applyAffect(d.favor, 0.3, now);
  }
  // 可能伤人的话：先按启发式记一条，强度低的会在下一轮被自己冲淡；
  // **半衰期由人设定**（懒散/爱吃的人设心软得快，其它人设记久一点）
  const hurt = insultStrength(t);
  if (hurt > 0) {
    const soft = d.traits.includes("lazy") || d.traits.includes("food");
    d.affect = addEvent(d.affect, {
      id: `${now}:${t.slice(0, 10)}`,
      kind: hurt >= 0.6 ? "hurt" : "annoyed",
      reason: t.slice(0, 40),
      intensity: -hurt,
      startedAt: now,
      halfLifeMin: hurt >= 0.6 ? (soft ? 70 : 150) : 40,
    }, now);
    d.favor = applyAffect(d.favor, -hurt * 0.5, now);
  }
  save();
}

/** 由人设推导生活特征（换人设会重算，并清掉当天的节目单缓存） */
export function setPersona(persona: string, now = Date.now()): void {
  const d = load(now);
  const traits = detectTraits(persona);
  const address = deriveAddressForms(persona);
  const style = deriveExpressionStyle(persona);
  const sameTraits = traits.join(",") === d.traits.join(",");
  const sameAddr = address.close === d.address.close && address.cold === d.address.cold;
  if (sameTraits && sameAddr && style === d.style) return;
  d.traits = traits;
  d.address = address;
  d.style = style;
  planCache = null;
  save();
}

/**
 * 生气时"不干活"：返回要说的拒绝台词；不拒绝返回 null。
 *
 * 所有边界都在 refusal.ts 里（只拒社交请求、第二次必做、每天最多 2 次、
 * 安全词立刻照做），这里只负责取状态、掷骰子、记账。
 */
export function maybeRefuse(text: string, now = Date.now()): string | null {
  const d = load(now);
  if (d.refusals.day !== dayKey(now)) d.refusals = { day: dayKey(now), count: 0, keys: [] };
  const key = (text || "").trim().slice(0, 40);
  const same = d.refusals.keys.filter((k) => k === key).length;
  const decision = shouldRefuse({
    text,
    mood: currentMood(d.affect, now).value,
    refusedToday: d.refusals.count,
    sameRequestRefused: same,
    roll: Math.random(),
  });
  if (!decision.refuse) return null;
  d.refusals.count += 1;
  d.refusals.keys = [...d.refusals.keys, key].slice(-10);
  save();
  return refusalLine(d.style, decision.reason ?? "还在气头上");
}

/** 记一条模型判断出来的情绪（半衰期由模型给，界面不暴露） */
export function recordAffect(
  kind: AffectKind,
  reason: string,
  intensity: number,
  halfLifeMin: number,
  now = Date.now(),
): void {
  const d = load(now);
  d.affect = addEvent(d.affect, {
    id: `${now}:${reason.slice(0, 10)}`,
    kind,
    reason: reason.slice(0, 40),
    intensity: Math.max(-1, Math.min(1, intensity)),
    startedAt: now,
    halfLifeMin: Math.max(5, Math.min(1440, halfLifeMin)),
  }, now);
  d.favor = applyAffect(d.favor, intensity, now);
  save();
}

/** 主动问候发出去了：记额度、记时间；如果以问句结尾，登记成待复核话头 */
export function markDelivered(text: string, now = Date.now()): void {
  const d = load(now);
  if (d.deliveries.day !== dayKey(now)) d.deliveries = { day: dayKey(now), count: 0, lastAt: 0 };
  d.deliveries.count += 1;
  d.deliveries.lastAt = now;
  d.loops = addLoop(d.loops, text, now);
  save();
}

/** 主动消息的闸门：把运行时状态塞进纯函数 */
export function gate(
  now: number,
  cfg: { dailyLimit: number; cooldownMs: number; userBusy: boolean; idleSeconds: number; idleMode: boolean },
): GateResult {
  const d = load(now);
  return evaluateGate({
    now,
    lastDeliveryAt: d.deliveries.lastAt,
    deliveredToday: d.deliveries.day === dayKey(now) ? d.deliveries.count : 0,
    dailyLimit: cfg.dailyLimit,
    cooldownMs: cfg.cooldownMs,
    userBusy: cfg.userBusy,
    idleSeconds: cfg.idleSeconds,
    idleMode: cfg.idleMode,
  });
}

/** 当天的节目单（按日期缓存） */
export function plan(now = Date.now()): PlanItem[] {
  const key = dayKey(now);
  if (!planCache || planCache.day !== key) planCache = { day: key, plan: buildDayPlan(key, load(now).traits) };
  return planCache.plan;
}

/**
 * 给模型看的「生活上下文」：状态 + 在做什么 + 纪念日 + 话头 + 口头禅。
 * 全部为空时返回空串（调用方据此不加任何东西）。
 */
export function promptBlock(now = Date.now()): string {
  const d = load(now);
  const parts: string[] = [];
  const life = lifeLine({ ...d.state, sleep: stageFor(now) }, now);
  if (life) parts.push(`【你现在的状态】${life}`);
  const mood = moodLine(d.affect, now);
  if (mood) parts.push(`【你的情绪】${mood}`);
  const moodValue = currentMood(d.affect, now).value;
  const tier = addressTier(moodValue, d.favor.score);
  parts.push(`【称呼】${addressLine(tier, d.address).replace(/^称呼：/, "")}`);
  if (moodValue < -0.2) parts.push(`【生气的样子】${styleLine(d.style)}`);
  const tone = toneLine(d.favor, moodValue);
  if (tone) parts.push(`【语气】${tone}`);
  const fav = favorLine(d.favor);
  if (fav) parts.push(`【关系】${fav}`);
  const p = planForPrompt(plan(now), now);
  if (p) parts.push(`【你今天在做的事】\n${p}`);
  const ann = upcomingAnniversaries(d.firstMetAt, now, 7);
  if (ann.length) {
    const today = ann.find((a) => a.daysUntil === 0);
    parts.push(today ? `【今天是个特别的日子】${today.line}` : `【快到的日子】${ann[0].line}`);
  }
  const loops = loopLine(d.loops, now);
  if (loops) parts.push(`【话头】${loops}`);
  const habits = habitsLine(d.habits);
  if (habits) parts.push(`【说话习惯】${habits}`);
  return parts.join("\n\n");
}

/** 控制面板/调试用快照：只有文字，没有数字 */
export function snapshot(now = Date.now()): Record<string, string> {
  const d = load(now);
  return {
    状态: lifeLine({ ...d.state, sleep: stageFor(now) }, now),
    在做: planForPrompt(plan(now), now) || "（今天没有安排）",
    今天已问候: String(d.deliveries.day === dayKey(now) ? d.deliveries.count : 0),
    口头禅: d.habits.join("、") || "（还没学到）",
  };
}

/** 测试/重载用：清掉内存缓存（不动 localStorage） */
export function _resetForTest(): void {
  data = null;
  planCache = null;
}

/**
 * 给界面层用的单例门面。
 *
 * 模块里那些函数是纯的/带缓存的，界面层不想关心缓存，也不想为了一个 tick
 * 引入八个 import，所以统一从这里进。
 */
export const lifeRuntime = {
  tick,
  load,
  plan,
  gate,
  promptBlock,
  snapshot,
  markDelivered,
  noteUserMessage,
  setPersona,
  maybeRefuse,
  recordAffect,
  /** 当前心情值（-1~1），只给内部过滤用，不进 UI */
  promptMood: (now = Date.now()) => currentMood(load(now).affect, now).value,
  /** 正在气头上：问候要走"短、冲、不主动开新话题"分支 */
  upset: (now = Date.now()) => isUpset(load(now).affect, now),
};
