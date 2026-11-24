import type { MemoryEntry } from "./AssistantClient";
import { textSimilarity } from "./memoryOps";
import { rankMemories } from "./memoryRank";
import { evidenceScope, inMemoryScope, SESSION_ONLY, type MemoryScope } from "./memoryScope";

export type LongMemory = MemoryEntry & {
  status: "active" | "archived" | "superseded" | "completed";
  kind: "fact" | "preference" | "rule" | "topic";
  updatedAt: number;
  evidenceAt?: number;
  supersedes?: string;
  corrected?: boolean;
  relatedIds?: string[];
  scope?: MemoryScope;
};
export type Snapshot = { revision: number; dreamRevision: number; entries: LongMemory[] };
export type Evidence = { text: string; at: number; intent: "normal" | "remember" | "correction"; reference?: string; scope?: MemoryScope; excludedIds?: string[] };
export type Pending = { id: number; body: Evidence };
const categories = new Set(["identity", "preference", "habit", "schedule", "relationship", "event", "other"]);
const kinds = new Set(["fact", "preference", "rule", "topic"]);
const PRIVATE = /(?:\bapi[ _-]?key\b|\b(?:password|secret key|access token)\b|密码|口令|验证码|私钥|授权令牌|-----BEGIN |\bsk-[a-zA-Z0-9_-]{10,})/i;
const STYLE = /(?:文言文?|白话(?:文)?|古文|现代口语|文言句式)/;
const LONG_TERM = /(?:以后|今后|每次|一直|默认|长期|永久)/;
const TEMP_TASK = /(?:倒计时|计时器|设(?:个|置)?提醒|分钟后|秒钟后|小时后|定(?:个|时)闹钟)/;
export const safeEvidence = (text: string): boolean => !!text.trim() && !PRIVATE.test(text);
export function canQueueEvidence(text: string, intent: Evidence["intent"]): boolean {
  return safeEvidence(text) && text.length <= 4000 && (intent !== "normal" ||
    !/^(?:嗯+|哦+|啊+|哈+|好(?:的|吧|了)?|收到|知道了|谢谢|早安|晚安|拜拜)[。！？!?~～\s]*$/.test(text.trim()));
}

export function explicitMemory(text: string): { intent: "remember"; content: string; rule: boolean } | null {
  const t = text.trim();
  const m = /^(?:请你?|帮我|给我|你要)?(?:牢牢记住|记住|记下来|记一下)(?:[：:，,、\s]*)(.*)$/.exec(t);
  const rule = /^(?:以后|今后|从今往后)(?:都|就|请|默认|别|不要|不用|按|用|叫|优先)/.test(t);
  if (!m && !rule) return null;
  const raw = m ? m[1].trim() : t;
  const content = /^(?:(?:这|那)(?:个|件事|一点|条)|一下|我刚(?:刚|才)?说的(?:话|事)?)?[！!。？?吧]*$/.test(raw) ? "" : raw;
  return { intent: "remember", content, rule };
}

export function legacyMemories(active: unknown, archive: unknown, now = Date.now()): LongMemory[] {
  const result = new Map<string, LongMemory>();
  for (const [list, status] of [[archive, "archived"], [active, "active"]] as const) {
    if (!Array.isArray(list)) continue;
    list.forEach((item, i) => {
      const row = typeof item === "string" ? { content: item, source: "user_said" } : item;
      if (!row || typeof row.content !== "string" || !safeEvidence(row.content)) return;
      const id = typeof row.id === "string" && row.id.trim() ? row.id : `legacy_${status}_${i}`;
      const category = categories.has(row.category) ? row.category : "other";
      result.set(id, { id, category, content: row.content.trim(),
        keywords: Array.isArray(row.keywords) ? row.keywords.filter((k: unknown) => typeof k === "string") : [],
        source: row.source === "user_said" ? "user_said" : "ai_inferred",
        createdAt: Number(row.createdAt) || now, lastUsedAt: Number(row.lastUsedAt) || now,
        updatedAt: Number(row.updatedAt) || Number(row.createdAt) || now,
        importance: row.importance === 1 || row.importance === 3 ? row.importance : 2,
        kind: category === "preference" || category === "habit" || category === "identity" ? "preference" : "fact", status,
        scope: evidenceScope(row.content) });
    });
  }
  return [...result.values()];
}

