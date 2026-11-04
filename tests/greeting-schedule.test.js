/**
 * 主动问候计时规则测试（纯函数，不需要浏览器/API）。
 *
 * 锁住用户明确提出的产品要求：
 * - 在设置里改完间隔后，下一次问候要按**新间隔从改完这一刻**重新计时；
 * - 重新打开小助手也重新计时；
 * - 用户的输入被钳制在 1~1440 分钟，非法值回落默认 20。
 *
 * 运行：npm run test:greeting
 */
const gs = require("./build/assistant/greetingSchedule.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

const MIN = 60 * 1000;

// ---- 间隔钳制 ----
check("默认 20 分钟", gs.clampGreetInterval(undefined) === 20);
check("非法输入回落 20", gs.clampGreetInterval("不是数字") === 20);
check("1 分钟原样保留（控制面板 min=1，两端必须一致）", gs.clampGreetInterval(1) === 1);
check("低于 1 钳到 1", gs.clampGreetInterval(0) === 1);
check("负数钳到 1", gs.clampGreetInterval(-30) === 1);
check("高于 1440 钳到 1440", gs.clampGreetInterval(9999) === 1440);
check("字符串数字也认", gs.clampGreetInterval("30") === 30);
check("小数四舍五入", gs.clampGreetInterval(30.6) === 31);
check("分钟转毫秒", gs.greetIntervalMs(20) === 20 * MIN);

// ---- 从锚点起算 ----
const now = 1_700_000_000_000;
check("正常到期 = 锚点 + 间隔", gs.nextGreetingDueAt(now - 10 * MIN, 20, now, 0) === now + 10 * MIN);
check(
  "锚点很旧时至少等 5 秒（避免一启动就问候）",
  gs.nextGreetingDueAt(now - 999 * MIN, 20, now, 5000) === now + 5000,
);
check(
  "刚改完设置时按新间隔完整计时",
  gs.nextGreetingDueAt(gs.greetingAnchorAfterReset(now), 60, now, 0) === now + 60 * MIN,
);

// ---- 到点判断 ----
check("差 1ms 不算到点", gs.hasGreetingIntervalElapsed(now, 20, now + 20 * MIN - 1) === false);
check("正好到点算到点", gs.hasGreetingIntervalElapsed(now, 20, now + 20 * MIN) === true);
check("超过也算到点", gs.hasGreetingIntervalElapsed(now, 20, now + 25 * MIN) === true);

// ---- 关键回归：改设置后不能继续沿用旧锚点 ----
{
  const anchorNow = gs.greetingAnchorAfterReset(now);
  const due = gs.nextGreetingDueAt(anchorNow, 45, now, 0);
  check("★ 改成 45 分钟后从改完这一刻重新计时", due === now + 45 * MIN, String(due - now));
  check("★ 不会按旧的 20 分钟提前触发", gs.hasGreetingIntervalElapsed(anchorNow, 45, now + 20 * MIN) === false);
}

console.log("greeting-schedule: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
