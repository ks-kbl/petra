/**
 * 日记的情绪标签与一周情绪曲线（纯函数，可单测）。
 *
 * 两个用途：
 * 1. 每篇日记带一个情绪标签，攒一周就能看出"她这周心情怎么样"；
 * 2. 问候/对话里可以说一句「这周你好像一直很累」——这是"她真的在看着你"的体感，
 *    比每天重复"今天过得怎么样"强得多。
 *
 * 判定用规则（关键词 + 权重），不额外调模型：日记一天一篇，规则足够稳，还零成本。
 */

export type DiaryMood = "happy" | "calm" | "tired" | "down" | "angry";

const MOOD_WORDS: { mood: DiaryMood; re: RegExp; weight: number }[] = [
  { mood: "happy", re: /(开心|高兴|笑|有趣|好玩|顺利|惊喜|满足|舒服|喜欢)/, weight: 2 },
  { mood: "tired", re: /(累|困|疲惫|熬|加班|忙到|忙了|没睡好|乏力|撑不住)/, weight: 2 },
  { mood: "down", re: /(难过|失落|低落|沮丧|烦|郁闷|没精神|不想动|空落落)/, weight: 2 },
  { mood: "angry", re: /(生气|火大|气死|烦死|讨厌|吵架|不爽)/, weight: 2 },
  { mood: "calm", re: /(安静|平静|普通|照常|平平淡淡|没什么特别)/, weight: 1 },
];

/** 从正文判断这篇日记的情绪（默认平静） */
export function diaryMoodOf(content: string): { mood: DiaryMood; score: number } {
  const text = content || "";
  const scores = new Map<DiaryMood, number>();
  for (const w of MOOD_WORDS) {
    const hits = (text.match(new RegExp(w.re.source, "g")) || []).length;
    if (hits > 0) scores.set(w.mood, (scores.get(w.mood) ?? 0) + hits * w.weight);
  }
  if (!scores.size) return { mood: "calm", score: 0 };
  let best: DiaryMood = "calm";
  let bestScore = 0;
  for (const [m, s] of scores) {
    if (s > bestScore) { best = m; bestScore = s; }
  }
  return { mood: best, score: bestScore };
}

const MOOD_LABEL: Record<DiaryMood, string> = {
  happy: "挺开心", calm: "比较平静", tired: "很累", down: "有点低落", angry: "有点火大",
};

/**
 * 一周情绪小结（没有足够数据时返回空串，调用方据此不加任何东西）。
 *
 * @param entries 最近若干篇日记（date + mood）
 */
export function weeklyMoodSummary(
  entries: { date: string; mood?: DiaryMood }[],
  now = Date.now(),
): string {
  const day = 24 * 60 * 60 * 1000;
  const recent = entries.filter((e) => {
    const t = Date.parse(`${e.date}T00:00:00`);
    return Number.isFinite(t) && now - t <= 7 * day && e.mood;
  });
  if (recent.length < 3) return ""; // 样本太少不说，免得瞎判断
  const counts = new Map<DiaryMood, number>();
  for (const e of recent) counts.set(e.mood as DiaryMood, (counts.get(e.mood as DiaryMood) ?? 0) + 1);
  let top: DiaryMood = "calm";
  let topCount = 0;
  for (const [m, c] of counts) if (c > topCount) { top = m; topCount = c; }

  // 一半以上是同一种情绪才下结论，否则只说"起伏挺大"
  if (topCount * 2 >= recent.length) {
    if (top === "calm") return `这 ${recent.length} 天里你大多比较平静。`;
    return `最近 ${recent.length} 天你${MOOD_LABEL[top]}（${topCount} 天都是这样）。`;
  }
  return `最近 ${recent.length} 天你的状态起伏挺大，几种情绪都出现过。`;
}
