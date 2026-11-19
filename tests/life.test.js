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
const affect = require("./build/assistant/affect.js");
const favorMod = require("./build/assistant/favor.js");
const mention = require("./build/assistant/mentionScore.js");
const persona = require("./build/assistant/personaRoutine.js");
const addr = require("./build/assistant/address.js");
const style = require("./build/assistant/expressionStyle.js");
const refusal = require("./build/assistant/refusal.js");
const depth = require("./build/assistant/depth.js");
const voice = require("./build/assistant/voiceTone.js");

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

// ---------- 情绪事件：有原因、有半衰期、会衰减 ----------
{
  const now = at(14, 20);
  const e = { id: "a1", kind: "hurt", reason: "被叫胖", intensity: -0.8, startedAt: now, halfLifeMin: 90 };
  let events = affect.addEvent([], e, now);
  check("★ 情绪事件带着原因", events.length === 1 && events[0].reason === "被叫胖");
  check("刚发生时强度最高", Math.abs(affect.decayedIntensity(events[0], now) + 0.8) < 1e-6);
  const afterHalf = affect.decayedIntensity(events[0], now + 90 * 60000);
  check("★ 一个半衰期后只剩一半", Math.abs(afterHalf + 0.4) < 0.02, afterHalf.toFixed(2));
  const m1 = affect.currentMood(events, now);
  check("★ 气头上心情是负的", m1.value < -0.5 && m1.dominant.reason === "被叫胖");
  const m2 = affect.currentMood(events, now + 4 * 3600 * 1000);
  check("★ 四小时后气基本消了", Math.abs(m2.value) < 0.15, m2.value.toFixed(2));
  // 情绪只负责"为什么、到什么程度、别装没事"；"话短还是阴阳"由表达型决定
  check("★ 生气时会说明原因并禁止装没事", /别装|不要装作没事/.test(affect.moodLine(events, now))
    && affect.moodLine(events, now).includes("被叫胖"));
  check("★ 情绪描述不规定语气长短（那是表达型的事）", !/话要短|语气冲/.test(affect.moodLine(events, now)));
  check("没情绪时不产生提示", affect.moodLine([], now) === "");

  // 同一原因重复触发是刷新时间，不是叠强度
  const twice = affect.addEvent(events, { ...e, id: "a2", startedAt: now + 60000 }, now + 60000);
  check("★ 同一原因不叠加强度", twice.length === 1, String(twice.length));

  // 超过 24 小时自动作废
  check("★ 情绪最多挂 24 小时", affect.pruneEvents(events, now + 25 * 3600 * 1000).length === 0);

  // 哄一句：半衰期打折
  const softened = affect.soften(events, 0.5);
  check("★ 被哄之后气消得更快", softened[0].halfLifeMin === 45, String(softened[0].halfLifeMin));
  check("认出道歉", affect.looksLikeApology("对不起嘛，别生气了"));
  check("普通话不算道歉", !affect.looksLikeApology("今天天气不错"));
  check("★ 认出伤人的话", affect.insultStrength("你是不是胖了") > 0.5);
  check("玩笑话强度低", affect.insultStrength("你是不是傻") < 0.5 && affect.insultStrength("你是不是傻") > 0);
}

// ---------- 好感度：长期账户 ----------
{
  const f0 = favorMod.defaultFavor(at(9));
  const up = favorMod.applyAffect(f0, 0.8, at(10));
  const down = favorMod.applyAffect(f0, -0.8, at(10));
  check("★ 好事涨好感、坏事掉好感", up.score > f0.score && down.score < f0.score);
  check("★ 单次变化有上限（一次吵架不会清零）", Math.abs(down.score - f0.score) <= 0.13, down.score.toFixed(3));
  const back = favorMod.decay({ score: 0.9, updatedAt: 0 }, at(9) + 30 * 86400000);
  check("★ 长期会向中间值回落", back.score < 0.9 && back.score > 0.5, back.score.toFixed(2));
  check("很亲近时有对应说法", /亲近|黏/.test(favorMod.favorLine({ score: 0.9, updatedAt: 0 })));
  check("★ 心情差 + 关系好 = 凶两句再找台阶", /台阶/.test(favorMod.toneLine({ score: 0.8, updatedAt: 0 }, -0.6)));
  check("★ 心情差 + 关系远 = 冷", /冷/.test(favorMod.toneLine({ score: 0.2, updatedAt: 0 }, -0.6)));
}

