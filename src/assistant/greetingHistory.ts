/**
 * 主动问候进入主对话历史时的标记。
 *
 * 用户要求：问候也要算作正常对话，必须进 chat-history，并且标【问候】——
 * 这样用户回复问候时，模型能看到"自己刚刚主动说过什么"。
 */

export const GREETING_MARKER = "【问候】";

/** 给实际要写进历史的问候文本加标记（避免重复加） */
export function markGreetingForHistory(text: string): string {
  const body = (text || "").trim();
  if (!body) return GREETING_MARKER;
  return body.startsWith(GREETING_MARKER) ? body : `${GREETING_MARKER}${body}`;
}

/** 这条历史消息是不是主动问候 */
export function isGreetingHistoryContent(content: string | null | undefined): boolean {
  return typeof content === "string" && content.trimStart().startsWith(GREETING_MARKER);
}
