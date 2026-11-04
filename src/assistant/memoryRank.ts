/**
 * 记忆召回排序（纯函数，可单测）。
 *
 * 原来的召回是"关键词子串命中"：memory.keywords 里存的是 2-gram 碎片，
 * 用户说「加班到三点」时，命中不了记忆里的「熬夜」——词不同但意思一样，召不回来。
 *
 * 这里做三件事：
 * 1. BM25：按词频 + 逆文档频率打分，常用碎片（「用户」「主人」）权重自动压到很低，
 *    真正有区分度的词（「熬夜」「论文」）权重高。比"命中一个关键词 +5"更讲道理。
 * 2. 近义扩展：中文没有空格，纯字面匹配永远漏；维护一张小规模近义词表，
 *    查询里出现「熬夜」时把「凌晨/晚睡/通宵」也当弱查询词加进来。
 * 3. 场景/重要度/最近使用：保留原来的加成逻辑，分数阈值不变。
 */

import { tokenize, textSimilarity } from "./memoryOps";

export interface RankableMemory {
  id: string;
  content: string;
  category: string;
  importance: number;
  lastUsedAt: number;
  createdAt: number;
  keywords?: string[];
}

export interface RecallContext {
  userText?: string;
  currentApp?: string;
  currentTitle?: string;
  timeOfDay?: string;
  now?: number;
}

export interface Ranked<T> {
  entry: T;
  score: number;
}

/**
 * 近义词表：只为"意思一样但字面不同"的场景兜底，不做语义推理。
 * 每组内部互相扩展，规模刻意保持很小（大表会引入误召回）。
 */
export const SYNONYM_GROUPS: string[][] = [
  ["熬夜", "晚睡", "通宵", "凌晨", "半夜", "夜班", "失眠"],
  ["加班", "上班", "工作", "改需求", "赶工", "项目"],
  ["猫", "猫咪", "宠物", "狗", "狗狗"],
  ["游戏", "打游戏", "开黑", "steam"],
  ["论文", "作业", "考试", "毕业", "课"],
  ["失恋", "分手", "恋情", "对象", "恋爱"],
  ["焦虑", "压力", "烦", "累", "emo", "心情不好"],
  ["开心", "高兴", "爽", "舒服"],
  ["咖啡", "喝茶", "饮料"],
  ["健身", "跑步", "运动", "锻炼"],
  ["代码", "编程", "bug", "调试", "开发"],
];

/**
 * 低信息量词：这些词在长句里几乎必然出现，却因为"只在一两条记忆里出现过"而拿到很高的
 * IDF（例如「最近」只出现在一条记忆里 → 权重虚高，把真正相关的记忆挤下去）。
 * 直接按文本过滤，比调整 BM25 参数可靠。
 */
export const STOPWORDS = new Set([
  "最近", "现在", "今天", "明天", "昨天", "刚才", "一下", "什么", "怎么", "这个", "那个",
  "我们", "你们", "他们", "可以", "还是", "就是", "但是", "因为", "所以", "如果", "然后",
  "已经", "真的", "感觉", "觉得", "有点", "非常", "特别", "一直", "总是", "经常", "帮我",
  "我的", "你的", "他的", "时候", "东西", "事情", "问题", "一个", "不了", "知道", "不是",
]);

/**
 * 查询扩展：原文 2-gram + 近义词表里的同组成员（去重、保持顺序）。
 * 近义词按**原词**返回（不拆成 2-gram）—— 像「猫」这种单字词，拆开就永远匹配不上
 * 记忆里的「橘猫」「养猫」，只能靠原词做子串命中。
 */
export function expandQuery(text: string): string[] {
  const out: string[] = [...tokenize(text)];
  const lower = (text || "").toLowerCase();
  for (const group of SYNONYM_GROUPS) {
    if (group.some((w) => lower.includes(w))) {
      out.push(...group);
    }
  }
  return [...new Set(out)];
}

/** BM25 打分（idf 夹到非负，避免高频词刷分） */
export function bm25(
  queryTokens: string[],
  docTokens: string[],
  df: Map<string, number>,
  docCount: number,
  avgDocLen: number,
  k1 = 1.4,
  b = 0.75,
): number {
  if (!queryTokens.length || !docTokens.length || docCount <= 0) return 0;
  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) || 0) + 1);
  let score = 0;
  const seen = new Set<string>();
  for (const q of queryTokens) {
    if (seen.has(q)) continue;
    seen.add(q);
    const f = tf.get(q);
    if (!f) continue;
    const n = df.get(q) || 0;
    const idf = Math.max(0, Math.log(1 + (docCount - n + 0.5) / (n + 0.5)));
    const denom = f + k1 * (1 - b + (b * docTokens.length) / (avgDocLen || 1));
    score += idf * ((f * (k1 + 1)) / (denom || 1));
  }
  return score;
}

