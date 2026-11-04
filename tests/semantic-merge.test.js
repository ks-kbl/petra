/**
 * 语义查重测试：
 * - 余弦相似度计算正确（含退化情况）
 * - 只给"新增/内容变过"的记忆算向量
 * - 相似度够高才合并；不同事实绝不能并
 * - 合并时保留更重要 / 更早的那条，并合并且 keywords
 */
const sm = require("./build/assistant/semanticMerge.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

// ---------- 余弦 ----------
check("同向量 = 1", Math.abs(sm.cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
check("正交 = 0", sm.cosineSimilarity([1, 0], [0, 1]) === 0);
check("反向 = -1", Math.abs(sm.cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-9);
check("长度不同返回 0", sm.cosineSimilarity([1, 2], [1, 2, 3]) === 0);
check("零向量返回 0", sm.cosineSimilarity([0, 0], [1, 2]) === 0);
check("空数组返回 0", sm.cosineSimilarity([], []) === 0);

// ---------- 指纹 ----------
check("同内容指纹相同", sm.contentHash("用户喜欢猫") === sm.contentHash("用户喜欢猫"));
check("不同内容指纹不同", sm.contentHash("用户喜欢猫") !== sm.contentHash("用户喜欢狗"));
check("空内容不炸", typeof sm.contentHash("") === "string");

// ---------- 缓存归一 ----------
const cache = sm.normalizeEmbeddingCache({
  a: { h: "x", v: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] },
  bad: { h: 1, v: "nope" },
  short: { h: "y", v: [0.1] },
});
check("保留合法向量", !!cache.a && cache.a.v.length === 8);
check("丢弃脏数据", !cache.bad && !cache.short);
check("非对象返回空", Object.keys(sm.normalizeEmbeddingCache(null)).length === 0);

// ---------- 需要算哪些 ----------
const mem = [
  { id: "m1", content: "用户喜欢猫", importance: 2, createdAt: 1, lastUsedAt: 1 },
  { id: "m2", content: "用户喜欢狗", importance: 2, createdAt: 2, lastUsedAt: 2 },
];
const need = sm.needsEmbedding({ m1: { h: sm.contentHash("用户喜欢猫"), v: [1, 1, 1, 1, 1, 1, 1, 1] } }, mem);
check("只算缺的和变过的", need.length === 1 && need[0].id === "m2");
check("内容改了要重算", sm.needsEmbedding({ m1: { h: "old", v: [1, 1, 1, 1, 1, 1, 1, 1] } }, mem).some((m) => m.id === "m1"));

// ---------- 合并 ----------
const near = (v) => v; // 占位，语义靠下面的向量构造
const vec = (n) => {
  const out = new Array(8).fill(0);
  out[n] = 1;
  return out;
};
const dupMem = [
  { id: "a", content: "用户喜欢猫", importance: 2, createdAt: 10, lastUsedAt: 20, keywords: ["猫"] },
  { id: "b", content: "主人养了只橘猫", importance: 2, createdAt: 30, lastUsedAt: 40, keywords: ["橘猫"] },
  { id: "c", content: "用户喜欢狗", importance: 2, createdAt: 50, lastUsedAt: 60, keywords: ["狗"] },
];
const dupCache = { a: { h: "x", v: vec(0) }, b: { h: "y", v: vec(0) }, c: { h: "z", v: vec(3) } };
const merged = sm.mergeSemanticDuplicates(dupMem, dupCache, 0.9);
check("合并掉一条", merged.merged === 1 && merged.memory.length === 2);
check("保留更早创建的那条", merged.memory.some((m) => m.id === "a"));
check("不同事实不会被并", merged.memory.some((m) => m.id === "c"));
check("记录被并掉的 id", merged.removedIds.join() === "b");
const kept = merged.memory.find((m) => m.id === "a");
check("合并 keywords", kept.keywords.sort().join() === "橘猫,猫");
check("合并取最近使用时间", kept.lastUsedAt === 40);

const weaker = sm.mergeSemanticDuplicates(
  [
    { id: "x", content: "琐碎", importance: 3, createdAt: 10, lastUsedAt: 10 },
    { id: "y", content: "重要", importance: 1, createdAt: 99, lastUsedAt: 99 },
  ],
  { x: { h: "x", v: vec(0) }, y: { h: "y", v: vec(0) } },
  0.9,
);
check("重要度高的胜出", weaker.memory.length === 1 && weaker.memory[0].importance === 1);
check("胜出条目保留更早创建时间", weaker.memory[0].createdAt === 10);

check("没有向量就不合并", sm.mergeSemanticDuplicates(dupMem, {}, 0.9).merged === 0);
check("低相似度不合并", sm.mergeSemanticDuplicates(dupMem, { a: { h: "x", v: vec(0) }, b: { h: "y", v: vec(5) } }, 0.9).merged === 0);
check("空列表不炸", sm.mergeSemanticDuplicates([], {}, 0.9).merged === 0);

console.log("semantic-merge: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
