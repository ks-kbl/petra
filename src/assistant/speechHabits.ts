/**
 * 口头禅学习（纯函数，可单测）。
 *
 * 目标不是"模仿用户说话"，而是让称呼和语气词不再永远一个样：
 * 用户天天说「确实」「笑死」，你偶尔自然地接一句「确实」，比背口癖像人。
 *
 * 为什么用白名单而不是统计高频词：统计会捞出「这个」「然后」「就是」这类
 * 无意义的词，学进去反而更像 AI。这里只认一批明确带情绪/态度色彩的口语词条。
 */

/** 值得学的口语词条（都带态度色彩，学错也不会怪） */
const MARKERS = [
  "哈哈", "笑死", "确实", "行吧", "好家伙", "离谱", "绝了", "真的是",
  "说实话", "不是吧", "算了", "好吧", "哎呀", "嗯哼", "绷不住", "草",
  "有点东西", "怎么说呢", "离谱了点", "啊这", "绷", "乐",
];

/** 至少出现这么多次才算"这个人口头禅"，避免偶尔说一句就被学 */
const MIN_HITS = 3;
/** 最多学几条：多了会显得在模仿 */
const MAX_HABITS = 3;

/**
 * 从用户的原话里挑出口头禅。
 *
 * @param messages 用户说过的话（建议传最近 200 条以内）
 * @param prev 上一次学到的，用于保留还没被新样本覆盖的条目
 */
export function learnHabits(messages: string[], prev: string[] = []): string[] {
  const counts = new Map<string, number>();
  for (const raw of messages) {
    const text = (raw || "").trim();
    if (!text) continue;
    for (const m of MARKERS) {
      // 「哈哈」这类叠字：一次出现只算一次，避免一句"哈哈哈哈哈"刷满
      if (text.includes(m)) counts.set(m, (counts.get(m) ?? 0) + 1);
    }
  }
  const scored = [...counts.entries()]
    .filter(([, n]) => n >= MIN_HITS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_HABITS)
    .map(([m]) => m);
  // 新样本里没有的旧条目保留一半，避免偶发一次重算就把已有的全忘了
  for (const p of prev) {
    if (scored.length >= MAX_HABITS) break;
    if (!scored.includes(p)) scored.push(p);
  }
  return scored.slice(0, MAX_HABITS);
}

/** 给模型看的一句话；没有学到东西就返回空串 */
export function habitsLine(habits: string[]): string {
  const list = habits.filter(Boolean);
  if (!list.length) return "";
  return `主人平时爱说「${list.join("」「")}」。别刻意模仿、也别每句都用，偶尔自然带一个就行；学得不像反而更假。`;
}
