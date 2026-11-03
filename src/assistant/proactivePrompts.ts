/**
 * 主动问候 / 抽卡点评的 prompt 组装（纯函数，可直接单测）。
 *
 * 这两条都是"临时 history、不进主对话历史"的轻量调用，且都要求
 * 「原文 + --- + 中文翻译」的格式，所以共用同一套语言指令。
 *
 * **这里的位置是硬性要求**：语言提醒必须排在所有中文要求的**最后一行**。
 *
 * 以前的写法是把语言指令放在 prompt 中段，后面还跟着"要求：简短（1-2句）、
 * 口语化、不要像客服"这类中文 —— 模型顺着最近的中文继续写，于是：
 *   1. 定时问候偶尔整句说中文；
 *   2. 第一行写成中文、`---` 也丢了。
 * 而 TTS 只朗读 `---` 之前的部分（见 TTSPlayer.pushDelta），丢了分隔符就把中文
 * 一起念出来 —— 用户听到的就是"他在说中文"。
 *
 * 单纯把指令挪到最后还不够稳，所以这里是双保险：
 *   · 用户消息末尾 → buildLanguageReminder（模型对末尾最敏感）
 *   · system 侧     → proactiveLangInstruction（走 chatStream 的 extraContext）
 */

import { buildLanguageInstruction, buildLanguageReminder } from "../utils/outputLanguage";

export interface GreetingPromptParts {
  /** 例如 "2026/10/7 09:32:42" */
  timeStr: string;
  /** 例如 "星期三" */
  dayOfWeek: string;
  /** 兼容旧调用：窗口上下文字符串 */
  ctx?: string;
  /** 前台窗口检查结果（优先于 ctx） */
  windowInfo?: string;
  /** 本轮是否成功附上屏幕截图 */
  screenshotAvailable?: boolean;
  /** 已格式化的记忆块（含前导换行），可为空 */
  memoryBlock: string;
  /** 心情低谷时的安慰模式说明（含前导换行），可为空 */
  comfortLine: string;
  outputLanguage: string;
  /** 上一次用户没回复的问候（有则有更强的换话题约束） */
  previousGreeting?: { summary?: string; greeting: string } | null;
  /** 今天已经问候过的话题摘要（用于避免一天内反复说同一件事） */
  recentGreetingTopics?: string[];
}

/**
 * 主动问候的用户消息。
 *
 * 问候前固定由前端并发调用两个工具：`capture_screen` + `active_window_title`。
 * 模型要结合两个来源先做内部总结，再生成问候；同时输出 JSON，便于我们单独保存
 * summary（判断下次问候是否在重复话题），气泡里只显示 greeting。
 *
 * 语言提醒固定收尾，**不要**在它后面再拼任何中文要求。
 */
export function buildGreetingPrompt(p: GreetingPromptParts): string {
  const windowInfo = (p.windowInfo ?? p.ctx ?? "").trim();
  const head = `[主动问候] ${p.timeStr}（${p.dayOfWeek}）`;
  const sources =
    "\n【本轮两个信息来源】\n" +
    `- 窗口检查：${windowInfo || "没有拿到具体前台软件（可能主人在桌面，或前台就是桌宠自己）"}\n` +
    `- 屏幕截图：${p.screenshotAvailable ? "已附上当前屏幕截图，请结合画面判断" : "本次没有拿到截图，只能保守地依据窗口检查"}`;
  const prev = p.previousGreeting
    ? "\n【上一次问候用户没有回复】\n" +
      `- 上次观察到的内容：${(p.previousGreeting.summary || "（没有摘要）").trim()}\n` +
      `- 上次说：${p.previousGreeting.greeting.trim()}\n`
    : "";
  const recent = (p.recentGreetingTopics ?? []).length
    ? "\n【今天已经问候过的话题】\n" +
      (p.recentGreetingTopics ?? []).map((t, i) => `${i + 1}. ${t}`).join("\n") + "\n"
    : "";
  const body =
    "请先完成一次内部判断：结合「窗口检查」和「屏幕截图」两个来源，判断主人此刻正在做什么、状态如何。" +
    "两个来源冲突时以窗口检查为主、截图补充细节；拿不准就说得保守，不要编造。" +
    "如果窗口检查写的是桌面，不要猜成文件管理器/资源管理器。\n" +
    "然后写一句自然的主动问候，保持你的人设风格。\n\n" +
    "硬性要求：\n" +
    "1. 不要提\"截图 / 窗口 / 工具 / 系统 / 检测到\"这类字眼，也不要说\"作为AI\"之类的话。\n" +
    "2. 问候简短（1-2句）、口语化、不要像客服。\n" +
    "3. 如果上一次问候用户没有回复：除非本次观察到的内容与上次主题明确相关，否则必须换一个完全不同的话题；不要重复上次的句子、关注点或提问方式。\n" +
    "4. 今天已经问候过的话题也不要反复说；只有和本次观察确实相关时才可延续。\n" +
    "5. 只输出一个 JSON 对象，不要 Markdown 代码块、不要额外解释；键名固定为 summary 和 greeting，不要翻译：\n" +
    "{\"summary\":\"本轮观察摘要（中文，1-2句，内部记录用）\",\"greeting\":\"要发给用户的问候\"}";
  return `${head}${sources}${p.memoryBlock}${p.comfortLine}${prev}${recent}\n\n${body}${trailingReminder(p.outputLanguage)}`;
}