export function recallLongMemory(entries: LongMemory[], query: string, stable: boolean, allowArchive = false, scope?: MemoryScope): LongMemory[] {
  const usable = entries.filter(e => e.scope !== SESSION_ONLY && inMemoryScope(e, scope) && (e.status === "active" || (allowArchive && e.status === "archived")));
  const ranked = query.trim() ? rankMemories(usable, { userText: query }, { limit: 4, minScore: 5, requireMatch: true }).map(x => x.entry) : [];
  const baseline = stable ? usable.filter(e => e.status === "active" && (e.kind === "rule" || (e.kind === "preference" && e.importance === 1)))
    .sort((a,b) => a.importance - b.importance || b.updatedAt - a.updatedAt).slice(0, 4) : [];
  const topTopic = ranked.find(e => e.kind === "topic" && e.status === "active");
  const related = topTopic?.relatedIds?.flatMap(id => {
    const e = usable.find(e => e.id === id && e.status === "active");
    return e ? [e] : [];
  }).slice(0, 2) ?? [];
  return [...new Map([...ranked, ...baseline, ...related].map(e => [e.id, e])).values()];
}

export function memoryCandidates(entries: LongMemory[], jobs: Pending[]): LongMemory[] {
  const usable = entries.filter(e => e.scope !== SESSION_ONLY && e.status !== "completed" && jobs.some(j => e.scope === j.body.scope));
  const query = jobs.map(j => [j.body.text, j.body.reference].filter(Boolean).join(" ")).join(" ");
  const hits = rankMemories(usable, { userText: query }, { limit: 18, minScore: 5, requireMatch: true }).map(x => x.entry);
  const recent = usable.slice().sort((a,b) => b.updatedAt - a.updatedAt).slice(0, 8);
  return [...new Map([...hits, ...recent].map(e => [e.id, e])).values()];
}

type Proposal = { op: "add" | "update" | "forget" | "complete"; id?: string; content?: string; kind?: string; category?: string; importance?: number; evidenceId: number; quote: string };
export function parseReflection(text: unknown): Proposal[] | null {
  if (typeof text !== "string") return null;
  try {
    const obj = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    if (!Array.isArray(obj?.ops)) return null;
    if (!obj.ops.every((p: Proposal) => p && ["add", "update", "forget", "complete"].includes(p.op) && Number.isSafeInteger(p.evidenceId) && typeof p.quote === "string")) return null;
    return obj.ops;
  } catch { return null; }
}

export function applyReflection(entries: LongMemory[], candidates: LongMemory[], jobs: Pending[], ops: Proposal[], now: number, makeId: () => string): LongMemory[] {
  const changed = new Map<string, LongMemory>();
  const allowed = new Set(candidates.map(e => e.id));
  const dispatch = new Map(jobs.map(j => [j.id, j.body]));
  for (const op of ops.slice().sort((a,b) => a.evidenceId - b.evidenceId)) {
    const evidence = dispatch.get(op.evidenceId);
    const quote = op.quote.trim();
    if (!evidence || evidence.scope === SESSION_ONLY || !quote || !evidence.text.includes(quote) || !safeEvidence(evidence.text)) continue;
    if (STYLE.test(evidence.text) && !LONG_TERM.test(evidence.text)) continue;
    const old = typeof op.id === "string" && allowed.has(op.id) ? changed.get(op.id) ?? entries.find(e => e.id === op.id) : undefined;
    const explicit = evidence.intent !== "normal";
    if (op.op !== "add" && (!old || old.scope !== evidence.scope || old.status === "superseded" || (old.evidenceAt ?? 0) > evidence.at)) continue;
    if (old && (old.corrected || old.source === "user_said") && !explicit) continue;
    if (op.op === "forget" || op.op === "complete") {
      if (!old || (op.op === "forget" && evidence.intent !== "correction") || (op.op === "complete" && old.kind !== "topic")) continue;
      changed.set(old.id, { ...old, status: op.op === "forget" ? "superseded" : "completed", updatedAt: now, evidenceAt: evidence.at, corrected: explicit });
      continue;
    }
    const content = typeof op.content === "string" ? op.content.trim() : "";
    if (!safeEvidence(content) || content.length > 380 || TEMP_TASK.test(content)) continue;
    const kind = (kinds.has(op.kind ?? "") ? op.kind : old?.kind ?? "fact") as LongMemory["kind"];
    const category = (categories.has(op.category ?? "") ? op.category : old?.category ?? "other") as MemoryEntry["category"];
    const all = [...entries.map(e => changed.get(e.id) ?? e), ...[...changed.values()].filter(e => !entries.some(v => v.id === e.id))].filter(e => e.scope === evidence.scope);
    if (op.op === "add" && all.some(e => (e.evidenceAt ?? 0) > evidence.at && (e.corrected || e.source === "user_said")
      && textSimilarity(e.content, content) >= 0.55)) continue;
    if (op.op === "add" && evidence.intent === "correction") continue;
    if (all.some(e => (e.status === "superseded" || e.status === "completed" || op.op === "add") && textSimilarity(e.content, content) >= 0.92)) continue;
    if (old) changed.set(old.id, { ...old, status: "superseded", updatedAt: now, evidenceAt: evidence.at, corrected: explicit });
    const id = makeId();
    changed.set(id, { id, content, kind, category, status: "active", keywords: [], createdAt: now, updatedAt: now,
      evidenceAt: evidence.at, lastUsedAt: now, importance: explicit || op.importance === 1 ? 1 : op.importance === 3 ? 3 : 2,
      source: explicit ? "user_said" : "ai_inferred", scope: evidence.scope, corrected: evidence.intent === "correction",
      ...(old ? { supersedes: old.id } : {}) });
  }
  return [...changed.values()];
}

