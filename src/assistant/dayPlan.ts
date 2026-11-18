/**
 * 角色自己的「今日节目单」（纯函数，可单测）。
 *
 * 用途不是给用户看日程表，而是**给问候和闲聊一个由头**：
 * 她今天在看书、在收拾屋子、傍晚想去买点吃的——问候才有话题，
 * 而不是只会问"吃了吗"。节目单每天按日期确定性生成，同一台机器同一天永远一样，
 * 不需要联网、不需要额外模型调用，也不进任何用户可见的配置项。
 */

import { NEUTRAL_FRAGMENTS, TRAIT_FRAGMENTS, type RoutineTrait } from "./personaRoutine";

export interface PlanItem {
  /** 当天的分钟数（例如 8:30 → 510） */
  at: number;
  /** 一句话标题，例如「把昨天没看完的书接着看」 */
  title: string;
  /** 带状态的补充，例如「已经看了一个多小时，正想歇会儿」 */
  line: string;
}

interface Slot {
  at: number;
  pool: { title: string; line: string }[];
}

/** 固定的生活时段；每个时段从候选池里按日期挑一条 */
const SLOTS: Slot[] = [
  { at: 8 * 60 + 30, pool: [
    { title: "煮了杯咖啡，坐在窗边发呆", line: "刚醒透，脑子还在慢慢转" },
    { title: "把窗帘拉开晒太阳", line: "阳光很好，心情也跟着松了一点" },
    { title: "边吃早饭边刷手机", line: "没什么正事，就是赖一会儿" },
  ] },
  { at: 11 * 60 + 40, pool: [
    { title: "在收拾屋子", line: "桌子上堆了几天没整理" },
    { title: "去楼下买了点吃的", line: "顺便走了两圈，风挺舒服" },
    { title: "在厨房折腾午饭", line: "煮了面，加了个蛋" },
  ] },
  { at: 14 * 60 + 10, pool: [
    { title: "在看一本旧书", line: "看到一半，正想找人说说" },
    { title: "在补昨晚没看完的剧", line: "有点困，但还是想再看一集" },
    { title: "趴在桌上小憩了一会儿", line: "刚醒，还有点没回神" },
  ] },
  { at: 16 * 60 + 30, pool: [
    { title: "在整理旧照片", line: "翻到一些很久以前的画面" },
    { title: "听着歌发呆", line: "循环同一首，懒得换" },
    { title: "在写点东西", line: "写了两句又删掉，没想好" },
  ] },
  { at: 19 * 60 + 20, pool: [
    { title: "在准备晚饭", line: "今天想吃点热的" },
    { title: "出门散步", line: "天已经黑了，路灯刚亮" },
    { title: "窝在沙发上不想动", line: "吃完就想瘫着" },
  ] },
  { at: 21 * 60 + 40, pool: [
    { title: "在洗漱准备睡了", line: "有点困，眼睛快睁不开" },
    { title: "在翻明天要做的事", line: "没什么特别想干的" },
    { title: "在听很轻的音乐", line: "把灯关了一半" },
  ] },
];

/** 稳定哈希：同一日期永远挑到同一条 */
function hash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** 当天日期键，形如 2026-11-18（本地时区） */
export function dayKey(d: Date | number = new Date()): string {
  const t = typeof d === "number" ? new Date(d) : d;
  const m = String(t.getMonth() + 1).padStart(2, "0");
  const day = String(t.getDate()).padStart(2, "0");
  return `${t.getFullYear()}-${m}-${day}`;
}

/**
 * 生成某一天的节目单：每个时段按日期哈希各挑一条。
 *
 * @param traits 人设特征（见 personaRoutine.detectTraits）。传了就把该特征的
 *               生活片段并进候选池——大肥鱼会躺床吃零食，健身人设会去跑步，
 *               同一套机制长在谁身上就过谁的日子。不传则用中性池。
 */
export function buildDayPlan(dateKey: string, traits: RoutineTrait[] = []): PlanItem[] {
  const traitFragments = traits.flatMap((t) => TRAIT_FRAGMENTS[t] ?? []);
  return SLOTS.map((slot, i) => {
    const base = slot.pool.length ? slot.pool : NEUTRAL_FRAGMENTS;
    // 有特征时，池子里一半是"这个人"的片段，一半是通用的日常
    const pool = traitFragments.length
      ? [...traitFragments, ...base]
      : [...base, ...NEUTRAL_FRAGMENTS];
    const pick = pool[hash(`${dateKey}#${i}`) % pool.length];
    return { at: slot.at, title: pick.title, line: pick.line };
  });
}

/** 当前正在做的安排；还没到第一条时返回 null */
export function currentItem(plan: PlanItem[], now: number): PlanItem | null {
  const m = new Date(now).getHours() * 60 + new Date(now).getMinutes();
  let cur: PlanItem | null = null;
  for (const it of plan) if (it.at <= m) cur = it;
  return cur;
}

/** 下一条安排（今天已经没有就返回 null） */
export function nextItem(plan: PlanItem[], now: number): PlanItem | null {
  const m = new Date(now).getHours() * 60 + new Date(now).getMinutes();
  return plan.find((it) => it.at > m) ?? null;
}

function fmt(at: number): string {
  return `${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`;
}

/**
 * 给模型看的一段话。
 *
 * 特意只给「正在做」和「接下来」，不给全天表：给全套模型会忍不住挨个念，
 * 变成流水账（这正是要避免的）。
 */
export function planForPrompt(plan: PlanItem[], now: number): string {
  const cur = currentItem(plan, now);
  const next = nextItem(plan, now);
  if (!cur && !next) return "";
  const lines: string[] = [];
  // 用「你在做：X」而不是「你在X」——模板标题是整句（"煮了杯咖啡，坐在窗边发呆"），
  // 直接拼会变成"你在煮了杯咖啡"，读起来像翻译腔。
  if (cur) lines.push(`现在（${fmt(cur.at)} 之后）你在做：${cur.title}——${cur.line}`);
  if (next) lines.push(`接下来（${fmt(next.at)}）你打算：${next.title}`);
  return lines.join("\n");
}
