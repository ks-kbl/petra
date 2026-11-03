/**
 * 主动问候话题记忆测试：
 * - 只统计"今天"的问候
 * - 找得到最近一次未回复的问候
 * - 用户回复后标记为已回复
 */
const gm = require("./build/assistant/greetingMemory.js");
const gh = require("./build/assistant/greetingHistory.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

const now = new Date(2026, 10, 3, 15, 30).getTime();
const yesterday = new Date(2026, 10, 2, 15, 30).getTime();
const morning = new Date(2026, 10, 3, 9, 0).getTime();
const noon = new Date(2026, 10, 3, 12, 0).getTime();
const records = [
  { at: yesterday, summary: "昨天写代码", greeting: "昨天也在写代码？", replied: false },
  { at: morning, summary: "早上在看文档", greeting: "早上好，看文档呢？", replied: false },
  { at: noon, summary: "中午在吃饭", greeting: "中午吃点好的～", replied: false },
];

check("日期键按本地自然日", gm.greetingDayKey(now) === "2026-11-03", gm.greetingDayKey(now));
check("只保留今天的问候", gm.greetingsToday(records, now).length === 2);
check("今天的记录按时间排序", gm.greetingsToday(records, now).map((r) => r.summary).join(",") === "早上在看文档,中午在吃饭");
check("最近一次未回复问候是中午那条", gm.previousUnansweredGreeting(records, now)?.summary === "中午在吃饭");
check("今天话题最多取最近 3 条", gm.recentGreetingTopics(records, now, 3).length === 2);

const copy = records.map((r) => ({ ...r }));
check("标记回复有改动", gm.markLatestGreetingReplied(copy, now) === true);
check("最近一条变成已回复", copy[2].replied === true);
check("再次标记不重复改动", gm.markLatestGreetingReplied(copy, now) === true && copy[1].replied === true);
check("全部回复后没有未回复问候", gm.markLatestGreetingReplied(copy, now) === false && gm.previousUnansweredGreeting(copy, now) === null);

// ---------- 历史标记 ----------
check("问候历史加【问候】标记", gh.markGreetingForHistory("早上好呀") === "【问候】早上好呀");
check("已带标记不重复加", gh.markGreetingForHistory("【问候】早上好呀") === "【问候】早上好呀");
check("能识别问候历史", gh.isGreetingHistoryContent("【问候】早上好呀") === true);
check("普通对话不算问候", gh.isGreetingHistoryContent("早上好呀") === false);
check("空内容不崩", gh.isGreetingHistoryContent(null) === false);

console.log("greeting-memory: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
