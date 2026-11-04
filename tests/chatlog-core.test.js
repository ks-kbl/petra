/**
 * 聊天记录页纯逻辑测试（src-tauri/panel/chatlog-core.cjs）
 * 之前这页全是内联 JS，只能靠截图看；这里把它能断言的部分锁住。
 */
const cl = require("../src-tauri/panel/chatlog-core.cjs");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

const at = (y, m, d, h = 10, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();

// ---------- 日期 ----------
check("dayKey 本地自然日", cl.dayKey(at(2026, 11, 4, 23, 59)) === "2026-11-04");
check("dayKey 跨零点", cl.dayKey(at(2026, 11, 5, 0, 1)) === "2026-11-05");
check("weekOf 周三", cl.weekOf("2026-11-04") === "周三");
check("timeText 补零", cl.timeText(at(2026, 11, 4, 9, 5)) === "09:05");
check("timeText 无时间戳返回空", cl.timeText(0) === "");
check("dayKey 非法输入不炸", cl.dayKey("abc") === "");

// ---------- 清洗 ----------
const withReminder = "我下周要交论文\n[系统提醒：你必须用日语回复，不要用中文]";
check("去掉语言提醒行", cl.stripReminder(withReminder) === "我下周要交论文");
check("没有提醒行不变", cl.stripReminder("普通消息") === "普通消息");

const trans = cl.splitTranslation("原文内容\n---\n中文翻译");
check("拆分原文与翻译", trans.main === "原文内容" && trans.trans === "中文翻译");
check("没有分隔符时整段是原文", cl.splitTranslation("只有原文").trans === "");

// ---------- 消息分类 ----------
check("识别用户消息", cl.isChat({ role: "user", content: "hi" }) === true);
check("空内容不算对话", cl.isChat({ role: "assistant", content: "  " }) === false);
check("工具消息单独归类", cl.isTool({ role: "tool", content: "结果" }) === true);
check("识别问候", cl.isGreeting({ role: "assistant", content: "【问候】下午好" }) === true);
check("普通回复不是问候", cl.isGreeting({ role: "assistant", content: "下午好" }) === false);

// ---------- 按天分组 ----------
const msgs = [
  { role: "user", content: "今天的", ts: at(2026, 11, 4, 9, 0) },
  { role: "assistant", content: "今天的回复", ts: at(2026, 11, 4, 9, 1) },
  { role: "tool", content: "搜索结果", ts: at(2026, 11, 4, 9, 2) },
  { role: "user", content: "昨天的", ts: at(2026, 11, 3, 20, 0) },
  { role: "assistant", content: "没有时间戳", ts: 0 },
  { role: "system", content: "系统消息会被丢掉", ts: at(2026, 11, 4, 9, 0) },
];
const g = cl.groupByDay(msgs, "2026-11-01", "2026-11-04");
check("今天 3 条（含工具）", g.byDay.get("2026-11-04").length === 3, "len=" + g.byDay.get("2026-11-04").length);
check("昨天单独一组", g.byDay.get("2026-11-03").length === 1);
check("无时间戳进 undated", g.undated === 1);
check("系统消息被忽略", [...g.byDay.values()].flat().every((m) => m.role !== "system"));
check("统计工具条数", g.toolCount === 1);
const shuffled = cl.groupByDay([
  { role: "assistant", content: "后", ts: at(2026, 11, 4, 12, 0) },
  { role: "user", content: "前", ts: at(2026, 11, 4, 8, 0) },
], "2026-11-01", "2026-11-04");
check("同一天内按时间排序", shuffled.byDay.get("2026-11-04")[0].content === "前");
const g2 = cl.groupByDay(msgs, "2026-11-04", "2026-11-04");
check("30 天窗口外进 undated", g2.undated === 2, "undated=" + g2.undated);

// ---------- 搜索 ----------
const list = [
  { role: "user", content: "论文下周要交", ts: 1 },
  { role: "assistant", content: "记得早点开始", ts: 2 },
];
check("按关键词过滤", cl.filterByQuery(list, "论文").length === 1);
check("大小写不敏感", cl.filterByQuery([{ role: "user", content: "Rust 真香", ts: 1 }], "rust").length === 1);
check("空查询返回全部", cl.filterByQuery(list, "  ").length === 2);

const segs = cl.highlightSegments("论文要交，论文别拖", "论文");
check("命中分段正确", segs.filter((s) => s.hit).length === 2);
check("分段拼回原文", segs.map((s) => s.text).join("") === "论文要交，论文别拖");
check("无命中返回整段", cl.highlightSegments("别的", "论文").length === 1);

// ---------- 导出 ----------
const md = cl.buildMarkdown(
  [
    { role: "user", content: "论文下周要交\n[系统提醒：用日语回复]", ts: at(2026, 11, 4, 9, 5) },
    { role: "assistant", content: "【问候】下午好", ts: at(2026, 11, 4, 9, 6) },
    { role: "tool", content: "工具噪音", ts: at(2026, 11, 4, 9, 7) },
  ],
  "2026-11-04 周三",
);
check("导出带标题", md.startsWith("# Petra 聊天记录 · 2026-11-04 周三"));
check("导出带角色与时间", md.includes("**你** · 09:05") && md.includes("**Petra** · 09:06"));
check("导出不含提醒行", !md.includes("系统提醒"));
check("导出去掉问候标记", !md.includes("【问候】"));
check("导出不含工具噪音", !md.includes("工具噪音"));

// ---------- 统计 ----------
const stats = cl.dayStats([
  { role: "user", content: "a", ts: at(2026, 11, 4, 9, 0) },
  { role: "assistant", content: "b", ts: at(2026, 11, 4, 21, 30) },
  { role: "tool", content: "c", ts: at(2026, 11, 4, 12, 0) },
]);
check("统计对话与工具条数", stats.chats === 2 && stats.tools === 1);
check("统计首末时间", stats.first === "09:00" && stats.last === "21:30");

console.log("chatlog-core: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