// ---------- 记忆该不该提 ----------
{
  const now = at(21, 0);
  const situational = { content: "用户正在上化学网课", category: "event", at: at(10, 0) };
  const fresh = { content: "用户正在上化学网课", category: "event", at: now - 10 * 60000 };
  check("★ 上午的「正在上网课」晚上不提", !mention.scoreMention(situational, { now }).should);
  check("★ 十分钟前的现场情况可以提", mention.scoreMention(fresh, { now }).should);
  const milestone = { content: "第一次一起熬夜", category: "event", at: at(0, 0, 1) };
  check("★ 里程碑不过期", mention.scoreMention(milestone, { now }).should);
  const oldSmall = { content: "用户提过一句喜欢这首歌", category: "preference", at: now - 200 * 86400000 };
  check("★ 太久远的小事降权", mention.scoreMention(oldSmall, { now }).score < 0.18);
  const happyOld = { content: "用户那天笑得很开心", category: "event", at: now - 3600000 };
  check("★ 气头上不翻开心旧事", mention.scoreMention(happyOld, { now, mood: -0.6 }).score
    < mention.scoreMention(happyOld, { now, mood: 0 }).score);
  check("过滤后保持原顺序", mention.filterMentionable([fresh, situational], { now }).length === 1);
}

// ---------- 人设决定过什么日子 ----------
{
  const fish = persona.detectTraits("赛博女仆鲸鱼娘，贱兮兮，爱吃，摸鱼专业户，自称本鱼");
  check("★ 从大肥鱼人设识别出「爱吃」「摸鱼」", fish.includes("food") && fish.includes("lazy"), JSON.stringify(fish));
  const coach = persona.detectTraits("健身教练，每天跑步锻炼，性格严厉");
  check("★ 另一种人设识别出「运动」", coach.includes("sport"), JSON.stringify(coach));
  const planFish = planMod.buildDayPlan("2026-11-18", fish);
  const planNeutral = planMod.buildDayPlan("2026-11-18", []);
  const fishText = planFish.map((p) => p.title).join("|");
  check("★ 大肥鱼的日子里有吃/躺/摸鱼", /吃|奶茶|躺|赖床|吃|饿/.test(fishText), fishText);
  check("★ 同一天、不同人设，日子不一样", JSON.stringify(planFish) !== JSON.stringify(planNeutral));
  check("没人设时也能生成", planNeutral.length === 6);
}

// ---------- 称呼三档 ----------
{
  const forms = addr.deriveAddressForms("赛博女仆鲸鱼娘，叫用户「老大」，也叫鱼片，傲娇");
  check("★ 从人设里认出亲昵称呼", forms.close === "老大", JSON.stringify(forms));
  check("★ 气到极点且关系一般 → 冷淡档", addr.addressTier(-0.8, 0.3) === "cold");
  check("★ 气到极点但关系好 → 只掉到中性", addr.addressTier(-0.8, 0.8) === "neutral");
  check("★ 平时且关系好 → 亲昵", addr.addressTier(0.1, 0.8) === "close");
  check("★ 冷淡档不再用亲昵称呼", /别用亲昵称呼/.test(addr.addressLine("cold", forms)), addr.addressLine("cold", forms));
  check("没写称呼的人设也能用", addr.deriveAddressForms("一个普通的助手").neutral === "你");
}

// ---------- 生气的表达型 ----------
{
  check("★ 傲娇/毒舌人设 → 阴阳怪气", style.deriveExpressionStyle("贱兮兮、傲娇、爱吐槽") === "sarcastic");
  check("★ 高冷人设 → 话变少", style.deriveExpressionStyle("高冷、话少、沉默") === "terse");
  check("★ 温柔人设 → 嘴硬装没事", style.deriveExpressionStyle("温柔体贴、心软") === "pretend");
  check("三种表达型都有各自的说法", new Set([
    style.styleLine("sarcastic"), style.styleLine("terse"), style.styleLine("pretend"),
  ]).size === 3);
}

