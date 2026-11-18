/**
 * 生活状态 / 节目单 / 纪念日 / 主动消息闸门 / 话头复核 / 口头禅 的纯函数测试。
 * 这些都是"感觉型"逻辑，没有断言很容易越改越怪。
 */
const path = require("node:path");
const life = require("./build/assistant/lifeState.js");
const planMod = require("./build/assistant/dayPlan.js");
const ann = require("./build/assistant/anniversary.js");
const gateMod = require("./build/assistant/proactiveGate.js");
const loopMod = require("./build/assistant/openLoopReview.js");
const habitMod = require("./build/assistant/speechHabits.js");
const runtime = require("./build/assistant/lifeRuntime.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

const at = (h, m = 0, day = 18) => new Date(2026, 10, day, h, m, 0, 0).getTime();

// ---------- 生活状态 ----------
{
  const base = life.defaultLifeState(at(10));
  const later = life.advanceLifeState(base, at(12));
  check("醒着时精力会掉", later.energy < base.energy, `${base.energy.toFixed(2)} → ${later.energy.toFixed(2)}`);
  check("不会掉到负数", later.energy >= 0.08);
  // 从昨晚 22:00 推进到今天 03:00（时间必须往后走，否则会被"时钟倒退"保护挡住）
  const slept = life.advanceLifeState({ ...base, energy: 0.3, updatedAt: at(22, 0, 17) }, at(3));
  check("★ 睡觉时段状态是 asleep", slept.sleep === "asleep", slept.sleep);
  check("★ 睡觉会回精力", slept.energy > 0.3, String(slept.energy.toFixed(2)));
  const woke = life.advanceLifeState({ ...base, sleep: "asleep", energy: 0.95, updatedAt: at(6, 55) }, at(7, 10));
  check("★ 刚醒是 waking", woke.sleep === "waking", woke.sleep);
  check("★ 刚醒精力被打折（听起来才像刚爬起来）", woke.energy <= 0.55, String(woke.energy.toFixed(2)));
  const noon = life.advanceLifeState(base, at(12));
  check("中午是 awake", noon.sleep === "awake", noon.sleep);

  // tick 幂等：同一时刻连算两次结果一样
  const a1 = life.advanceLifeState(base, at(12));
  const a2 = life.advanceLifeState(a1, at(12));
  check("★ 同一时刻重复推进不改变状态", Math.abs(a2.energy - a1.energy) < 1e-9 && a2.updatedAt === a1.updatedAt);

  const interacted = life.advanceLifeState(base, at(12), { interacted: true });
  check("互动过掉精力更快", interacted.energy < later.energy, `${interacted.energy.toFixed(2)} vs ${later.energy.toFixed(2)}`);

  const line = life.lifeLine(base, at(10));
  check("★ 状态描述里没有数字（不能把精力当百分比念出来）", !/[0-9]/.test(line), line);
  check("状态描述非空", line.length > 4, line);
  check("困的时候会提到累/懒", /累|懒|敷衍/.test(life.lifeLine({ ...base, energy: 0.2 }, at(15))));
}

// ---------- 节目单 ----------
{
  const d1 = planMod.buildDayPlan("2026-11-18");
  const d2 = planMod.buildDayPlan("2026-11-18");
  const d3 = planMod.buildDayPlan("2026-11-19");
  check("★ 同一天的节目单完全一样", JSON.stringify(d1) === JSON.stringify(d2));
  check("★ 不同天会换内容", JSON.stringify(d1) !== JSON.stringify(d3));
  check("每天 6 个时段", d1.length === 6, String(d1.length));
  const cur = planMod.currentItem(d1, at(15));
  check("★ 当前安排取「已开始且最晚」的那条", !!cur && cur.at === 14 * 60 + 10, JSON.stringify(cur && cur.at));
  const before = planMod.currentItem(d1, at(7));
  check("还没到第一条时没有当前安排", before === null);
  const next = planMod.nextItem(d1, at(15));
  check("能找到下一条", !!next && next.at === 16 * 60 + 30);
  const p = planMod.planForPrompt(d1, at(15));
  check("★ 给模型的节目单只有「在做」和「接下来」，不是全天流水账", p.includes("现在") && p.includes("接下来") && !p.includes("08:30"), p.replace(/\n/g, " | "));
}

// ---------- 纪念日 ----------
{
  const first = at(0, 0, 1);
  check("第 30 天当天是纪念日", ann.upcomingAnniversaries(first, at(12, 0, 31)).some((a) => a.daysUntil === 0 && a.key === "met-30"));
  const soon = ann.upcomingAnniversaries(first, at(12, 0, 26));
  check("★ 提前几天会预告", soon.some((a) => a.key === "met-30" && a.daysUntil === 5), JSON.stringify(soon.map((a) => [a.key, a.daysUntil])));
  check("没有首次时间就不算", ann.upcomingAnniversaries(0, at(12)).length === 0);
  check("普通日子没有纪念日", ann.upcomingAnniversaries(first, at(12, 0, 10)).length === 0);
  check("★ 只预告一周内的", ann.upcomingAnniversaries(first, at(5, 0, 5), 3).every((a) => a.daysUntil <= 3));
}

// ---------- 主动消息闸门 ----------
{
  const ok = gateMod.evaluateGate({ now: at(15), lastDeliveryAt: 0, deliveredToday: 0, dailyLimit: 5, cooldownMs: 60000, userBusy: false, idleSeconds: 10, idleMode: false });
  check("白天的正常状态放行", ok.allowed);
  const night = gateMod.evaluateGate({ now: at(2), lastDeliveryAt: 0, deliveredToday: 0, dailyLimit: 5, cooldownMs: 60000, userBusy: false, idleSeconds: 10, idleMode: false });
  check("★ 深夜免打扰", !night.allowed && /免打扰/.test(night.reason), night.reason);
  check("免打扰会给一个「之后再说」的时间", !!night.retryInMs && night.retryInMs > 60000);
  check("额度用完不再发", !gateMod.evaluateGate({ now: at(15), lastDeliveryAt: 0, deliveredToday: 5, dailyLimit: 5, cooldownMs: 0, userBusy: false, idleSeconds: 10, idleMode: false }).allowed);
  check("冷却期内不发", !gateMod.evaluateGate({ now: at(15), lastDeliveryAt: at(15) - 30000, deliveredToday: 1, dailyLimit: 5, cooldownMs: 60000, userBusy: false, idleSeconds: 10, idleMode: false }).allowed);
  check("用户正在聊天不发", !gateMod.evaluateGate({ now: at(15), lastDeliveryAt: 0, deliveredToday: 0, dailyLimit: 5, cooldownMs: 0, userBusy: true, idleSeconds: 0, idleMode: false }).allowed);
  check("用户离开不发", !gateMod.evaluateGate({ now: at(15), lastDeliveryAt: 0, deliveredToday: 0, dailyLimit: 5, cooldownMs: 0, userBusy: false, idleSeconds: 900, idleMode: false }).allowed);
}

// ---------- 话头复核 ----------
{
  let loops = loopMod.addLoop([], "你那个报错弄好了吗？", at(10));
  check("★ 问句会记成待复核话头", loops.length === 1 && loops[0].status === "open");
  check("陈述句不记", loopMod.addLoop([], "今天天气不错。", at(10)).length === 0);
  loops = loopMod.markAnswered(loops, at(11));
  check("★ 用户开口后标记为已回应", loops[0].status === "answered");
  const line = loopMod.loopLine(loops, at(11));
  check("★ 已回应的话头提示别再追问", /别再追问|已经回应/.test(line), line);
  const old = loopMod.addLoop([], "那个事怎么样了？", at(10) - 49 * 3600 * 1000);
  check("★ 超过 48 小时的话头自动作废", loopMod.activeLoops(old, at(10)).length === 0);
  check("没有话头时不产生提示", loopMod.loopLine([], at(10)) === "");
}

// ---------- 口头禅学习 ----------
{
  const msgs = ["哈哈这什么", "笑死我了", "确实是这样", "哈哈不行了", "笑死", "今天吃了面", "哈哈哈", "笑死真的", "确实离谱"];
  const habits = habitMod.learnHabits(msgs);
  check("★ 高频口头禅被学出来", habits.includes("哈哈") && habits.includes("笑死"), JSON.stringify(habits));
  check("最多学 3 条", habits.length <= 3, String(habits.length));
  check("偶尔说一句的不学", !habitMod.learnHabits(["确实"]).includes("确实"));
  check("★ 学习结果会生成一句克制的提示", /别刻意模仿/.test(habitMod.habitsLine(habits)), habitMod.habitsLine(habits));
  check("没学到东西时不产生提示", habitMod.habitsLine([]) === "");
}

// ---------- 运行时外壳（没有 localStorage 也不能崩） ----------
{
  check("★ 无 localStorage 时能加载", typeof runtime.lifeRuntime.load(at(10)) === "object");
  runtime.lifeRuntime._resetForTest?.();
  runtime.lifeRuntime.tick(at(10));
  runtime.lifeRuntime.noteUserMessage("嗯……今天好累啊", at(10, 5));
  const block = runtime.lifeRuntime.promptBlock(at(10, 10));
  check("★ 生活上下文拼得出来", typeof block === "string" && block.length > 0, block.slice(0, 60).replace(/\n/g, " | "));
  check("★ 上下文里带「在做的事」", /你今天在做的事/.test(block), block.slice(0, 80));
  // 时间点（08:30）是节目单的锚点，允许出现；但「状态」那一段不能有数值
  const statePart = block.split("【你今天在做的事】")[0];
  check("★ 状态描述不含数字（不能把精力当百分比念）", !/[0-9０-９]/.test(statePart), statePart);
  const g = runtime.lifeRuntime.gate(at(3), { dailyLimit: 8, cooldownMs: 0, userBusy: false, idleSeconds: 0, idleMode: false });
  check("★ 运行时闸门同样拦深夜", !g.allowed, g.reason);
  runtime.lifeRuntime.markDelivered("你吃饭了吗？", at(12));
  const snap = runtime.lifeRuntime.snapshot(at(12));
  check("★ 快照只有文字字段", Object.values(snap).every((v) => typeof v === "string"), JSON.stringify(snap));
}

console.log(`life: fail=${fail}`);
process.exit(fail ? 1 : 0);
