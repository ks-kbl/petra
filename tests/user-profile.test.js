/**
 * 用户画像测试：
 * - 空画像绝不往 prompt 里塞空壳
 * - 画像块只写"这个人"，不漏内部字段（条数/版本），并带上"侧面体现"的使用规则
 * - 什么时候该重算（首次 3 条、之后每 6 条新素材、跨 12 小时补算）
 * - 模型输出宽容解析：```json 包裹 / 缺字段 / 脏数据都不许写坏档案
 */
const up = require("./build/assistant/userProfile.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

// ---------- 空画像 ----------
check("空画像不进 prompt", up.profileBlock(up.emptyProfile()) === "");
check("null 不炸", up.profileBlock(null) === "");
check("undefined 不炸", up.profileBlock(undefined) === "");

// ---------- 画像块 ----------
const prof = {
  narrative: "主人是个做后端的，作息偏晚，喜欢被直接说结论，讨厌被问工作细节。",
  facts: {
    nickname: "老王",
    occupation: "后端工程师",
    schedule: "凌晨一两点睡",
    interests: ["科幻小说", "爬山"],
    tools: ["VS Code"],
    communication: "直接说结论，别客套",
    avoid: ["催婚"],
    recentFocus: "在改一个接口",
  },
  updatedAt: 1,
  version: 3,
  memoriesSeen: 12,
};
const block = up.profileBlock(prof);
check("画像块含自述", block.includes("主人是个做后端的"));
check("画像块含称呼", block.includes("老王"));
check("画像块含雷区", block.includes("催婚"));
check("画像块含最近关注", block.includes("在改一个接口"));
check("不漏 memoriesSeen 内部字段", !block.includes("memoriesSeen") && !block.includes("12 条"));
check("不漏 version 内部字段", !block.includes("version") && !block.includes("第 3 版"));
check("带使用规则：不要复述", block.includes("不要复述这份材料"));
check("带使用规则：不要说根据我的记忆", block.includes("根据我的记忆"));
check("带使用规则：不用每次都提", block.includes("一天里偶尔一两次"));
check("带使用规则：没把握要试探", block.includes("你好像"));
check("空数组字段不产生空行", !block.includes("在意/喜欢的：\n"));

// ---------- 什么时候该重算 ----------
const now = new Date(2026, 10, 4, 12, 0).getTime();
check("没有记忆不重算", up.shouldSynthesize(up.emptyProfile(), 0, now) === false);
check("素材不足 3 条不重算", up.shouldSynthesize(up.emptyProfile(), 2, now) === false);
check("攒到 3 条首次合成", up.shouldSynthesize(up.emptyProfile(), 3, now) === true);

const built = { ...prof, updatedAt: now - 3600 * 1000, memoriesSeen: 10 };
check("新素材不足 6 条不重算", up.shouldSynthesize(built, 15, now) === false);
check("攒够 6 条重算", up.shouldSynthesize(built, 16, now) === true);
const stale = { ...prof, updatedAt: now - 13 * 3600 * 1000, memoriesSeen: 10 };
check("跨 12 小时且有新素材补算", up.shouldSynthesize(stale, 11, now) === true);
check("跨 12 小时但没新素材不算", up.shouldSynthesize(stale, 10, now) === false);

// ---------- 提炼 prompt ----------
const msgs = up.buildProfileMessages(
  [
    { content: "用户叫小明", category: "identity", importance: 1, createdAt: new Date(2026, 9, 1).getTime() },
    { content: "用户凌晨两点睡", category: "habit", importance: 2 },
  ],
  up.emptyProfile(),
);
check("提炼 prompt 有 system", msgs[0].role === "system" && msgs[0].content.includes("只输出 JSON"));
check("提炼 prompt 禁止编造", msgs[0].content.includes("绝对不要编造"));
check("提炼 prompt 冲突以新的为准", msgs[0].content.includes("以新的为准"));
check("素材带日期与类别", msgs[1].content.includes("2026-10-01") && msgs[1].content.includes("[identity]"));
check("首次整理有说明", msgs[1].content.includes("第一次整理"));
// 素材过多时不能整份塞进去（长期使用能累积到 200 条）
const many = Array.from({ length: 200 }, (_, i) => ({
  content: "记忆" + i,
  category: "other",
  importance: i % 5 === 0 ? 1 : 3,
  createdAt: 1000 + i,
}));
const capMsgs = up.buildProfileMessages(many, prof);
const capLines = capMsgs[1].content.split("\n").filter((l) => l.startsWith("- ")).length;
check("素材超 120 条会裁剪", capLines <= up.PROFILE_MAX_MEMORIES, "lines=" + capLines);
check("裁剪后仍保留核心记忆", capMsgs[1].content.includes("记忆0"));

const msgs2 = up.buildProfileMessages([], prof);
check("有旧档案时带旧档案", msgs2[1].content.includes("旧档案") && msgs2[1].content.includes("主人是个做后端的"));

// ---------- 解析模型输出 ----------
const okJson = JSON.stringify({
  narrative: "主人最近在赶一个后端接口，晚上精神最好，说话喜欢直接。",
  facts: { nickname: "小明", occupation: "后端", schedule: "", interests: ["机械键盘"], tools: [], communication: "直接", avoid: [], recentFocus: "赶接口" },
});
const parsed = up.parseProfileResponse("```json\n" + okJson + "\n```", up.emptyProfile(), 7, now);
check("能解析 ```json 包裹", !!parsed && parsed.narrative.includes("赶一个后端接口"));
check("解析结果记 memoriesSeen", !!parsed && parsed.memoriesSeen === 7);
check("解析结果记版本", !!parsed && parsed.version === 1);
check("解析结果记时间", !!parsed && parsed.updatedAt === now);
check("解析出 facts", !!parsed && parsed.facts.nickname === "小明" && parsed.facts.interests[0] === "机械键盘");

const parsed2 = up.parseProfileResponse("好的，这是新档案：\n" + okJson + "\n希望对你有帮助", up.emptyProfile(), 3, now);
check("容忍前后寒暄", !!parsed2 && parsed2.narrative.length > 0);

check("脏数据返回 null", up.parseProfileResponse("模型今天不想干活", up.emptyProfile(), 3, now) === null);
check("缺 narrative 返回 null", up.parseProfileResponse('{"facts":{"nickname":"x"}}', up.emptyProfile(), 3, now) === null);
check("空字符串返回 null", up.parseProfileResponse("", up.emptyProfile(), 3, now) === null);

// 新结果里没提到的字段保留旧值：这次没说 ≠ 事实变了
const keep = up.parseProfileResponse(
  JSON.stringify({ narrative: "换了段描述", facts: { nickname: "", occupation: "", interests: [], recentFocus: "" } }),
  prof,
  20,
  now,
);
check("空字段回退旧值", !!keep && keep.facts.nickname === "老王" && keep.facts.occupation === "后端工程师");
check("旧兴趣保留", !!keep && keep.facts.interests.join() === "科幻小说,爬山");
check("recentFocus 允许清空", !!keep && keep.facts.recentFocus === "");
check("版本递增", !!keep && keep.version === prof.version + 1);

// ---------- 存档兼容 ----------
check("垃圾存档归一为空画像", up.normalizeProfile("???") .narrative === "" && up.normalizeProfile(null).version === 0);
const partial = up.normalizeProfile({ narrative: "x", facts: { interests: "not-array" } });
check("字段类型不对不炸", partial.narrative === "x" && Array.isArray(partial.facts.interests) && partial.facts.interests.length === 0);
check("字符串数组过滤空值", up.normalizeProfile({ facts: { interests: ["a", "", 3, "b"] } }).facts.interests.join() === "a,b");

console.log("user-profile: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
