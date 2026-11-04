/**
 * "顺口问一句"测试：
 * - 只挑重要、够久没提、够久以前记下的记忆（不问身份、不问琐事、不复查刚聊过的）
 * - 节流：3 小时冷却、每天最多 2 次
 * - 提示文本要能让模型"接不上就不提"，而不是背诵
 */
const mn = require("./build/assistant/memoryNudge.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};
const now = new Date(2026, 10, 4, 15, 0).getTime();
const day = 86400000;
const mk = (id, content, category, importance, idleDays, ageDays = 10) => ({
  id, content, category, importance,
  createdAt: now - ageDays * day,
  lastUsedAt: now - idleDays * day,
});

const mem = [
  mk("a", "用户在准备一个后端接口的重构", "event", 2, 5),
  mk("b", "用户叫小明", "identity", 1, 8),
  mk("c", "用户和同事关系不太好", "relationship", 2, 9),
  mk("d", "用户在追一部科幻剧", "preference", 2, 12),
  mk("e", "用户喝咖啡", "habit", 3, 20),
  mk("f", "用户刚说的新事：明天要交论文", "event", 2, 1, 1),
  mk("g", "短", "other", 2, 30),
];

const pick = mn.pickNudgeCandidate(mem, now);
check("能挑出候选", !!pick, pick ? pick.id : "null");
check("不挑身份类", pick && pick.id !== "b");
check("不挑关系类", pick && pick.id !== "c");
check("不挑琐碎记忆", pick && pick.id !== "e");
check("不挑刚聊过的", pick && pick.id !== "f");
check("不挑太短的", pick && pick.id !== "g");
check("优先挑最久没提的", !!pick && pick.id === "d", pick ? pick.id : "null");

check("空库返回 null", mn.pickNudgeCandidate([], now) === null);
check("全是新记忆时返回 null", mn.pickNudgeCandidate([mk("x", "用户刚开始学钢琴", "preference", 2, 0, 1)], now) === null);

// ---------- 节流 ----------
check("从没提过可以提", mn.shouldNudge(mn.emptyNudgeState(), now) === true);
check("刚提过要冷却", mn.shouldNudge({ lastAt: now - 1000, day: mn.nudgeDayKey(now), countToday: 1 }, now) === false);
check("过了 3 小时可以", mn.shouldNudge({ lastAt: now - 3.1 * 60 * 60 * 1000, day: mn.nudgeDayKey(now), countToday: 1 }, now) === true);
check("当天已 2 次不再提", mn.shouldNudge({ lastAt: now - 5 * 60 * 60 * 1000, day: mn.nudgeDayKey(now), countToday: 2 }, now) === false);
check("第二天额度重置", mn.shouldNudge({ lastAt: now - 26 * 60 * 60 * 1000, day: mn.nudgeDayKey(now - day), countToday: 2 }, now) === true);

let st = mn.emptyNudgeState();
st = mn.markNudged(st, now);
check("标记一次", st.countToday === 1 && st.lastAt === now && st.day === mn.nudgeDayKey(now));
st = mn.markNudged(st, now + 4 * 60 * 60 * 1000);
check("同一天累加", st.countToday === 2);

// ---------- 提示文本 ----------
check("没有候选不输出", mn.nudgeBlock(null) === "");
const blk = mn.nudgeBlock(pick);
check("提示带上旧事内容", blk.includes(pick.content));
check("要求接不上就不提", blk.includes("接不上就当没看见"));
check("禁止背诵式表达", blk.includes("我记得你曾经说过"));
check("说明不是任务", blk.includes("不是任务"));

// ---------- 存档兼容 ----------
check("垃圾存档归一", mn.normalizeNudgeState("???").countToday === 0 && mn.normalizeNudgeState(null).lastAt === 0);
check("负计数被夹到 0", mn.normalizeNudgeState({ countToday: -3 }).countToday === 0);

console.log("memory-nudge: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
