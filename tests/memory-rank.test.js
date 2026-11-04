/**
 * 记忆召回排序测试：
 * - BM25 + 近义扩展：说"熬夜"能召回"凌晨才睡"，说"加班"能召回"赶项目"
 * - 无关的琐碎记忆不再因为"新鲜"被塞进 prompt（扩到 4 条后必须管）
 * - 核心记忆（importance=1）允许无条件在场
 */
const mr = require("./build/assistant/memoryRank.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

const now = new Date(2026, 10, 4, 12, 0).getTime();
const mk = (id, content, category, importance, extra = {}) => ({
  id, content, category, importance,
  createdAt: now - 86400000 * 3, lastUsedAt: now - 86400000, keywords: [], ...extra,
});

const mem = [
  mk("m1", "用户经常凌晨两三点才睡", "habit", 2),
  mk("m2", "用户喜欢猫，家里养了只橘猫", "preference", 2),
  mk("m3", "用户在做一个后端项目，最近总赶工", "event", 2),
  mk("m4", "用户讨厌别人问他工作细节", "preference", 1),
  mk("m5", "用户喜欢喝冰美式", "preference", 3),
];

// ---------- 近义扩展 ----------
const q1 = mr.expandQuery("我最近总熬夜");
check("查询扩展加入近义词", q1.some((t) => t.includes("凌晨") || t === "凌晨"));

const r1 = mr.rankMemories(mem, { userText: "我最近总熬夜，好困" }, { limit: 2, minScore: 5 });
check("熬夜 → 召回凌晨才睡", r1.length > 0 && r1[0].entry.id === "m1", r1.map((r) => r.entry.id).join(","));

const r2 = mr.rankMemories(mem, { userText: "今晚又得加班到十点" }, { limit: 2, minScore: 5 });
check("加班 → 召回赶项目", r2.some((r) => r.entry.id === "m3"), r2.map((r) => r.entry.id).join(","));

const r3 = mr.rankMemories(mem, { userText: "我家猫今天拆家了" }, { limit: 2, minScore: 5 });
check("聊猫 → 召回养猫那条", r3.length > 0 && r3[0].entry.id === "m2", r3.map((r) => r.entry.id).join(","));

// ---------- 无关记忆不硬塞 ----------
const r4 = mr.rankMemories(mem, { userText: "帮我看看这段 Rust 代码怎么编译不过" }, { limit: 4, minScore: 5 });
check("聊代码不会拉出养猫/咖啡", !r4.some((r) => r.entry.id === "m2" || r.entry.id === "m5"), r4.map((r) => r.entry.id).join(","));
check("核心记忆允许无条件在场", r4.some((r) => r.entry.id === "m4"), r4.map((r) => r.entry.id).join(","));

// ---------- 上限与无查询 ----------
check("limit 生效", mr.rankMemories(mem, { userText: "熬夜" }, { limit: 1 }).length <= 1);
const r5 = mr.rankMemories(mem, {}, { limit: 10, minScore: 0 });
check("没有用户文本时按重要度排", r5[0].entry.id === "m4");
check("空库返回空", mr.rankMemories([], { userText: "x" }).length === 0);

// ---------- BM25 细节 ----------
const df = new Map([["用户", 5], ["熬夜", 1]]);
const scoreCommon = mr.bm25(["用户"], ["用户", "喜欢", "猫"], df, 5, 3);
const scoreRare = mr.bm25(["熬夜"], ["用户", "经常", "熬夜"], df, 5, 3);
check("稀有词权重高于高频词", scoreRare > scoreCommon, "rare=" + scoreRare.toFixed(2) + " common=" + scoreCommon.toFixed(2));
check("空查询为 0", mr.bm25([], ["用户"], df, 5, 3) === 0);

// ---------- 场景 ----------
const appMem = mk("m6", "用户常用 VS Code 写 TypeScript", "habit", 2, { keywords: ["vscode"] });
const r6 = mr.rankMemories([appMem, mem[1]], { currentApp: "Visual Studio Code" }, { limit: 2, minScore: 5 });
check("场景命中能召回", r6.some((r) => r.entry.id === "m6"));

console.log("memory-rank: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