/**
 * 召回入口：返回按分数降序、过阈值的前 limit 条。
 * 分数结构与改造前一致（重要度 / 最近使用 / 场景 / 用户话题 / 身份 / 时段），
 * 只是把"用户话题"这一项从子串命中换成了 BM25 + 近义扩展 + 2-gram 相似度。
 */
export function rankMemories<T extends RankableMemory>(
  memories: T[],
  ctx: RecallContext = {},
  opts: { limit?: number; minScore?: number } = {},
): Ranked<T>[] {
  const limit = opts.limit ?? 4;
  const minScore = opts.minScore ?? 5;
  if (!memories.length) return [];
  const now = ctx.now ?? Date.now();

  const docs = memories.map((m) => tokenize(`${m.content} ${(m.keywords ?? []).join(" ")}`));
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const t of new Set(doc)) df.set(t, (df.get(t) || 0) + 1);
  }
  const avgDocLen = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, docs.length);

  const userText = (ctx.userText ?? "").trim();
  const expanded = userText ? expandQuery(userText) : [];
  // BM25 用 2-gram；低信息量词直接剔掉，否则会靠虚高的 IDF 抢分
  const queryTokens = expanded.filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  // 子串命中用原词（含单字近义词），专治「猫」匹配「橘猫」这种拆 2-gram 就丢的case
  const surfaceTerms = expanded.filter((t) => t.length >= 1 && !STOPWORDS.has(t));
  const scene = `${ctx.currentApp ?? ""} ${ctx.currentTitle ?? ""} ${ctx.timeOfDay ?? ""}`.toLowerCase();

  const scored = memories.map((m, i) => {
    let score = 0;
    // 有没有"真的相关"的信号（BM25 命中 / 字面相似 / 场景命中）。
    // 光靠重要度 + 新鲜度就能过阈值的记忆，在聊别的事时被塞进 prompt 只是噪音 ——
    // 之前 2 条上限把它掩盖了，扩到 4 条就必须管：无关的琐碎记忆不召回，
    // 只有核心记忆（importance=1）允许无条件在场。
    let signal = false;
    // 重要度：1 核心 > 2 重要 > 3 琐碎
    score += (4 - m.importance) * 3;

    // 最近被用到过的记忆更容易再被用到（但衰减很慢，别让它一直霸榜）
    const daysSinceUsed = (now - m.lastUsedAt) / 86400000;
    score += Math.max(0, 3 - daysSinceUsed * 0.1);

    // 当前场景（前台软件/窗口标题/时段）里出现的关键词
    for (const kw of m.keywords ?? []) {
      if (kw && scene.includes(kw.toLowerCase())) {
        score += 5;
        signal = true;
      }
    }

    // 原词/近义词直接出现在记忆里：最可靠的一类命中
    if (userText) {
      const hay = `${m.content} ${(m.keywords ?? []).join(" ")}`.toLowerCase();
      let surfaceHits = 0;
      for (const term of surfaceTerms) {
        if (term.length === 1 && "的了是我你他她它不有在也就都还和与把被".includes(term)) continue;
        if (hay.includes(term.toLowerCase())) surfaceHits++;
      }
      if (surfaceHits > 0) {
        score += Math.min(9, surfaceHits * 3);
        signal = true;
      }
    }

    // 与本轮用户消息的相关度：BM25（含近义扩展）+ 2-gram 相似度兜底
    if (queryTokens.length) {
      const b = bm25(queryTokens, docs[i], df, memories.length, avgDocLen);
      if (b > 0.2) {
        score += Math.min(12, b * 3);
        signal = true;
      }
      const sim = textSimilarity(m.content, userText);
      if (sim >= 0.3) {
        score += 6 * Math.min(1, sim / 0.6);
        signal = true;
      }
    }

    // 作息/习惯类记忆在有时段信息时更有用
    if ((m.category === "schedule" || m.category === "habit") && ctx.timeOfDay) score += 2;
    if (m.category === "identity") score += 1;

    return { entry: m, score, signal };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored
    .filter((s) => s.score >= minScore && (s.signal || s.entry.importance === 1 || !userText))
    .slice(0, limit)
    .map(({ entry, score }) => ({ entry, score }));
}
