/**
 * 日记素材整理与提示词组装（纯函数，零依赖，可单测：tests/diary.test.js）。
 *
 * 思路：日记不该只是"事件清单的复述"。这里把一天的线索分成三块喂给模型：
 *   ① 时间线（常用软件 / 听歌 / 小游戏 / 提醒 / 摸头）——回答"主人今天在干嘛"
 *   ② 聊过的事（💬 摘要）——回答"我们之间发生了什么"
 *   ③ 上一篇的结尾——保持连续，不每天从零开始
 * 并要求模型先复盘再动笔，写得像日记而不是报表。
 */
import type { AppUsage, DiaryEvent, DiaryEventType, MusicTrack } from "./DiaryEventTracker";

export interface DigestInput {
  date?: string;
  persona?: string;
  nickname?: string;
  events: DiaryEvent[];
  apps?: AppUsage[];
  tracks?: MusicTrack[];
  previousTail?: string;
  /** 当天用户的几句原话（用来让日记"有出处"，而不是编） */
  quotes?: string[];
  /** 最近几篇日记的一句话摘要，避免每天重复同一个话题 */
  recent?: { date: string; summary: string }[];
}

/** 事件正文的字符预算（按整行截断，不会切一半） */
export const MAX_PROMPT_CHARS = 1500;
/** 最多列几条事件 */
export const MAX_PROMPT_EVENTS = 20;
/** 时间线里最多列几个软件 */
export const MAX_PROMPT_APPS = 6;

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

export function dateLabel(date?: string): string {
  if (!date) return "今天";
  const [, m, d] = date.split("-").map(Number);
  return `${m}月${d}日`;
}

export function weekdayLabel(date?: string): string {
  const [y, m, d] = (date ?? "").split("-").map(Number);
  const dt = y ? new Date(y, (m || 1) - 1, d || 1) : new Date();
  return `周${WEEK[dt.getDay()]}`;
}

/** 分钟数 → 人话 */
export function formatMinutes(min: number): string {
  const total = Math.max(0, Math.round(min));
  if (total < 60) return `${total} 分钟`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `约 ${h} 小时` : `约 ${h} 小时 ${m} 分`;
}

/** 常用软件 → "VS Code（约 2 小时）· 浏览器（40 分钟）" */
export function formatAppUsage(apps: AppUsage[] | undefined, limit = MAX_PROMPT_APPS): string {
  const list = (apps ?? []).filter(a => a.minutes > 0).slice(0, limit);
  if (list.length === 0) return "";
  return list.map(a => `${a.app}（${formatMinutes(a.minutes)}）`).join(" · ");
}

/** 听歌情况 → "8 首（共 12 次）：《a》《b》《c》…" */
export function formatMusic(tracks: MusicTrack[] | undefined): string {
  const list = tracks ?? [];
  if (list.length === 0) return "";
  const total = list.reduce((sum, t) => sum + t.count, 0);
  const names = list.slice(0, 3).map(t => `《${t.label}》`).join("");
  const more = list.length > 3 ? `…（还有 ${list.length - 3} 首）` : "";
  return `${list.length} 首（共 ${total} 次）：${names}${more}`;
}

const EVENT_PRIORITY: Record<DiaryEventType, number> = {
  chat: 0,
  reminder_done: 1,
  game: 2,
  greeting: 3,
  interaction: 4,
};

const EVENT_PREFIX: Record<DiaryEventType, string> = {
  chat: "💬",
  reminder_done: "✅",
  game: "🎮",
  greeting: "👋",
  interaction: "🖱️",
};

/** 事件按重要度排序（聊天最重要，摸头这类放最后） */
export function prepareEvents(events: DiaryEvent[]): DiaryEvent[] {
  return [...events].sort((a, b) => {
    const pa = EVENT_PRIORITY[a.type] ?? 99;
    const pb = EVENT_PRIORITY[b.type] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.timestamp - b.timestamp;
  });
}

/** 把事件整理成提示词里的几行（按整行吃字符预算，并报告真实总条数） */
export function buildEventDigest(events: DiaryEvent[]): { text: string; shown: number; dropped: number } {
  const prepared = prepareEvents(events);
  const lines: string[] = [];
  let used = 0;
  for (const e of prepared) {
    const line = `${EVENT_PREFIX[e.type]} ${e.summary}`;
    if (lines.length > 0 && (used + line.length + 1 > MAX_PROMPT_CHARS || lines.length >= MAX_PROMPT_EVENTS)) break;
    lines.push(line);
    used += line.length + 1;
  }
  return { text: lines.join("\n"), shown: lines.length, dropped: events.length - lines.length };
}

