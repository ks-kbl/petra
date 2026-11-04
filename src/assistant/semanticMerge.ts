/**
 * 语义查重（纯函数，可单测）。
 *
 * 2-gram 相似度只能发现"几乎同一句话"，对「用户喜欢猫」和「主人养了只橘猫」这种
 * 换了说法的重复无能为力 —— 而那正是记忆里最常见的脏数据来源。
 *
 * 这里用服务端 embedding 做向量比对：
 * - 只用于**存记忆时合并**，不参与聊天时的召回打分，所以没有实时延迟；
 * - 拿不到 embedding（端点不支持 / 没网 / 没配 Key）就整条链路静默跳过，记忆照旧按 2-gram 去重；
 * - 阈值 0.9 依然很保守：宁可留两条，也不要把「喜欢猫」和「喜欢狗」并成一条。
 */

export interface EmbeddableMemory {
  id: string;
  content: string;
  importance: number;
  createdAt: number;
  lastUsedAt: number;
  keywords?: string[];
}

/** 记忆 id → 向量；h 是内容指纹，内容改了就要重算 */
export interface EmbeddingCache {
  [id: string]: { h: string; v: number[] };
}

/** 余弦相似度；长度不一致或零向量返回 0 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 内容指纹（djb2），只用来判断"这条记忆改过没有" */
export function contentHash(text: string): string {
  let h = 5381;
  const s = text || "";
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

export function normalizeEmbeddingCache(raw: unknown): EmbeddingCache {
  if (!raw || typeof raw !== "object") return {};
  const out: EmbeddingCache = {};
  for (const [id, val] of Object.entries(raw as Record<string, unknown>)) {
    const v = val as { h?: unknown; v?: unknown };
    if (!v || typeof v.h !== "string" || !Array.isArray(v.v)) continue;
    const vec = (v.v as unknown[]).map((x) => Number(x)).filter((x) => Number.isFinite(x));
    if (vec.length < 8) continue;
    out[id] = { h: v.h, v: vec };
  }
  return out;
}

/** 哪些记忆还需要算向量（新增的，或内容变过的） */
export function needsEmbedding(cache: EmbeddingCache, memory: EmbeddableMemory[]): EmbeddableMemory[] {
  return (memory || []).filter((m) => {
    if (!m || !m.content) return false;
    const hit = cache[m.id];
    return !hit || hit.h !== contentHash(m.content);
  });
}

export interface MergeResult<T> {
  memory: T[];
  merged: number;
  /** 被并掉的 id，调用方可以用来清理向量缓存 */
  removedIds: string[];
}

/**
 * 合并语义重复的记忆。
 * 保留谁：先看重要度（数字更小更重要），再看创建时间更早的那条（信息通常更"原始"）。
 * 合并时取更重要的 importance、更早的 createdAt、最近的 lastUsedAt。
 */
export function mergeSemanticDuplicates<T extends EmbeddableMemory>(
  memory: T[],
  cache: EmbeddingCache,
  threshold = 0.9,
): MergeResult<T> {
  const list = Array.isArray(memory) ? [...memory] : [];
  const removedIds: string[] = [];
  let merged = 0;

  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const va = cache[a.id]?.v;
    if (!va) continue;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      const vb = cache[b.id]?.v;
      if (!vb) continue;
      if (cosineSimilarity(va, vb) < threshold) continue;

      const aWins = a.importance < b.importance || (a.importance === b.importance && a.createdAt <= b.createdAt);
      const keep = aWins ? a : b;
      const drop = aWins ? b : a;
      const keeperIdx = aWins ? i : j;
      const mergedEntry: T = {
        ...keep,
        importance: Math.min(a.importance, b.importance) as T["importance"],
        createdAt: Math.min(a.createdAt, b.createdAt),
        lastUsedAt: Math.max(a.lastUsedAt, b.lastUsedAt),
        keywords: Array.from(new Set([...(a.keywords ?? []), ...(b.keywords ?? [])])).slice(0, 20),
      } as T;
      list[keeperIdx] = mergedEntry;
      removedIds.push(drop.id);
      list.splice(aWins ? j : i, 1);
      merged++;
      // 删掉一条后下标要回退，避免跳过后面的比较
      i = -1;
      break;
    }
  }

  // 被并掉的那条已经在 splice 里移除了，剩下的就是结果
  return { memory: list, merged, removedIds };
}
