/**
 * 长对话滚动摘要测试：
 * - 只摘要"即将被窗口切掉"的那一段，最近 120 条永远原样保留
 * - tool 消息/空消息不进摘要；coveredCount 推进正确
 * - 模型输出宽容解析；空/太短视为失败（保持旧摘要）
 */
const cs = require("./build/assistant/chatSummary.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

const now = new Date(2026, 10, 4, 12, 0).getTime();

// ---------- 什么时候该摘要 ----------
check("短对话不摘要", cs.shouldSummarize(50, cs.emptyChatSummary(), 120, 30) === false);
check("刚够窗口不摘要", cs.shouldSummarize(120, cs.emptyChatSummary(), 120, 30) === false);
check("挤出 30 条摘要", cs.shouldSummarize(150, cs.emptyChatSummary(), 120, 30) === true);
check("挤出 29 条不摘要", cs.shouldSummarize(149, cs.emptyChatSummary(), 120, 30) === false);
check("已摘过的部分不重复算", cs.shouldSummarize(150, { text: "x", coveredCount: 30, updatedAt: 0 }, 120, 30) === false);
check("再挤出 30 条又该摘要", cs.shouldSummarize(180, { text: "x", coveredCount: 30, updatedAt: 0 }, 120, 30) === true);

// ---------- 取哪一段 ----------
const history = [];
history.push({ role: "system", content: "忽略" });
for (let i = 0; i < 10; i++) history.push({ role: i % 2 ? "assistant" : "user", content: "消息" + i });
history.push({ role: "assistant", content: null, tool_calls: [{ id: "t1" }] });
history.push({ role: "tool", content: "工具结果" });
history.push({ role: "user", content: "" });

const got = cs.collectSummarizable(history, 0, 5);
check("只取窗口之前的部分", got.picked.length === 8, "picked=" + got.picked.length);
check("不把 tool 消息塞进摘要", got.picked.every((m) => m.role === "user" || m.role === "assistant"));
check("空内容被过滤", got.picked.every((m) => m.content.length > 0));
check("nextCoveredCount 指向窗口起点", got.nextCoveredCount === history.length - 5);
const got2 = cs.collectSummarizable(history, 3, 5);
check("已覆盖的不重复取", got2.picked.length === 6 && got2.picked[0].content === "消息2", "picked=" + got2.picked.length);

const longText = "很长".repeat(400);
const got3 = cs.collectSummarizable([{ role: "user", content: longText }], 0, 0);
check("超长消息被截断", got3.picked[0].content.length <= 401);

// ---------- prompt ----------
const msgs = cs.buildSummaryMessages(
  [{ role: "user", content: "我下周要交论文" }, { role: "assistant", content: "记得早点开始" }],
  "之前聊过他在写小说。",
);
check("摘要 prompt 有 system", msgs[0].role === "system" && msgs[0].content.includes("只写聊过的事实"));
check("带旧摘要", msgs[1].content.includes("之前聊过他在写小说"));
check("带新旧对话且分角色", msgs[1].content.includes("用户：我下周要交论文") && msgs[1].content.includes("助理：记得早点开始"));
check("要求合并成一段", msgs[0].content.includes("合并成**一段**"));

// ---------- 解析 ----------
const ok = cs.parseSummaryResponse("摘要：他在写小说，下周要交论文，讨厌被打断。", "", 140, now);
check("解析去掉「摘要：」前缀", !!ok && ok.text.startsWith("他在写小说"));
check("记录覆盖条数", !!ok && ok.coveredCount === 140);
check("记录更新时间", !!ok && ok.updatedAt === now);
check("空输出返回 null", cs.parseSummaryResponse("   ", "", 140, now) === null);
check("太短返回 null", cs.parseSummaryResponse("好的", "", 140, now) === null);
check("非字符串返回 null", cs.parseSummaryResponse(null, "", 140, now) === null);
const fenced = cs.parseSummaryResponse("```\n他在写小说，下周要交论文，最近很焦虑\n```", "", 10, now);
check("解析代码块包裹", !!fenced && !fenced.text.includes("```"));
const longOut = cs.parseSummaryResponse("啊".repeat(900), "", 10, now);
check("超长输出被截断", !!longOut && longOut.text.length <= 601);

// ---------- 悬而未决 ----------
const withLoops = cs.parseSummaryResponse(
  "他在改一个后端接口，顺便问了下论文的事。\n悬而未决：接口还没改完；等面试结果；答应了周末帮朋友搬家",
  "",
  140,
  now,
);
check("抠出悬而未决", !!withLoops && withLoops.openLoops.length === 3);
check("悬而未决从正文剥离", !!withLoops && !withLoops.text.includes("悬而未决"));
check("悬而未决内容正确", !!withLoops && withLoops.openLoops[0] === "接口还没改完");
check("写「无」时为空", cs.parseSummaryResponse("聊了会儿天，没什么特别的。\n悬而未决：无", "", 10, now).openLoops.length === 0);
check("没有这一行也不炸", cs.parseSummaryResponse("聊了会儿天，没什么特别的。", "", 10, now).openLoops.length === 0);
check("存档归一保留 openLoops", cs.normalizeChatSummary({ text: "x", openLoops: ["a", "", 3, "b"] }).openLoops.join() === "a,b");

// ---------- 注入块 ----------
check("空摘要不注入", cs.summaryBlock(cs.emptyChatSummary()) === "");
check("null 不炸", cs.summaryBlock(null) === "");
const blk = cs.summaryBlock({ text: "他在写小说，下周交论文。", coveredCount: 140, updatedAt: now });
check("摘要块含内容", blk.includes("他在写小说"));
check("摘要块禁止说「摘要」", blk.includes("不要提「摘要」"));

// ---------- 存档兼容 ----------
check("垃圾存档归一", cs.normalizeChatSummary("???").text === "" && cs.normalizeChatSummary(null).coveredCount === 0);
check("负下标被夹到 0", cs.normalizeChatSummary({ coveredCount: -5 }).coveredCount === 0);

console.log("chat-summary: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