// ---------- 生气时不干活（含四条硬约束） ----------
{
  const base = { mood: -0.8, refusedToday: 0, sameRequestRefused: 0, roll: 0 };
  const social = refusal.shouldRefuse({ ...base, text: "陪我聊会儿嘛" });
  check("★ 气头上、社交请求 → 会拒绝", social.refuse === true, JSON.stringify(social));
  check("拒绝要给理由和台阶", !!social.reason && !!social.out);
  check("★ 关机这类永不可拒绝", !refusal.shouldRefuse({ ...base, text: "帮我关机" }).refuse);
  check("★ 删除文件永不可拒绝", !refusal.shouldRefuse({ ...base, text: "把那个文件删掉" }).refuse);
  check("★ 发消息永不可拒绝", !refusal.shouldRefuse({ ...base, text: "帮我发消息给张三" }).refuse);
  check("★ 功能性请求不拒", !refusal.shouldRefuse({ ...base, text: "帮我查一下天气" }).refuse);
  check("★ 同一条请求第二次必须执行", !refusal.shouldRefuse({ ...base, text: "陪我聊会儿嘛", sameRequestRefused: 1 }).refuse);
  check("默认额度 2 次用完后不再拒", !refusal.shouldRefuse({ ...base, text: "陪我聊会儿嘛", refusedToday: 2 }).refuse);
  check("★ 额度可以按人设放宽（傲娇 3 次）", !refusal.shouldRefuse({ ...base, text: "陪我聊会儿嘛", refusedToday: 2, dailyCap: 3 }).refuse === false
    && refusal.shouldRefuse({ ...base, text: "陪我聊会儿嘛", refusedToday: 2, dailyCap: 3 }).refuse === true);
  check("★ 额度可以按人设收紧（温柔 1 次）", refusal.shouldRefuse({ ...base, text: "陪我聊会儿嘛", refusedToday: 1, dailyCap: 1 }).refuse === false);
  check("★ 说「认真的」立刻照做", !refusal.shouldRefuse({ ...base, text: "认真的，陪我聊会儿" }).refuse);
  check("没生气时不拒绝", !refusal.shouldRefuse({ ...base, mood: 0.2, text: "陪我聊会儿嘛" }).refuse);
  check("小不爽概率更低", refusal.refusalProbability(-0.3) < refusal.refusalProbability(-0.8));
  check("★ 拒绝台词会说明原因", /不干|不。|不太想/.test(refusal.refusalLine("sarcastic", "还在气头上")));
  check("话变少型的拒绝更短", refusal.refusalLine("terse", "还在气头上").length
    < refusal.refusalLine("sarcastic", "还在气头上").length);
}

// ---------- 拒绝额度由人设决定 ----------
{
  check("★ 傲娇嘴硬的额度更高", refusal.refusalBudget("sarcastic", ["lazy"]) >= 3, String(refusal.refusalBudget("sarcastic", ["lazy"])));
  check("★ 温柔的额度最低", refusal.refusalBudget("pretend", []) <= 1, String(refusal.refusalBudget("pretend", [])));
  check("正经/自律的人设少甩脸色", refusal.refusalBudget("sarcastic", ["tech"]) < refusal.refusalBudget("sarcastic", []));
  check("额度硬顶 4 次、下限 0", refusal.refusalBudget("sarcastic", ["lazy", "food"]) <= 4
    && refusal.refusalBudget("pretend", ["tech", "sport"]) >= 0);
  check("★ 表达型影响闹脾气概率", refusal.refusalProbability(-0.8, refusal.refusalTendency("sarcastic"))
    > refusal.refusalProbability(-0.8, refusal.refusalTendency("pretend")));
  check("概率有上限（不会每次都拒）", refusal.refusalProbability(-1, 1.5) <= 0.5);
}

// ---------- 深浅与锋锐 ----------
{
  check("★ 问「为什么」→ 深聊档", depth.depthFor({ text: "为什么这个报错一直出现", mood: 0.1 }) === "deep");
  check("★ 求方案 → 深聊档", depth.depthFor({ text: "帮我分析下这几个方案的区别", mood: 0.1 }) === "deep");
  check("★ 打招呼 → 简答档", depth.depthFor({ text: "在吗", mood: 0.1 }) === "brief");
  check("★ 普通闲聊 → 正常档", depth.depthFor({ text: "今天下午有点困", mood: 0.1 }) === "normal");
  check("★ 气头上不给长篇大论", depth.depthFor({ text: "为什么这个报错一直出现", mood: -0.8 }) === "brief");
  check("深聊档的要求里强调「给判断」", /判断/.test(depth.depthLine("deep")));
  check("简答档明确要求别铺垫", /别铺垫/.test(depth.depthLine("brief")));

  const sharp = depth.sharpnessLine(-0.8);
  check("★ 生气时给锋锐技法", /复述|点破|冷静/.test(sharp), sharp);
  check("★ 明确禁止脏字和人身攻击", /不许带脏字/.test(sharp) && /人身攻击/.test(sharp));
  check("不生气时不给锋锐提示", depth.sharpnessLine(-0.1) === "");
  check("★ 反敷衍规则覆盖空话与判断", /确实/.test(depth.ANTI_FLUFF_RULES) && /判断/.test(depth.ANTI_FLUFF_RULES));
}

// ---------- 语音能力告知 ----------
{
  const on = voice.voiceCapabilityLine({ enabled: true, hasVoice: true });
  const off = voice.voiceCapabilityLine({ enabled: false, hasVoice: true });
  const noVoice = voice.voiceCapabilityLine({ enabled: true, hasVoice: false });
  check("★ 开着语音：提醒句子别太长、少用符号", /别太长|符号/.test(on), on);
  check("★ 关着语音：禁止说「念给你听」", /不要说|关着/.test(off) && /念给你听/.test(off), off);
  check("★ 开了但没音色：明确不会出声", /不会出声/.test(noVoice), noVoice);
  check("三种状态的文案互不相同", new Set([on, off, noVoice]).size === 3);
}

