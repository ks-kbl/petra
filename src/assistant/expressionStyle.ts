/**
 * 生气时的"表达型"（纯函数，可单测）。
 *
 * 所有角色生气都变成"短、冲"太单一了。人设不同，生气的样子本来就不同：
 *   阴阳怪气型：话更多，但全是刺（大肥鱼）
 *   话变少型：回得很短、不接梗
 *   装没事型：嘴上说没事，但称呼变冷、不主动
 * 由人设文本识别一次，存下来，之后按这个演。
 */

export type ExpressionStyle = "sarcastic" | "terse" | "pretend";

/** 从人设里识别生气的样子；认不出来按"阴阳怪气"（最像日常拌嘴） */
export function deriveExpressionStyle(persona: string): ExpressionStyle {
  const t = (persona || "").trim();
  if (!t) return "sarcastic";
  if (/(毒舌|阴阳|嘴硬|傲娇|贱|吐槽|嘴碎|损)/.test(t)) return "sarcastic";
  if (/(冷淡|安静|话少|寡言|高冷|沉默)/.test(t)) return "terse";
  if (/(温柔|体贴|懂事|心软|要强|逞强)/.test(t)) return "pretend";
  return "sarcastic";
}

/** 生气时该怎么表现 */
export function styleLine(style: ExpressionStyle): string {
  switch (style) {
    case "sarcastic":
      return "你生气时话不会变少，反而更爱阴阳两句、带刺地回嘴。";
    case "terse":
      return "你生气时话会明显变少，只回最短的一句，不接梗也不主动延展。";
    default:
      return "你生气时会嘴硬说没事，但称呼变冷、不主动开话题，语气疏离。";
  }
}
