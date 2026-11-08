/**
 * 长对话的滚动摘要（纯函数，可单测）。
 *
 * 问题：buildMessages 只把最近 120 条 / 30000 字的聊天发给模型，更早的对话被直接切掉。
 * 聊上半天以后，模型开始"失忆"：前面说定的方案、用户交代过的偏好、没做完的事全忘了，
 * 表现得像换了一个人。记忆库只能补"关于用户的事实"，补不回"这次对话本身"。
 *
 * 做法：把被切掉的那部分旧对话压成一段摘要，每轮随 system prompt 带上。
 * - 只读不写历史：原对话仍然完整留在 chat-history 里，摘要只是给模型的"记忆提示"；
 * - 分批推进：用 coveredCount 记住"前多少条已经摘过了"，每次只摘要新被切掉的部分，
 *   和旧摘要合并成一份，不做二次压缩（避免摘要的摘要越压越糊）。
 */

export interface ChatSummary {
  /** 合并后的摘要正文（不含「悬而未决」那一行） */
  text: string;
  /**
   * 悬而未决的事：用户提过但还没收尾的（"接口还没改完""等面试结果"）。
   * 摘要时顺手抠出来，给「顺口问一句」当素材 —— 这类连续性比复述旧事实更打动人。
   */
  openLoops?: string[];
  /** 历史里前多少条已经被摘要覆盖（按 history 的原始下标计） */
  coveredCount: number;
  updatedAt: number;
}

/** 最近多少条对话始终原样保留，不进摘要（和 buildMessages 的窗口对齐） */
export const SUMMARY_KEEP_RECENT = 120;
/** 一次至少攒够多少条"被挤出窗口"的对话才值得跑一次摘要 */
export const SUMMARY_MIN_NEW = 30;

export function emptyChatSummary(): ChatSummary {
  return { text: "", coveredCount: 0, updatedAt: 0 };
}

export function normalizeChatSummary(raw: unknown): ChatSummary {
  if (!raw || typeof raw !== "object") return emptyChatSummary();
  const r = raw as Record<string, unknown>;
  const loops = Array.isArray(r.openLoops)
    ? r.openLoops.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean).slice(0, 6)
    : [];
  return {
    text: typeof r.text === "string" ? r.text.trim() : "",
    coveredCount: Number.isFinite(r.coveredCount) ? Math.max(0, Number(r.coveredCount)) : 0,
    updatedAt: Number.isFinite(r.updatedAt) ? Number(r.updatedAt) : 0,
    openLoops: loops,
  };
}

export interface MinimalMessage {
  role: string;
  content?: string | null;
}

/**
 * 取出这次该摘要的那一段：从 coveredCount 到"窗口起点"之间的对话。
 * 只留 user / assistant 的文字（tool 调用、tool 结果、空消息都是噪音）。
 */
export function collectSummarizable(
  history: MinimalMessage[],
  coveredCount: number,
  keepRecent: number = SUMMARY_KEEP_RECENT,
): { picked: { role: "user" | "assistant"; content: string }[]; nextCoveredCount: number } {
  const start = Math.max(0, Math.min(coveredCount, history.length));
  const end = Math.max(start, history.length - Math.max(0, keepRecent));
  const picked: { role: "user" | "assistant"; content: string }[] = [];
  for (let i = start; i < end; i++) {
    const m = history[i];
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const text = typeof m.content === "string" ? m.content.trim() : "";
    if (!text) continue;
    // 单条过长（比如贴了一大段代码）截断：摘要里要的是"聊了什么"，不是原文
    picked.push({ role: m.role, content: text.length > 400 ? text.slice(0, 400) + "…" : text });
  }
  return { picked, nextCoveredCount: end };
}

export function shouldSummarize(
  historyLength: number,
  summary: ChatSummary | null | undefined,
  keepRecent: number = SUMMARY_KEEP_RECENT,
  minNew: number = SUMMARY_MIN_NEW,
): boolean {
  const covered = summary?.coveredCount ?? 0;
  const windowStart = Math.max(0, historyLength - keepRecent);
  return windowStart - covered >= minNew;
}

