/**
 * 小助手工具调用运行时测试（纯逻辑，不需要浏览器/API）：
 * - 参数校验：未知工具 / 缺必填参数 / 空串 / 数字 0
 * - 结果截断：默认上限 + 按工具覆盖
 * - 参数解析：非法 JSON / 数组 / 空串都要有明确结果
 * - 调用指纹：键顺序无关，用于识别重复调用
 * - 循环预算：轮数、次数、重复提示、收尾说明
 * - 气泡停留时长：按字数给时间，短句/长文/封顶
 * - 模型列表解析：OpenAI 的 data[] 与 Ollama 的 models[]
 *
 * 运行：npm run test:assistant
 */
const fs = require("fs");
const path = require("path");
const rt = require("./build/assistant/toolRuntime.js");
const ac = require("./load-assistant-client.js");
const cs = require("./build/assistant/chatSummary.js");
const mn = require("./build/assistant/memoryNudge.js");
const ak = require("./build/assistant/apiKey.js");
const bt = require("./build/ui/bubbleTiming.js");
const ee = require("./build/assistant/EmotionEngine.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

// ---------- 工具清单 ----------
check("工具清单非空", rt.toolNames().length >= 18, rt.toolNames().length + " 个");
check("认识的工具", rt.isKnownTool("run_shell") && rt.isKnownTool("view_diary") && rt.isKnownTool("search_chat_history"));
check("不认识编造的工具", !rt.isKnownTool("get_time") && !rt.isKnownTool("browse_web"));

// ---------- 参数校验 ----------
const unknown = rt.validateToolArgs("get_time", {});
check("未知工具被拦下", unknown.ok === false);
check("未知工具提示带可用工具", !unknown.ok && unknown.message.includes("未知工具") && unknown.message.includes("run_shell") && unknown.message.includes("不要编造"));

const miss = rt.validateToolArgs("run_shell", {});
check("缺必填参数被拦下", miss.ok === false && miss.message.includes("缺少必填参数") && miss.message.includes("command"));
const blank = rt.validateToolArgs("open_url", { url: "   " });
check("空字符串算缺失", blank.ok === false);
const zero = rt.validateToolArgs("set_reminder", { minutes: 0, message: "喝 water" });
check("数字 0 不算缺失", zero.ok === true);
check("无必填参数的工具通过", rt.validateToolArgs("get_weather", {}).ok === true);
check("参数齐全通过", rt.validateToolArgs("run_shell", { command: "dir" }).ok === true);
check("每个工具都有规格", rt.toolNames().every((n) => typeof rt.TOOL_SPECS[n] === "object"));

// ---------- 结果截断 ----------
const short = "ok: 3 files";
check("短结果不动", rt.truncateToolResult("run_shell", short) === short);

const long = "A".repeat(3000) + "中".repeat(3000) + "Z".repeat(3000);
const cut = rt.truncateToolResult("get_weather", long);
check("长结果被截断", cut.length < long.length);
check("截断有省略提示", cut.includes("省略"));
check("截断保留开头", cut.startsWith("A"));
check("截断保留结尾", cut.endsWith("Z"));
check("截断长度接近上限", cut.length <= rt.TOOL_SPECS.get_weather.maxResultChars + 60, String(cut.length));

const medium = "x".repeat(3000);
check("按工具覆盖上限（run_shell 4000 不截断）", rt.truncateToolResult("run_shell", medium) === medium);
check("默认上限对无配置工具生效", rt.truncateToolResult("set_volume", "y".repeat(3000)).includes("省略"));

// ---------- 参数解析 ----------
const okArgs = rt.parseArgsSafe('{"command":"dir"}');
check("合法 JSON 解析", okArgs.error === undefined && okArgs.args.command === "dir");
const emptyArgs = rt.parseArgsSafe("");
check("空参数不报错", emptyArgs.error === undefined && Object.keys(emptyArgs.args).length === 0);
const badArgs = rt.parseArgsSafe('{"command": "dir"');
check("非法 JSON 有原因", typeof badArgs.error === "string" && badArgs.error.includes("JSON"), String(badArgs.error));
check("非法 JSON 参数退化为空对象", Object.keys(badArgs.args).length === 0);
const arrArgs = rt.parseArgsSafe("[1,2]");
check("数组参数被拒", typeof arrArgs.error === "string" && arrArgs.error.includes("JSON 对象"));

// ---------- 错误措辞 ----------
const errText = rt.formatToolError("open_path", "路径不存在", "请确认路径后重试");
check("错误文本含工具名/原因/提示", errText.includes("open_path") && errText.includes("路径不存在") && errText.includes("提示："));
check("没有提示时不加提示行", !rt.formatToolError("open_path", "路径不存在").includes("提示："));

// ---------- 调用指纹 ----------
check("指纹与键顺序无关", rt.callSignature("set_volume", { level: 1, mute: false }) === rt.callSignature("set_volume", { mute: false, level: 1 }));
check("指纹区分参数", rt.callSignature("set_volume", { level: 1 }) !== rt.callSignature("set_volume", { level: 2 }));

// ---------- 循环预算 ----------
const b = new rt.ToolLoopBudget({ maxRounds: 3, maxCalls: 4 });
check("轮数预算可达上限", b.nextRound() && b.nextRound() && b.nextRound() && !b.nextRound());
check("初始剩余次数", new rt.ToolLoopBudget({ maxCalls: 4 }).remainingCalls() === 4);

const b2 = new rt.ToolLoopBudget({ maxRounds: 5, maxCalls: 2 });
check("首次调用无提示", b2.noteCall("get_weather", {}) === "");
check("重复调用给提示", b2.noteCall("get_weather", {}).includes("不要重复调用"));
check("次数预算用尽", b2.canCall() === false && b2.remainingCalls() === 0);
check("用尽后有收尾说明", b2.exhaustedNote().includes("上限"));
check("还有余量时没有收尾说明", new rt.ToolLoopBudget({ maxCalls: 9 }).exhaustedNote() === "");
check("不同参数不误判重复", new rt.ToolLoopBudget({ maxCalls: 9 }).noteCall("get_weather", { city: "上海" }) === "" && new rt.ToolLoopBudget({ maxCalls: 9 }).noteCall("get_weather", { city: "北京" }) === "");

// ---------- 与模型可见的工具表对齐 ----------
// 如果运行时表里少了某个工具，模型一调用就会被当成"未知工具"拦下，所以这里做交叉检查。
const clientSrc = fs.readFileSync(path.join(__dirname, "..", "src", "assistant", "AssistantClient.ts"), "utf8");
const declared = [...clientSrc.matchAll(/^ {6}name: "([a-z_]+)",$/gm)].map((m) => m[1]);
check("能从源码里读出工具表", declared.length >= 18, declared.length + " 个");
const missingSpec = declared.filter((n) => !rt.isKnownTool(n));
check("每个模型可见的工具都有运行时规格", missingSpec.length === 0, missingSpec.join(","));
const extraSpec = rt.toolNames().filter((n) => !declared.includes(n));
check("运行时表里没有多余工具", extraSpec.length === 0, extraSpec.join(","));
check("空文本给最短时间", bt.readingHoldMs("") === 3000, String(bt.readingHoldMs("")));
check("纯空白也算空", bt.readingHoldMs("   ") === 3000);
check("短句按最短 3 秒", bt.readingHoldMs("好") === 3035, String(bt.readingHoldMs("好")));
check("50 字给 4.75 秒", bt.readingHoldMs("x".repeat(50)) === 4750, String(bt.readingHoldMs("x".repeat(50))));
check("100 字给 6.5 秒", bt.readingHoldMs("x".repeat(100)) === 6500, String(bt.readingHoldMs("x".repeat(100))));
check("长文封顶 10 秒", bt.readingHoldMs("x".repeat(400)) === 10000, String(bt.readingHoldMs("x".repeat(400))));
check("可自定义基数（报错提示留久一点）", bt.readingHoldMs("x", 8000) === 8035, String(bt.readingHoldMs("x", 8000)));
check("最短不超过封顶", bt.BUBBLE_HOLD_MIN_MS <= bt.BUBBLE_HOLD_MAX_MS);

// ---------- 气泡配色兜底（识别不到情绪时用心情上色，避免一片白）----------
check("心情好 → 暖黄", ee.moodFallbackEmotion({ happiness: 0.8, energy: 0.5 }) === "happy");
check("心情低落 → 关心色", ee.moodFallbackEmotion({ happiness: 0.2, energy: 0.5 }) === "worried");
check("精力不足 → 疲惫色", ee.moodFallbackEmotion({ happiness: 0.5, energy: 0.1 }) === "tired");
check("平淡期 → 暖粉", ee.moodFallbackEmotion({ happiness: 0.5, energy: 0.5 }) === "love");
check("边界：0.6 算好", ee.moodFallbackEmotion({ happiness: 0.6, energy: 0.5 }) === "happy");
check("边界：0.38 算低落", ee.moodFallbackEmotion({ happiness: 0.38, energy: 0.5 }) === "worried");
check("边界：0.39 + 精力足 → 暖粉", ee.moodFallbackEmotion({ happiness: 0.39, energy: 0.31 }) === "love");
check(
  "兜底永远不会是 neutral（这才是'颜色不显现'的修复点）",
  [
    { happiness: 0, energy: 0 },
    { happiness: 0.5, energy: 0.5 },
    { happiness: 1, energy: 1 },
  ].every((m) => ee.moodFallbackEmotion(m) !== "neutral"),
);

// ---------- 模型列表解析（OpenAI 格式 / Ollama 原生格式）----------
check(
  "OpenAI 的 data[].id",
  JSON.stringify(ac.parseModelList({ data: [{ id: "gpt-4o-mini" }, { id: "deepseek-chat" }] })) ===
    JSON.stringify(["gpt-4o-mini", "deepseek-chat"]),
);
check(
  "Ollama 的 models[].name",
  JSON.stringify(ac.parseModelList({ models: [{ name: "qwen2.5:7b" }, { model: "llama3:8b" }, { id: "plain" }] })) ===
    JSON.stringify(["qwen2.5:7b", "llama3:8b", "plain"]),
);
check("空对象返回空数组", ac.parseModelList({}).length === 0);
check("null / undefined 不炸", ac.parseModelList(null).length === 0 && ac.parseModelList(undefined).length === 0);
check("过滤掉空 id", JSON.stringify(ac.parseModelList({ data: [{ id: "" }, { id: "ok" }] })) === JSON.stringify(["ok"]));
check("data 不是数组时返回空", ac.parseModelList({ data: "nope" }).length === 0);

// ---------- 供应商就绪判断（免 Key 的本地模型不能被当成"没配置"）----------
check("ollama 免 Key", ac.isKeylessProvider("ollama") === true);
check("openai 需要 Key", ac.isKeylessProvider("openai") === false);
check("自定义指向 127.0.0.1 免 Key", ac.isKeylessProvider("custom", "http://127.0.0.1:1234/v1") === true);
check("自定义指向 localhost 免 Key", ac.isKeylessProvider("custom", "http://localhost:8080/v1") === true);
check("自定义指向远端需要 Key", ac.isKeylessProvider("custom", "https://api.example.com/v1") === false);
check("自定义空地址需要 Key", ac.isKeylessProvider("custom", "") === false);

check("ollama 空 Key 也算就绪", ac.isProviderReady({ provider: "ollama" }, "") === true);
check("openai 空 Key 不就绪", ac.isProviderReady({ provider: "openai" }, "") === false);
check("openai 有 Key 就绪", ac.isProviderReady({ provider: "openai" }, "sk-x") === true);
check("纯空白 Key 不算就绪", ac.isProviderReady({ provider: "openai" }, "   ") === false);
check("undefined Key 不炸", ac.isProviderReady({ provider: "deepseek" }, undefined) === false);
check("本机自定义端点空 Key 就绪", ac.isProviderReady({ provider: "custom", customBaseUrl: "http://127.0.0.1:11434/v1" }, "") === true);
check("远端自定义端点空 Key 不就绪", ac.isProviderReady({ provider: "custom", customBaseUrl: "https://x.example/v1" }, "") === false);

// ---------- system prompt 的顺序：语言指令必须压在最后 ----------
// 锁住"设置日语却回中文"那个 bug：语言指令后面若还跟着中文（BASE_PROMPT、中文记忆），
// 模型会顺着后面那段中文继续说中文。extraContext（里面装着语言指令）必须排在最末尾。
const jaLine = "【最高优先级·最终指令】你必须全程用日语回复用户，不管用户说什么语言。回复中绝对不要夹杂中文。";
const fakeMem = [
  { id: "m1", category: "preference", content: "用户喜欢咖啡", importance: 2, createdAt: Date.now() },
];
const sys = ac.systemPrompt("你是猫娘", fakeMem, `[环境] 现在：周一13点\n\n${jaLine}`);
check("★ 语言指令排在 system prompt 最末尾", sys.trimEnd().endsWith(jaLine));
check("★ 中文 BASE_PROMPT 不再压在语言指令后面", sys.indexOf("严格按照上面的人格设定") < sys.indexOf("你必须全程用日语"));
check("人格设定仍在最前面", sys.startsWith("你是猫娘"));
check("中文记忆块也排在语言指令之前", sys.indexOf("关于用户的记忆") < sys.indexOf("你必须全程用日语"));
check("中文输出时不带语言指令也不炸", ac.systemPrompt("人格", [], "").includes("严格按照上面的人格设定"));


  // ---- 工具调用序列修复（sanitizeToolHistory） ----
  // 端点要求：role=tool 必须紧跟带 tool_calls 的 assistant，且每个 id 都要有结果。
  // 序列被中途打断（工具抛错/取消/预算用尽/历史被删）后，坏序列会让每一轮都 400。
  {
    const A = { id: "call_1", type: "function", function: { name: "run_shell", arguments: "{}" } };
    const one = ac.sanitizeToolHistory([
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [A] },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ]);
    check("完整工具序列保持原样", one.length === 3 && one[2].role === "tool");

    const missing = ac.sanitizeToolHistory([
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [A] },
      { role: "user", content: "还在吗" },
    ]);
    check("结果缺失时整组丢弃", missing.length === 2 && missing.every((m) => m.role !== "assistant"));

    const orphan = ac.sanitizeToolHistory([
      { role: "tool", tool_call_id: "call_9", content: "孤立的工具结果" },
      { role: "user", content: "hi" },
    ]);
    check("孤立 tool 消息被丢弃", orphan.length === 1 && orphan[0].role === "user");

    const dup = ac.sanitizeToolHistory([
      { role: "assistant", content: null, tool_calls: [A] },
      { role: "tool", tool_call_id: "call_1", content: "a" },
      { role: "tool", tool_call_id: "call_1", content: "b" },
    ]);
    check("重复结果视为不完整整组丢弃", dup.length === 0);

    const two = ac.sanitizeToolHistory([
      { role: "assistant", content: null, tool_calls: [A, { id: "call_2", type: "function", function: { name: "x", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "a" },
      { role: "tool", tool_call_id: "call_2", content: "b" },
    ]);
    check("两个调用都有结果时保留整组", two.length === 3);
  }


  // ---- 偶发错误的重试策略 ----
  check("429 限流可重试", ac.isRetryableStatus(429) === true);
  check("5xx 可重试", ac.isRetryableStatus(502) === true && ac.isRetryableStatus(503) === true);
  check("408 可重试", ac.isRetryableStatus(408) === true);
  check("400/401/402/404 不重试", ![400, 401, 402, 404].some((s) => ac.isRetryableStatus(s)));

// ---------- 自定义端点 / 中转站兼容性 ----------
check("端点补齐 /v1", ak.normalizeOpenAIBase("https://relay.example.com") === "https://relay.example.com/v1");
check("端点去末尾斜杠", ak.normalizeOpenAIBase("https://relay.example.com/v1/") === "https://relay.example.com/v1");
check(
  "端点去掉完整 chat/completions",
  ak.normalizeOpenAIBase("https://relay.example.com/v1/chat/completions") === "https://relay.example.com/v1",
);
check(
  "端点去掉查询串/锚点后再补路径",
  ak.normalizeOpenAIBase("https://relay.example.com/v1/chat/completions?x=1#y") === "https://relay.example.com/v1",
);
check(
  "已有版本路径不被改写",
  ak.normalizeOpenAIBase("https://open.bigmodel.cn/api/paas/v4") === "https://open.bigmodel.cn/api/paas/v4",
);
check("空端点仍是空", ak.normalizeOpenAIBase("") === "");

check(
  "模型列表兼容字符串数组",
  JSON.stringify(ac.parseModelList(["gpt-4o", "qwen-max"])) === JSON.stringify(["gpt-4o", "qwen-max"]),
);
check(
  "模型列表兼容嵌套 data.models",
  JSON.stringify(ac.parseModelList({ data: { models: [{ model: "deepseek-chat" }] } })) ===
    JSON.stringify(["deepseek-chat"]),
);
check(
  "模型列表去重并忽略空值",
  JSON.stringify(ac.parseModelList({ data: [{ id: "a" }, { id: "" }, { id: "a" }] })) === JSON.stringify(["a"]),
);

const picked = ac.pickDefaultChatModel(["text-embedding-3-small", "gpt-4o-mini", "whisper-1", "tts-1"]);
check("自动选择会避开 embedding/tts/whisper", picked === "gpt-4o-mini", picked);
check("全是非对话模型时仍给一个候选", ac.pickDefaultChatModel(["tts-1", "dall-e-3"]) === "tts-1");
check("空模型列表返回空", ac.pickDefaultChatModel([]) === "");

check(
  "数组形式 content 不再拼成 [object Object]",
  ac.contentToText([{ type: "text", text: "你好" }, { type: "image_url", image_url: {} }, { type: "text", text: "呀" }]) === "你好呀",
);
check("字符串 content 原样返回", ac.contentToText("ok") === "ok");

const withTools = [
  { role: "user", content: "hi" },
  { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c1", content: "ok" },
  { role: "assistant", content: "结果是这样", tool_calls: [{ id: "c2", type: "function", function: { name: "y", arguments: "{}" } }] },
];
const stripped = ac.stripToolData(withTools);
check("纯文本降级时清掉 role=tool", stripped.every((m) => m.role !== "tool"));
check("纯文本降级时清掉 tool_calls", stripped.every((m) => !m.tool_calls));
check("有正文的 assistant 轮次保留", stripped.some((m) => m.content === "结果是这样"));

check("tools 相关 400 会触发无工具重试", ac.shouldRetryWithoutTools(400, '{"error":{"message":"tools are not supported"}}') === true);
check("普通 400 也兜底尝试一次", ac.shouldRetryWithoutTools(400, "Bad Request") === true);
check("401 不触发无工具重试", ac.shouldRetryWithoutTools(401, "tool unsupported") === false);
check("429 不触发无工具重试", ac.shouldRetryWithoutTools(429, "tools unsupported") === false);
check("stream 不支持会触发非流式重试", ac.shouldRetryNonStream(400, "stream is not supported") === true);
check("stream 参数无关错误不触发", ac.shouldRetryNonStream(400, "model not found") === false);

// ---------- 提醒闭环 / 旧任务不冒充当前状态 ----------
{
  const summary = {
    text: "聊了一会儿",
    coveredCount: 130,
    updatedAt: Date.now(),
    openLoops: ["计时两分钟", "等面试结果", "帮他改接口"],
  };
  const done = cs.completeOpenLoops(summary, ["计时两分钟"]);
  check("提醒完成后从 openLoops 移除", !done.openLoops.includes("计时两分钟"));
  check("无关的悬而未决保留", done.openLoops.includes("等面试结果") && done.openLoops.includes("帮他改接口"));
  check("没有命中时原对象不变", cs.completeOpenLoops(summary, ["完全不相关"]) === summary);
  check("用共同二元组匹配「两分钟到了」也能清掉「计时两分钟」", !cs.completeOpenLoops(summary, ["两分钟到了"]).openLoops.includes("计时两分钟"));
  const genericDone = cs.completeOpenLoops(summary, ["时间到了"], true);
  check("泛化提醒完成时至少移除一条短时任务", !genericDone.openLoops.includes("计时两分钟") && genericDone.openLoops.includes("等面试结果"));

  const stale = cs.sanitizeEphemeralTaskSummary({
    text: "用户让 Petra 倒计时两分钟。用户喜欢猫。",
    coveredCount: 200,
    updatedAt: 1,
    openLoops: ["计时两分钟", "等面试结果"],
  });
  check("旧摘要正文里的计时任务被清掉", !stale.text.includes("计时") && stale.text.includes("用户喜欢猫"));
  check("旧摘要 openLoops 里的计时任务被清掉", !stale.openLoops.includes("计时两分钟") && stale.openLoops.includes("等面试结果"));
  check("摘要块明确声明不是当前任务", cs.summaryBlock({ text: "以前聊过很多", coveredCount: 1, updatedAt: 1 }).includes("不是当前正在进行的任务"));
  const onlyTask = cs.sanitizeEphemeralTaskSummary({ text: "用户让 Petra 计时两分钟。", coveredCount: 200, updatedAt: 1, openLoops: ["计时两分钟"] });
  check("摘要只剩旧任务时整份失效并从历史重建", onlyTask.text === "" && onlyTask.coveredCount === 0);

  const now = Date.now();
  const oldNote = cs.expiredTaskNote([
    { role: "user", content: "给我倒计时2分钟", ts: now - 24 * 3600 * 1000 },
    { role: "assistant", content: "好的，两分钟后提醒你", ts: now - 24 * 3600 * 1000 },
    { role: "user", content: "今天天气怎么样", ts: now - 1000 },
  ], now);
  check("旧任务会被标记为过期", oldNote.includes("过期旧任务") && oldNote.includes("倒计时2分钟"));
  check("新消息不会被误标成过期", !oldNote.includes("今天天气怎么样"));
  check("没有旧任务时不注入提示", cs.expiredTaskNote([{ role: "user", content: "你好", ts: now - 1000 }], now) === "");

  check("「你在干什么」识别为当前状态问题", mn.isCurrentStateQuestion("你在干什么") === true);
  check("「现在几点了」识别为当前状态问题", mn.isCurrentStateQuestion("现在几点了") === true);
  check("回忆旧事不算当前状态问题", mn.isCurrentStateQuestion("你还记得上次让我计时吗") === false);
  check("nudge 明确禁止在问当前状态时提旧事", mn.nudgeBlock({ content: "计时两分钟" }).includes("绝对不要提这件旧事"));
  check("短时任务不进入顺口问一句", mn.pickOpenLoop({ lastAt: 0, day: "", countToday: 0 }, ["计时两分钟", "等面试结果"]) === "等面试结果");
  check("没有可问的旧事时返回空", mn.pickOpenLoop(null, ["计时两分钟"]) === "");
}

console.log("assistant-tools: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);