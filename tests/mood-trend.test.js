/**
 * 情绪趋势测试：
 * - 同一天多个采样取平均
 * - 最近 3 天 vs 更早几天判断涨落
 * - 心情正常时不输出（不无话找话）
 */
const mt = require("./build/assistant/moodTrend.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};
const day = (n) => new Date(2026, 10, 4, 12, 0).getTime() - n * 86400000;

// ---------- 采样 ----------
let s = mt.recordMoodSample([], 0.4, day(0));
check("首个采样", s.length === 1 && Math.abs(s[0].happiness - 0.4) < 1e-9);
s = mt.recordMoodSample(s, 0.6, day(0));
check("同一天取平均", s.length === 1 && Math.abs(s[0].happiness - 0.5) < 1e-9 && s[0].count === 2);
s = mt.recordMoodSample(s, 0.3, day(1));
check("不同天分别记", s.length === 2);
check("按日期升序", s[0].day < s[1].day);

let many = [];
for (let i = 20; i >= 0; i--) many = mt.recordMoodSample(many, 0.5, day(i));
check("只保留最近 14 天", many.length === 14);

// ---------- 趋势 ----------
const downSamples = [
  { day: mt.moodDayKey(day(9)), happiness: 0.6, count: 1 },
  { day: mt.moodDayKey(day(8)), happiness: 0.62, count: 1 },
  { day: mt.moodDayKey(day(2)), happiness: 0.3, count: 1 },
  { day: mt.moodDayKey(day(1)), happiness: 0.32, count: 1 },
];
const tDown = mt.summarizeMood(downSamples, day(0));
check("识别下降趋势", tDown.trend === "down");
check("最近均值偏低", tDown.recent !== null && tDown.recent < 0.35);

const upSamples = [
  { day: mt.moodDayKey(day(9)), happiness: 0.3, count: 1 },
  { day: mt.moodDayKey(day(2)), happiness: 0.62, count: 1 },
  { day: mt.moodDayKey(day(1)), happiness: 0.66, count: 1 },
];
check("识别上升趋势", mt.summarizeMood(upSamples, day(0)).trend === "up");

const flatSamples = [
  { day: mt.moodDayKey(day(9)), happiness: 0.5, count: 1 },
  { day: mt.moodDayKey(day(1)), happiness: 0.51, count: 1 },
];
check("识别平稳", mt.summarizeMood(flatSamples, day(0)).trend === "flat");
check("只有一天时为 unknown", mt.summarizeMood([{ day: mt.moodDayKey(day(0)), happiness: 0.3, count: 1 }], day(0)).trend === "unknown");

// ---------- 注入 ----------
check("样本不足不输出", mt.moodBlock(mt.summarizeMood([], day(0))) === "");
const low = mt.moodBlock(mt.summarizeMood(downSamples, day(0)));
check("情绪低时提示放软", low.includes("放软") && low.includes("别讲道理"));
check("情绪低时说明别声张", low.includes("不要说出来"));
check("下降趋势会额外提醒", low.includes("更沉"));

const highSamples = [
  { day: mt.moodDayKey(day(9)), happiness: 0.4, count: 1 },
  { day: mt.moodDayKey(day(2)), happiness: 0.7, count: 1 },
  { day: mt.moodDayKey(day(1)), happiness: 0.72, count: 1 },
];
const high = mt.moodBlock(mt.summarizeMood(highSamples, day(0)));
check("情绪好时可以俏皮", high.includes("俏皮"));
check("上升趋势不用小心翼翼", high.includes("不用刻意"));

const midSamples = [
  { day: mt.moodDayKey(day(9)), happiness: 0.5, count: 1 },
  { day: mt.moodDayKey(day(1)), happiness: 0.5, count: 1 },
];
check("心情正常时不无话找话", mt.moodBlock(mt.summarizeMood(midSamples, day(0))) === "");

// ---------- 存档兼容 ----------
check("垃圾存档返回空", mt.normalizeMoodSamples("???").length === 0 && mt.normalizeMoodSamples(null).length === 0);
check("脏条目被丢弃", mt.normalizeMoodSamples([{ day: "2026-11-01", happiness: 0.4 }, { happiness: 0.5 }, null]).length === 1);
check("心情值被夹到 0-1", mt.normalizeMoodSamples([{ day: "2026-11-01", happiness: 9 }])[0].happiness === 1);

console.log("mood-trend: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
