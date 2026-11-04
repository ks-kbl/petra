/**
 * 长期记忆的"增删改"操作层（纯函数，可单测）。
 *
 * 背景：原来提取器只会 push 新条目，去重靠 `content` 字符串全等。实际用起来会烂在三种情况：
 *   1. 同一件事换个说法说三遍 → 三条并存的"用户喜欢猫/主人养了只猫/用户的猫叫豆豆"；
 *   2. 事实变了（换了工作、猫送人了）→ 新旧同时存在，模型看到矛盾只能瞎猜；
 *   3. 用户明确纠正（"我不写小说了"）→ 旧结论永远留着，画像跟着歪。
 *
 * 所以改成：提取器看得到已有记忆的 id，直接输出 add / update / delete 操作；本地再兜一层
 * 近重复判定（相似度极高才自动合并）。
 *
 * 注意：这里的相似度阈值刻意定得很保守（0.9）。中文短句字面重叠天然很高
 * （"用户喜欢猫" vs "用户喜欢狗" 的 2-gram 余弦就有 0.75），阈值低会把不同的事实
 * 合并成一条 —— 那比重复更糟。真正需要"理解语义"的合并交给模型显式下 op。
 */

export interface MemoryLike {
  id: string;
  content: string;
  category: string;
  importance: number;
  keywords?: string[];
  createdAt: number;
  lastUsedAt: number;
  updatedAt?: number;
  source?: string;
}

export interface MemoryOp {
  op: "add" | "update" | "delete";
  /** update / delete 必填：要改的那条记忆的 id */
  id?: string;
  content?: string;
  category?: string;
  importance?: number;
}

/** 近重复自动合并阈值（只在 add 没有指定 id 时兜底用） */
export const NEAR_DUPLICATE = 0.9;

/** 按词切分：中文 2-gram + 英文/数字整词（不依赖分词库） */
export function tokenize(text: string): string[] {
  const t = (text || "").toLowerCase();
  const out: string[] = [];
  const eng = t.match(/[a-z0-9]{2,}/g);
  if (eng) out.push(...eng);
  const runs = t.match(/[\u4e00-\u9fff]+/g);
  if (runs) {
    for (const run of runs) {
      if (run.length === 1) {
        out.push(run);
        continue;
      }
      for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    }
  }
  return out;
}

/** 文本相似度（0~1，2-gram 余弦）。用于"这条是不是同一件事"的兜底判断 */
export function textSimilarity(a: string, b: string): number {
  const sa = (a || "").trim();
  const sb = (b || "").trim();
  if (!sa || !sb) return 0;
  if (sa === sb) return 1;
  const ta = tokenize(sa);
  const tb = tokenize(sb);
  if (!ta.length || !tb.length) return 0;
  const bag = new Map<string, number>();
  for (const t of ta) bag.set(t, (bag.get(t) || 0) + 1);
  let dot = 0;
  for (const t of tb) {
    const c = bag.get(t);
    if (c && c > 0) {
      dot += 1;
      bag.set(t, c - 1);
    }
  }
  return dot / Math.sqrt(ta.length * tb.length);
}

/**
 * 宽容解析提取器输出。认三种形状：
 *   {"ops":[...]} / 裸数组 [...] / ```json 包裹
 * 单条也兼容老格式 {content, category, importance}（自动当成 add）。
 * 解析不出来返回空数组 —— 调用方据此跳过本轮，绝不写坏数据。
 */
