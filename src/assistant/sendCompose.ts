/**
 * 本轮消息该怎么拼（纯函数，可单测）。
 *
 * 为什么单独抽出来：用户反馈「只发图片不配文字就发不出去，必须先打一句话」。
 * 根因有两层——① 发送按钮/回车都先看 `input.value.trim()` 为空就直接 return；
 * ② 拼消息时图片提示只是正文的补充，没有文字就只剩一句「附图 N 张」。
 * 这里把「有没有可发的东西」「没有文字时怎么向模型说明」定成可测的规则，
 * 免得以后又有人在某个入口加一句 `if (!text) return`。
 */

export interface ImageLike {
  name: string;
  dataUrl?: string;
}

/** 输入框里有没有值得发送的内容（文字、图片、文本附件任意一种都算） */
export function hasSendableContent(text: string, imageCount: number, textFileCount: number): boolean {
  return Boolean(text.trim()) || imageCount > 0 || textFileCount > 0;
}

/**
 * 图片占位说明。
 *
 * - 有文字/附件：作为补充说明，告诉模型「另外还有 N 张图」；
 * - **只有图片**：必须明确告诉模型「用户没有配文字，请直接看图回应」，
 *   否则模型常常回一句「你想让我做什么？」——等于让用户再打一遍字，
 *   正是用户报的「发了图片还要发文字才能发送」的体感来源。
 */
export function buildImageNote(text: string, images: ImageLike[], hasTextFiles: boolean): string {
  if (!images.length) return "";
  const names = images.map((i) => i.name).join("、");
  if (text.trim() || hasTextFiles) return `（另外附图 ${images.length} 张：${names}）`;
  return `（用户只发了 ${images.length} 张图片（${names}），没有配文字：直接看图片内容，`
    + `自然地回应你看到的东西；不要反问“你想让我做什么”，也不要假装没收到图片。）`;
}

/** 真正发给模型的这一轮正文：用户文字 + 文本附件 + 图片占位 */
export function composeUserMessage(text: string, attachText: string, images: ImageLike[]): string {
  return [text.trim(), attachText, buildImageNote(text, images, Boolean(attachText.trim()))]
    .filter(Boolean)
    .join("\n\n");
}
