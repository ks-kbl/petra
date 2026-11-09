/**
 * TTS 断句（纯函数，可单测）。
 *
 * 用户反馈："语音（中文）老是断句怪怪的"。
 *
 * 原来的实现是**见到每一个 `。！？；…` 就切一刀**送去合成，于是：
 * 1. 「好。」「对。」「嗯。」这种两三个字的碎片会各自单独合成 —— 每一段都是独立的
 *    开头+收尾语调，中间还夹着一次请求/解码的间隙，听起来就是"一顿一顿"；
 * 2. `；` 也被当句末，长句被拦腰截断，语气直接断掉；
 * 3. 引号/括号里的内容会被切开，TTS 读到半句就停。
 *
 * 现在改成：**只在真正的句末切**，且**攒够长度再送**（短句合并），
 * 同时保证不切进 `「」（）`和 `3.14` 这类小数点里。
 */

export interface SpeechSplitOptions {
  /** 一段至少这么长才值得单独送去合成（太短的会跟下一句合并） */
  minChars?: number;
  /** 单段上限：超过就在最近的逗号/空格处断开，避免一次合成太长容易超时 */
  maxChars?: number;
}

export const DEFAULT_MIN_CHARS = 10;
/**
 * 单段上限。
 *
 * 原来 70：长句经常在逗号处被腰斩，两次合成拼起来语气是断的。
 * 放宽到 90 后大部分整句（含两三个逗号）能一次合成，接缝明显减少；
 * 再长就有合成超时风险（Rust 侧 15 秒超时），所以不继续往上加。
 */
export const DEFAULT_MAX_CHARS = 90;

/** 句末标点（强断句）。刻意不含 `；;，、：` —— 那些是句中停顿 */
const SENTENCE_END = new Set(["。", "！", "？", "!", "?", "…"]);
const SOFT_BREAK = new Set(["，", ",", "、", "；", ";", "：", ":", " "]);
/** 成对符号：进入这些符号后不允许断句 */
const OPENERS = new Set(["（", "(", "「", "『", "“", "‘", "【", "《"]);
const CLOSERS = new Set(["）", ")", "」", "』", "”", "’", "】", "》"]);

/**
 * 从缓冲区头部切出"适合送去合成的一段"。
 * 返回 null = 还没攒够，继续等后续增量。
 */
export function takeSpeechSegment(
  buffer: string,
  opts: SpeechSplitOptions = {},
): { segment: string; rest: string } | null {
  const minChars = opts.minChars ?? DEFAULT_MIN_CHARS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  let text = buffer.replace(/^\s+/, "");
  if (!text.trim()) return null;

  let depth = 0;
  let lastSoft = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (OPENERS.has(ch)) depth++;
    else if (CLOSERS.has(ch)) depth = Math.max(0, depth - 1);
    else if (SOFT_BREAK.has(ch) && depth === 0) lastSoft = i;

    // 句末标点：必须在括号外
    if (depth === 0 && SENTENCE_END.has(ch)) {
      // 「……」 是省略号的一半，等它凑完再切
      if (ch === "…" && text[i + 1] === "…" && i + 1 === text.length - 1) continue;
      const segment = text.slice(0, i + 1);
      if (segment.trim().length >= minChars) {
        return { segment: segment.trim(), rest: text.slice(i + 1) };
      }
      // 太短：不切，继续往后攒（这就是"短句合并"）
      continue;
    }

    // 换行：模型经常一行一句（列表/分行回复）。换行处当句末处理，
    // 否则一行行读下来会连成一大串，或者被 maxChars 从行中间切断。
    if (depth === 0 && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && text[i + 1] === "\n") continue;
      const segment = text.slice(0, i).trim();
      if (segment.length >= minChars) {
        return { segment, rest: text.slice(i + 1).replace(/^[\r\n]+/, "") };
      }
      continue;
    }

    // 兜底：超长且没有句末标点，就在最近的逗号处断开
    if (i + 1 >= maxChars) {
      const cut = lastSoft > 0 ? lastSoft + 1 : maxChars;
      const segment = text.slice(0, cut);
      if (segment.trim()) return { segment: segment.trim(), rest: text.slice(cut) };
      break;
    }
  }
  return null;
}

/** 流结束时把剩下的尾巴交出去（不够一句也要说完） */
export function flushSpeechSegment(buffer: string): string {
  return buffer.replace(/^\s+/, "").trim();
}