/** 整理只合并同文同义的完全标准化副本，不用推断覆盖用户原话。 */
export function consolidateMemories(entries: LongMemory[], now: number): LongMemory[] {
  const canonical = (s: string) => s.normalize("NFKC").trim().replace(/[。！!？?]+$/u, "");
  const active = entries.filter(e => e.status === "active" && !e.corrected).sort((a,b) =>
    Number(b.source === "user_said") - Number(a.source === "user_said") || a.importance - b.importance || b.updatedAt - a.updatedAt);
  const seen = new Set(entries.filter(e => e.status === "active" && e.corrected).map(e => `${e.scope ?? ""}:${e.kind}:${canonical(e.content)}`));
  const duplicates = active.flatMap(e => {
    const key = `${e.scope ?? ""}:${e.kind}:${canonical(e.content)}`;
    if (seen.has(key) && e.source !== "user_said") return [{ ...e, status: "superseded" as const, updatedAt: now }];
    seen.add(key);
    return [];
  });
  const obsolete = new Set(duplicates.map(e => e.id));
  const facts = entries.filter(e => e.status === "active" && e.kind === "fact" && !obsolete.has(e.id));
  const topics = entries.filter(e => e.status === "active" && e.kind === "topic" && !obsolete.has(e.id));
  // 话题整理只建立相关事实的引用，不生成一份可能过时的事实副本。
  const groups = topics.flatMap(topic => {
    const relatedIds = rankMemories(facts.filter(e => e.scope === topic.scope), { userText: topic.content }, { limit: 4, minScore: 11, requireMatch: true })
      .filter(x => textSimilarity(x.entry.content, topic.content) >= 0.35).map(x => x.entry.id);
    return JSON.stringify(relatedIds) === JSON.stringify(topic.relatedIds ?? []) ? [] : [{ ...topic, relatedIds }];
  });
  return [...duplicates, ...groups];
}

/** 只根据本轮纠正与指代原文选择暂缓项；没有可靠指向就不猜。 */
export function correctionTargets(entries: LongMemory[], evidence: Evidence): string[] {
  const usable = entries.filter(e => e.scope === evidence.scope && (e.status === "active" || e.status === "archived"));
  const clean = (text: string) => text.replace(/(?:刚才那个不对|你记错了|那条不对|我说的是|忘掉|记错了|改成|不对|忘记|不是|项目)/g, " ").trim();
  const hints = [clean(evidence.text), clean(evidence.reference ?? "")].filter(t => t.length >= 2);
  return usable.filter(row => hints.some(hint => {
    const content = clean(row.content);
    const candidate = hint.replace(/[，。！？、:：\s]/g, "");
    return (candidate.length >= 2 && content.includes(candidate)) || textSimilarity(content, hint) >= 0.36;
  })).map(row => row.id);
}
