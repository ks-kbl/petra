/**
 * 称呼三档（纯函数，可单测）。
 *
 * 关系好的时候叫「老大」，气得狠了叫「喂」——这是最省力、也最容易被听出来的
 * 情绪信号。但称呼不能硬编码：换个角色，"老大"就不成立了。
 * 所以三档称呼由**人设文本推导一次**，之后按心情选档，问候/对话/语音共用同一档，
 * 避免出现"气泡里很甜、语音里很冲"的割裂。
 */

export type AddressTier = "close" | "neutral" | "cold";

export interface AddressForms {
  /** 亲昵：老大 / 鱼片 */
  close: string;
  /** 中性：你 */
  neutral: string;
  /** 冷淡：喂 / 直呼其名 */
  cold: string;
}

/**
 * 从人设里挑出称呼。
 *
 * 认这几种写法：`叫用户"老大"`、`称呼用户为"老大"`、`叫主人`、`管他叫"宝"`，
 * 以及人设里出现的引号词（取最后一个像称呼的）。
 * 认不出来就用最保守的一套：亲昵"你"、中性"你"、冷淡"喂"。
 */
export function deriveAddressForms(persona: string): AddressForms {
  const t = (persona || "").trim();
  const fallback: AddressForms = { close: "你", neutral: "你", cold: "喂" };
  if (!t) return fallback;

  const quoted: string[] = [];
  for (const m of t.matchAll(/[「“"']([^」”"']{1,8})[」”"']/g)) {
    const w = m[1].trim();
    if (w && !/^\d+$/.test(w)) quoted.push(w);
  }
  const near = /(?:称呼|叫|管|喊)(?:用户|主人|对方)?(?:为|做)?[「“"']?([^，。；\n」”"']{1,8})[」”"']?/.exec(t);
  const fromNear = near ? near[1].trim() : "";
  // 优先用"称呼/叫"附近的词，其次是引号词里最后一个
  const close = (fromNear || quoted[quoted.length - 1] || "").replace(/[了的嘛啊哦]+$/, "");
  if (!close || close.length > 8) return fallback;
  return {
    close,
    neutral: "你",
    // 冷淡档：不用称呼，直接"喂"——比叫名字更疏远，也更通用
    cold: "喂",
  };
}

/** 按心情与好感选档：气头上掉档，关系好时不至于掉到底 */
export function addressTier(mood: number, favorScore: number): AddressTier {
  if (mood <= -0.55) return favorScore >= 0.62 ? "neutral" : "cold";
  if (mood < -0.2) return "neutral";
  if (favorScore >= 0.6) return "close";
  return "neutral";
}

/** 给模型看的一句话：明确"这轮该怎么叫对方" */
export function addressLine(tier: AddressTier, forms: AddressForms): string {
  if (tier === "close") return `称呼：叫对方「${forms.close}」。`;
  if (tier === "cold") return `称呼：这轮别用亲昵称呼，直接用「${forms.cold}」或者干脆不叫。`;
  return `称呼：这轮就叫「${forms.neutral}」，别用亲昵的叫法。`;
}
