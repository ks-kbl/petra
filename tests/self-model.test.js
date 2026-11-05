/**
 * 自我状态（潜移默化的人格变化）测试：
 * - 打点不改人格；只有跨天结算、且同类事件够多才动
 * - 单日每维度 ≤ DAILY_TRAIT_CAP、合计 ≤ DAILY_TOTAL_CAP
 * - 极端 1000 天后仍在 基线±MAX_DRIFT 内
 * - 没有事件时会慢慢回弹；叙述有阈值和最短间隔
 */
const sm = require("./build/assistant/selfModel.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};
const DAY = 86400000;
const day = (n) => new Date(2026, 10, 1, 12, 0).getTime() + n * DAY;

// ---------- 打点不改人格 ----------
let st = sm.emptySelfState(day(0));
st = sm.recordEvent(st, "praised", day(0));
check("打点后维度不变", st.traits.warmth === sm.BASELINE);
check("计数有记录", st.dayCounters.praised === 1);

// ---------- 跨天结算 ----------
let s1 = sm.emptySelfState(day(0));
s1 = sm.recordEvent(s1, "praised", day(0));
s1 = sm.recordEvent(s1, "praised", day(0));
s1 = sm.recordEvent(s1, "praised", day(0));
s1 = sm.settleDay(s1, day(1));
check("够次数才推动维度", s1.traits.warmth > sm.BASELINE, "warmth=" + s1.traits.warmth);
check("单维度变化 ≤ 每日上限", Math.abs(s1.traits.warmth - sm.BASELINE) <= sm.DAILY_TRAIT_CAP + 1e-9);
const dailyTotal = Object.values(s1.log[0].delta).reduce((a, b) => a + Math.abs(b), 0);
check("单日合计 ≤ 总上限", dailyTotal <= sm.DAILY_TOTAL_CAP + 1e-9, "total=" + dailyTotal.toFixed(4));

// 同一天重复结算幂等
const s1b = sm.settleDay(s1, day(1) + 1000);
check("同一天重复结算幂等", s1b.traits.warmth === s1.traits.warmth);

// 次数不够不推动
let s2 = sm.emptySelfState(day(0));
s2 = sm.recordEvent(s2, "praised", day(0));
s2 = sm.settleDay(s2, day(1));
check("只有 1 次不推动", Math.abs(s2.traits.warmth - sm.BASELINE) < 1e-9);

// ---------- 上限 ----------
let s3 = sm.emptySelfState(day(0));
for (let d = 0; d < 1000; d++) {
  for (let i = 0; i < 10; i++) s3 = sm.recordEvent(s3, "praised", day(d));
  s3 = sm.recordEvent(s3, "joked", day(d));
  s3 = sm.recordEvent(s3, "joked", day(d));
  s3 = sm.settleDay(s3, day(d + 1));
}
const offsets = sm.traitOffsets(s3);
const maxAbs = Math.max(...Object.values(offsets).map(Math.abs));
check("1000 天后仍在界限内", maxAbs <= sm.MAX_DRIFT + 1e-6, "max=" + maxAbs.toFixed(3));
check("不会被推到 NaN", Object.values(offsets).every(Number.isFinite));

// ---------- 回弹 ----------
let s4 = sm.emptySelfState(day(0));
for (let d = 0; d < 20; d++) {
  for (let i = 0; i < 4; i++) s4 = sm.recordEvent(s4, "joked", day(d));
  s4 = sm.settleDay(s4, day(d + 1));
}
const peak = s4.traits.playfulness;
for (let d = 20; d < 260; d++) s4 = sm.settleDay(s4, day(d + 1));
check("停掉事件后会回弹", s4.traits.playfulness < peak, `${peak.toFixed(3)} → ${s4.traits.playfulness.toFixed(3)}`);
check("回弹不会越过基线", s4.traits.playfulness >= sm.BASELINE - 1e-9);

// ---------- 叙述 ----------
check("刚开始没有叙述", sm.selfBlock(sm.emptySelfState(day(0))) === "");
check("叙述有阈值（刚动一点不出）", s1.narrative === "" || s1.totalDrift >= sm.NARRATIVE_THRESHOLD);
let s5 = sm.emptySelfState(day(0));
for (let d = 0; d < 12; d++) {
  for (let i = 0; i < 4; i++) s5 = sm.recordEvent(s5, "praised", day(d));
  s5 = sm.settleDay(s5, day(d + 1));
}
check("积累够了会生成叙述", s5.narrative.length > 0, s5.narrative);
const firstAt = s5.narrativeAt;
// 再跑一天（间隔不足 3 天）叙述不应重新生成
const before = s5.narrative;
for (let i = 0; i < 4; i++) s5 = sm.recordEvent(s5, "praised", day(12));
s5 = sm.settleDay(s5, day(13));
check("叙述有最短间隔", s5.narrativeAt === firstAt || s5.narrative !== before);
check("selfBlock 带使用约束", s5.narrative ? sm.selfBlock(s5).includes("不要说破") : true);

// ---------- 事件识别 ----------
check("识别被夸", sm.detectSocialEvents("你好厉害").includes("praised"));
check("识别道谢", sm.detectSocialEvents("谢谢啦").includes("praised"));
check("识别玩梗", sm.detectSocialEvents("哈哈哈哈哈").includes("joked"));
check("识别低落", sm.detectSocialEvents("今天好累啊").includes("userLowMood"));
check("识别长聊", sm.detectSocialEvents("啊".repeat(80)).includes("longChat"));
check("普通句子不误判", sm.detectSocialEvents("今天几号").length === 0);
check("空串不炸", sm.detectSocialEvents("").length === 0);

// ---------- 存档兼容 ----------
const bad = sm.normalizeSelfState({ traits: { warmth: 99, patience: "x" } }, day(0));
check("脏存档被夹到范围内", bad.traits.warmth <= sm.BASELINE + sm.MAX_DRIFT && bad.traits.patience === sm.BASELINE);
check("null 存档不炸", sm.normalizeSelfState(null, day(0)).traits.warmth === sm.BASELINE);

console.log("self-model: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