// ---------- 情绪 → 语音参数 ----------
{
  const angry = voice.voiceToneFor({ mood: -0.8, energy: 0.8, sleep: "awake" });
  const happy = voice.voiceToneFor({ mood: 0.7, energy: 0.8, sleep: "awake" });
  const tired = voice.voiceToneFor({ mood: 0, energy: 0.15, sleep: "awake" });
  const neutral = voice.voiceToneFor({ mood: 0, energy: 0.6, sleep: "awake" });
  check("★ 生气（默认阴阳型）：整段发闷（tilt 上升）", angry.tilt > neutral.tilt, JSON.stringify(angry));
  const sarcastic = voice.voiceToneFor({ mood: -0.8, energy: 0.6, style: "sarcastic" });
  const terse = voice.voiceToneFor({ mood: -0.8, energy: 0.6, style: "terse" });
  check("★ 阴阳怪气最闷（压着嗓子）", sarcastic.tilt >= terse.tilt, `${sarcastic.tilt} vs ${terse.tilt}`);
  check("★ 三种怒的听感不同", JSON.stringify(sarcastic) !== JSON.stringify(terse));
  check("★ 不再向服务端要变调（接口里没有 pitch）", !("pitch" in sarcastic), JSON.stringify(sarcastic));
  check("★ tilt 上限只有 0.25（只暗一点，不能闷）", sarcastic.tilt <= 0.25 && happy.tilt <= 0.25);
  // 累 / 刚睡醒只用"慢+轻"，不许动频谱——这是"声音好闷"的直接原因
  check("★ 累的时候不压低频（tilt 保持 0）", voice.voiceToneFor({ mood: 0, energy: 0.1, sleep: "awake" }).tilt === 0);
  check("★ 刚睡醒也不压低频", voice.voiceToneFor({ mood: 0, energy: 0.6, sleep: "waking" }).tilt === 0);
  check("★ 只有真生气才轻微发闷", voice.voiceToneFor({ mood: -0.8, energy: 0.6, style: "sarcastic" }).tilt > 0
    && voice.voiceToneFor({ mood: 0, energy: 0.6 }).tilt === 0);
  check("★ 高兴：语速上扬、不发闷", happy.rate > neutral.rate && happy.tilt <= neutral.tilt, JSON.stringify(happy));
  check("★ 累：语速变慢、音量变轻", tired.rate < neutral.rate && tired.volume < 1, JSON.stringify(tired));
  check("幅度都很小（不像变声器）", Math.abs(angry.rate) <= 8 && angry.tilt <= 0.6 && angry.volume >= 0.8);
  check("刚睡醒会更慢", voice.voiceToneFor({ mood: 0, energy: 0.6, sleep: "waking" }).rate
    < voice.voiceToneFor({ mood: 0, energy: 0.6, sleep: "awake" }).rate);
  check("音量不会被压到听不见", voice.voiceToneFor({ mood: -1, energy: 0.05, sleep: "asleep" }).volume >= 0.8);
}

// ---------- 滑动窗口：上午别刷屏、下午不要哑火 ----------
{
  const now = Date.parse("2026-11-19T14:00:00");
  const mk = (backMin) => ({ ...({}), now: now - backMin * 60000 });
  const base = {
    lastDeliveryAt: 0, deliveredToday: 2, dailyLimit: 24, cooldownMs: 20 * 60000,
    userBusy: false, idleSeconds: 10, idleMode: false, now,
  };
  // 90 分钟内说过一次 → 先别说
  const short = gateMod.evaluateGate({ ...base, recentDeliveries: [now - 40 * 60000] });
  check("★ 90 分钟内已经说过就不再开口", !short.allowed && /90 分钟/.test(short.reason), short.reason);
  // 6 小时内已经 4 次 → 先别说
  const long = gateMod.evaluateGate({
    ...base, lastDeliveryAt: now - 100 * 60000,
    recentDeliveries: [100, 180, 260, 340].map((m) => now - m * 60000),
  });
  check("★ 6 小时内 4 次就压住", !long.allowed && /有点多/.test(long.reason), long.reason);
  // 上一个窗口都过期了 → 应该放行（不能像日额度那样"用完就整天哑火"）
  const ok = gateMod.evaluateGate({
    ...base, lastDeliveryAt: now - 200 * 60000,
    recentDeliveries: [200, 260].map((m) => now - m * 60000),
  });
  check("★ 窗口过期后恢复正常（不会一下午哑火）", ok.allowed, JSON.stringify(ok));
}

console.log(`life: fail=${fail}`);
process.exit(fail ? 1 : 0);
