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
  if (!planCache || planCache.day !== key) planCache = { day: key, plan: buildDayPlan(key) };
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
};