/** 一天的时间线（没有内容时返回空串，提示词里就不出现这一段） */
export function buildTimeline(input: DigestInput): string {
  const events = input.events ?? [];
  const lines: string[] = [];
  const apps = formatAppUsage(input.apps);
  if (apps) lines.push(`- 常用软件：${apps}`);
  const music = formatMusic(input.tracks);
  if (music) lines.push(`- 听歌：${music}`);
  const games = events.filter(e => e.type === "game").length;
  if (games > 0) lines.push(`- 小游戏：陪你玩了 ${games} 局`);
  const reminders = events.filter(e => e.type === "reminder_done").length;
  if (reminders > 0) lines.push(`- 完成提醒：${reminders} 件`);
  const chats = events.filter(e => e.type === "chat").length;
  if (chats > 0) lines.push(`- 聊天：${chats} 次`);
  const petting = events.find(e => e.type === "interaction");
  if (petting) lines.push(`- ${petting.summary}`);
  return lines.join("\n");
}

/**
 * 组装日记提示词。
 * 注意第 1 条要求：让模型**先复盘再动笔**——这是"由大模型思考撰写"的关键，
 * 又不用多花一次调用（省 token）。
 */
export function buildDiaryPrompt(input: DigestInput): string {
  const date = input.date;
  const digest = buildEventDigest(input.events ?? []);
  const timeline = buildTimeline(input);
  const droppedNote = digest.dropped > 0 ? `\n（另有 ${digest.dropped} 条零碎记录没有列出）` : "";
  const quotes = (input.quotes ?? []).map(q => q.trim()).filter(Boolean).slice(0, 3);
  // 素材很少的日子（没聊几句、没干什么）就别硬凑：硬凑出来的一定是编的
  const thin = !timeline && !digest.text && quotes.length === 0;

  const sections: string[] = [];
  sections.push(
    thin
      ? `请写一篇 ${dateLabel(date)}（${weekdayLabel(date)}）的短日记，80~150 字。`
      : `请写一篇 ${dateLabel(date)}（${weekdayLabel(date)}）的日记，200~350 字。`,
  );
  if (input.persona) sections.push(`人设风格：${input.persona}`);
  if (input.nickname) sections.push(`你对用户的称呼：${input.nickname}`);

  if (timeline) sections.push(`【今天的时间线】\n${timeline}`);
  if (digest.text) sections.push(`【我们聊过的事】\n${digest.text}${droppedNote}`);
  if (quotes.length) {
    sections.push(`【主人今天说过的原话】\n${quotes.map((q, i) => `${i + 1}. 「${q}」`).join("\n")}`);
  }
  if (input.recent?.length) {
    sections.push(`【最近几天写过什么（别重复这些话题）】\n${input.recent.map(r => `- ${r.date}：${r.summary}`).join("\n")}`);
  }
  if (input.previousTail) {
    sections.push(`【上一篇日记的结尾（可以自然衔接，但不要重复它的内容）】\n…${input.previousTail}`);
  }

  sections.push(
    [
      "【结构】动笔前先在心里把上面的线索过一遍：今天最值得记的是哪件事、我当时的感受是什么。然后分两段写，不要小标题：",
      "第一段写「今天真实发生了什么」——挑一两件具体的事，写清是什么时候、跟什么有关。",
      "第二段写「我自己的想法和感受」——你怎么看他这一天的状态，你当时是什么心情，有什么想说的或想不通的。",
      "",
      "【硬规则】",
      "1. 上面素材里没有的事，一个字都不许编。特别是不许编「他说了……」这种没出现过的对话。",
      "2. 第一段至少有一处具体锚点：一个时间、一个软件名、一句他的原话，或者一件明确发生的事。",
      "3. 可以推测他的状态和心情，但要用「感觉/好像/大概」这类词，别当成事实陈述。",
      "4. 素材很少就写短一点，写「今天很安静，他好像很忙」也完全可以，别为了凑字数瞎编。",
      "5. 不要罗列清单、不要用标题、不要提「数据/记录/统计/系统」这类词，也不要调用任何工具；只输出日记正文。",
    ].join("\n"),
  );

  return sections.join("\n\n");
}