/** 摘要 prompt：合并旧摘要 + 新对话，输出一段没有寒暄的事实性总结 */
export function buildSummaryMessages(
  picked: { role: "user" | "assistant"; content: string }[],
  prevText: string,
): { role: "system" | "user"; content: string }[] {
  const system =
    "你是一个对话摘要器。把给你的这段聊天记录压成一段摘要，供对方以后回忆这次对话时使用。\n" +
    "要点：\n" +
    "1. 保留事实：人物、名字、项目、时间、约定、做出的决定、用户的偏好和情绪、还没做完的事。\n" +
    "2. 去掉寒暄、重复、以及「好的」「嗯」这类没有信息量的对话。\n" +
    "3. 如果给了旧摘要，把旧摘要和这次的新内容合并成**一段**，不要分条、不要写成「旧摘要说…又说了…」。\n" +
    "4. 用中文，250 字以内，第三人称叙述，不要加标题、不要加任何前后缀说明。\n" +
    "5. 只写聊过的事实，不要评价、不要建议、不要编造没出现的信息。\n" +
    "6. 最后单独加一行，格式必须是「悬而未决：」开头，用「；」分隔列出用户提过但还没有结果的事（谁在等什么、什么没弄完、答应了什么）；没有就写「悬而未决：无」。这一行会被程序单独取走，不要写进上面的摘要正文。";
  const body =
    (prevText ? `已有的旧摘要：\n${prevText}\n\n` : "") +
    "新的对话记录：\n" +
    picked.map((m) => `${m.role === "user" ? "用户" : "助理"}：${m.content}`).join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: body },
  ];
}

/** 解析摘要输出：宽容处理模型爱加的前后缀，空/太短视为失败（保持旧摘要） */
export function parseSummaryResponse(
  text: string,
  prevText: string,
  coveredCount: number,
  now: number = Date.now(),
): ChatSummary | null {
  if (typeof text !== "string") return null;
  let body = text.trim();
  if (!body) return null;
  body = body
    .replace(/^```[\w]*\s*/i, "")
    .replace(/```$/m, "")
    .replace(/^(摘要|总结)[：:]\s*/i, "")
    .trim();

  // 把「悬而未决：…」这一行剥出来单独存，正文里不留（否则会被念出来）
  const openLoops: string[] = [];
  const lines: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*(?:悬而未决|未完成|待办)[:：]\s*(.*)$/.exec(line);
    if (!m) {
      lines.push(line);
      continue;
    }
    const items = m[1]
      .split(/[；;]/)
      .map((x) => x.trim().replace(/^[-·\d.、\s]+/, ""))
      .filter((x) => x && x !== "无" && x !== "没有");
    openLoops.push(...items);
  }
  body = lines.join("\n").trim();
  if (body.length < 10) return null;
  if (body.length > 600) body = body.slice(0, 600) + "…";
  return {
    text: body,
    coveredCount,
    updatedAt: now,
    openLoops: openLoops.slice(0, 6),
  };
}

/**
 * 把「悬而未决」里已经完成的事项移除。
 *
 * 提醒到点、用户确认完成、或工具明确回报任务结束后调用。
 * 用去空白子串匹配，兼容摘要写成「计时两分钟」「两分钟计时」这类措辞差异。
 */
export function completeOpenLoops(
  summary: ChatSummary | null | undefined,
  completed: string[],
  dropTaskLikeFallback = false,
): ChatSummary {
  const base = summary ?? emptyChatSummary();
  const targets = (completed || [])
    .map((x) => String(x || "").replace(/\s+/g, "").toLowerCase())
    .filter((x) => x.length >= 2);
  if (!base.openLoops?.length) return base;
  const matched = (text: string) => targets.some((t) => {
    if (text === t || text.includes(t) || t.includes(text)) return true;
    // 中文常见：摘要写「计时两分钟」，提醒事件写「两分钟到了」——按共同二元组判断
    const a = new Set(Array.from({ length: Math.max(0, text.length - 1) }, (_, i) => text.slice(i, i + 2)));
    const b = new Set(Array.from({ length: Math.max(0, t.length - 1) }, (_, i) => t.slice(i, i + 2)));
    let overlap = 0;
    for (const bg of a) if (b.has(bg)) overlap++;
    return overlap >= 2 || (a.size > 0 && overlap / a.size >= 0.5);
  });
  let kept = base.openLoops.filter((loop) => {
    const text = String(loop || "").replace(/\s+/g, "").toLowerCase();
    if (!text) return false;
    return !matched(text);
  });
  // 提醒消息常常是「时间到了」这种泛化文案，和摘要里的「计时两分钟」对不上；
  // 这种情况下至少移除最近一条短时任务，避免到点后还留着。
  if (dropTaskLikeFallback && kept.length === base.openLoops.length) {
    const taskRe = /(计时|倒计时|定时|提醒|闹钟|分钟后|小时后|秒后|待办)/;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (taskRe.test(kept[i])) {
        kept = [...kept.slice(0, i), ...kept.slice(i + 1)];
        break;
      }
    }
  }
  if (kept.length === base.openLoops.length) return base;
  return { ...base, openLoops: kept.slice(0, 6), updatedAt: Date.now() };
}

/** 注入 system prompt 的文本块（无内容时返回空串） */
export function summaryBlock(summary: ChatSummary | null | undefined): string {
  const text = summary?.text?.trim();
  if (!text) return "";
  return (
    "【更早的对话（你们之前聊过，细节你已经记不清了）】\n" +
    text +
    "\n【怎么用】需要的时候自然接上（「你之前说…」），不要提「摘要」「记录」这类说法，也不要逐条复述。"
  );
}