export interface GreetingResult {
  /** 内部观察摘要；解析失败时为空串 */
  summary: string;
  /** 实际发给用户的问候；解析失败时回退为模型原文 */
  greeting: string;
  /** 是否成功解析出 JSON */
  parsed: boolean;
}

/**
 * 解析问候模型的 JSON 输出。模型偶尔会包 ```json 代码块或前后多说一句，
 * 这里做宽松解析；完全解析不了就整段当问候，至少不让问候失败。
 */
export function parseGreetingResult(raw: string): GreetingResult {
  const text = (raw || "").trim();
  if (!text) return { summary: "", greeting: "", parsed: false };
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const tryParse = (candidate: string): unknown => {
    try { return JSON.parse(candidate); } catch { return null; }
  };
  let obj = tryParse(cleaned);
  if (!obj) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) obj = tryParse(cleaned.slice(start, end + 1));
  }
  const o = obj as { summary?: unknown; greeting?: unknown; text?: unknown; message?: unknown } | null;
  if (o && typeof o === "object") {
    const greetingRaw = typeof o.greeting === "string" ? o.greeting : typeof o.text === "string" ? o.text : typeof o.message === "string" ? o.message : "";
    const greeting = greetingRaw.trim();
    if (greeting) {
      const summary = typeof o.summary === "string" ? o.summary.trim() : "";
      return { summary, greeting, parsed: true };
    }
  }

  // 模型有时会在 JSON 字符串里塞未转义的换行，导致 JSON.parse 失败。
  // 这里再按字段名做一次宽松提取，至少把 greeting 从代码块里救出来。
  const extractField = (field: string): string => {
    const re = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "i");
    const m = re.exec(cleaned);
    if (!m) return "";
    return m[1]
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .trim();
  };
  const looseGreeting = extractField("greeting");
  if (looseGreeting) {
    return { summary: extractField("summary"), greeting: looseGreeting, parsed: true };
  }
  return { summary: "", greeting: text, parsed: false };
}

export interface CardCommentParts {
  rarity: string;
  theme: string;
  baseText: string;
  aiText: string;
}

/** 抽卡点评的用户消息。语言提醒固定收尾。 */
export function buildCardCommentPrompt(card: CardCommentParts, outputLanguage: string): string {
  let cardInfo = `主题「${card.theme}」，祝福语：${card.baseText}`;
  if (card.aiText !== card.baseText) cardInfo += `，AI文案：${card.aiText}`;
  const body =
    `[抽卡点评] 刚才用户抽到了一张 ${card.rarity} 卡，${cardInfo}。` +
    "用你的人设风格对这张卡发表一句简短的点评或吐槽（1-2句），保持口语化，" +
    "不要复述祝福语。直接对用户说话。";
  return `${body}${trailingReminder(outputLanguage)}`;
}

/**
 * system 侧的语言指令（作为 chatStream 的 extraContext 传入）。
 * 和末尾提醒一起构成双保险：system 里定性，末尾提醒压制最近的中文语境。
 */
export function proactiveLangInstruction(outputLanguage: string): string {
  return buildLanguageInstruction(outputLanguage, { withTranslation: true });
}

/** 收尾提醒：非中文时前面补一个换行，中文/自动时返回空串（不改变原有排版） */
function trailingReminder(outputLanguage: string): string {
  const reminder = buildLanguageReminder(outputLanguage, { withTranslation: true });
  return reminder ? `\n${reminder}` : "";
}