export function parseMemoryOps(text: string): MemoryOp[] {
  if (typeof text !== "string" || !text.trim()) return [];
  const cleaned = text.replace(/```json/gi, "```").split("```").join("\n");
  const startArr = cleaned.indexOf("[");
  const startObj = cleaned.indexOf("{");
  let raw: unknown = null;
  // 先试对象（{"ops": [...]}），再退回数组
  if (startObj >= 0) {
    const endObj = cleaned.lastIndexOf("}");
    if (endObj > startObj) {
      try {
        const obj = JSON.parse(cleaned.slice(startObj, endObj + 1)) as Record<string, unknown>;
        if (Array.isArray(obj.ops)) raw = obj.ops;
        else if (Array.isArray(obj.memories)) raw = obj.memories;
        else if (typeof obj.content === "string") raw = [obj];
      } catch { /* 往下试数组 */ }
    }
  }
  if (!raw && startArr >= 0) {
    const endArr = cleaned.lastIndexOf("]");
    if (endArr > startArr) {
      try {
        const arr = JSON.parse(cleaned.slice(startArr, endArr + 1));
        if (Array.isArray(arr)) raw = arr;
      } catch { /* 放弃 */ }
    }
  }
  if (!Array.isArray(raw)) return [];

  const ops: MemoryOp[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    if (!item || typeof item !== "object") continue;
    const content = typeof item.content === "string" ? item.content.trim() : "";
    const rawOp = typeof item.op === "string" ? item.op.toLowerCase().trim() : "";
    // 老格式没有 op 字段：当新增处理
    const op = rawOp === "update" || rawOp === "delete" || rawOp === "add" ? rawOp : "add";
    if (op !== "delete" && !content) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if ((op === "update" || op === "delete") && !id && !content) continue;
    const importance = Number(item.importance);
    ops.push({
      op,
      ...(id ? { id } : {}),
      ...(content ? { content } : {}),
      ...(typeof item.category === "string" && item.category.trim() ? { category: item.category.trim() } : {}),
      ...(Number.isFinite(importance) ? { importance: Math.min(3, Math.max(1, Math.round(importance))) } : {}),
    });
    if (ops.length >= 20) break; // 一次最多 20 条，防止模型抽风刷屏
  }
  return ops;
}

export interface ApplyMemoryResult<T> {
  memory: T[];
  added: number;
  updated: number;
  removed: number;
  /** 有没有任何改动（调用方据此决定要不要落盘 / 重算画像） */
  changed: boolean;
}

/**
 * 把操作流应用到记忆数组上，返回新数组（不改入参）。
 * - delete：按 id 删；没有 id 时按内容找最像的一条（≥0.85 才删，避免误删）
 * - update：按 id 改内容/类别；importance 取两者更重要的（数字更小）
 * - add：先按内容近重复（≥0.9）合并到已有条目，否则新增
 */
export function applyMemoryOps<T extends MemoryLike>(
  memory: T[],
  ops: MemoryOp[],
  opts: {
    now?: number;
    makeId?: () => string;
    keywordsOf?: (text: string) => string[];
    maxCount?: number;
    /** 新条目的来源标记：remember 工具记的是用户亲口说的，自动提取的是模型推断的 */
    source?: string;
  } = {},
): ApplyMemoryResult<T> {
  const now = opts.now ?? Date.now();
  const makeId = opts.makeId ?? (() => `mem_${now}_${Math.random().toString(36).slice(2, 8)}`);
  const keywordsOf = opts.keywordsOf ?? (() => []);
  const maxCount = opts.maxCount ?? 200;
  let out = [...memory];
  let added = 0, updated = 0, removed = 0;

  const findById = (id?: string): number => (id ? out.findIndex((m) => m.id === id) : -1);
  const findSimilar = (content: string, threshold: number): number => {
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < out.length; i++) {
      const s = textSimilarity(out[i].content, content);
      if (s >= threshold && s > bestScore) {
        best = i;
        bestScore = s;
      }
    }
    return best;
  };

  for (const op of ops) {
    if (op.op === "delete") {
      let idx = findById(op.id);
      // 没给 id / id 对不上（模型抄错了）：退回按内容找最像的一条
      if (idx < 0 && op.content) idx = findSimilar(op.content, 0.85);
      if (idx >= 0) {
        out.splice(idx, 1);
        removed++;
      }
      continue;
    }

    if (op.op === "update") {
      let idx = findById(op.id);
      if (idx < 0 && op.content) idx = findSimilar(op.content, 0.6);
      if (idx < 0) continue; // 要改的那条已经不存在了：宁可不做，也不凭空造一条
      const old = out[idx];
      const content = op.content || old.content;
      out[idx] = {
        ...old,
        content,
        category: op.category || old.category,
        importance: Math.min(old.importance, op.importance ?? old.importance),
        keywords: keywordsOf(content),
        updatedAt: now,
        lastUsedAt: now,
      } as T;
      updated++;
      continue;
    }

    // add
    const content = (op.content || "").trim();
    if (!content) continue;
    const dup = findSimilar(content, NEAR_DUPLICATE);
    if (dup >= 0) {
      // 同一件事换个说法又说了一遍：更新而不是再存一条
      const old = out[dup];
      out[dup] = {
        ...old,
        content,
        importance: Math.min(old.importance, op.importance ?? old.importance),
        keywords: keywordsOf(content),
        updatedAt: now,
        lastUsedAt: now,
      } as T;
      updated++;
      continue;
    }
    out.push({
      id: makeId(),
      content,
      category: (op.category || "other") as T["category"],
      importance: (op.importance ?? 2) as T["importance"],
      keywords: keywordsOf(content),
      createdAt: now,
      lastUsedAt: now,
      updatedAt: now,
      source: opts.source ?? "ai_inferred",
    } as unknown as T);
    added++;
  }

  // 超上限：先扔最琐碎的，同档再扔最久没引用的
  while (out.length > maxCount) {
    let victim = 0;
    for (let i = 1; i < out.length; i++) {
      const a = out[i], b = out[victim];
      if (a.importance > b.importance || (a.importance === b.importance && a.lastUsedAt < b.lastUsedAt)) victim = i;
    }
    out.splice(victim, 1);
  }

  return { memory: out, added, updated, removed, changed: added + updated + removed > 0 };
}

/** 给提取器看的"已有记忆清单"（id + 内容 + 类别 + 日期），让它能下 update/delete */
export function formatMemoryForExtractor(
  memory: MemoryLike[],
  limit = 60,
): string {
  if (!memory.length) return "（还没有任何记忆）";
  const sorted = [...memory]
    .sort((a, b) => a.importance - b.importance || b.lastUsedAt - a.lastUsedAt)
    .slice(0, limit);
  return sorted
    .map((m) => {
      const d = m.createdAt > 0 ? new Date(m.createdAt) : null;
      const date = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : "";
      return `- id=${m.id} [${m.category}|重要度${m.importance}${date ? "|" + date : ""}] ${m.content}`;
    })
    .join("\n");
}
