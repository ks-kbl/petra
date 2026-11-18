/**
 * 好感度（纯函数，可单测）。
 *
 * 和"心情"分开：心情是短时状态（几十分钟到几小时），好感度是**长期账户**（按天变化）。
 * 一次冒犯只让好感降一点点，但反复冒犯会累积；长期好好相处会慢慢回升。
 *
 * 两者相乘才是语气：心情差 + 好感高 = 嘴上凶你但很快心软；心情差 + 好感低 = 真的冷淡。
 */

export interface Favor {
  /** 0~1，0.5 = 初识的中间值 */
  score: number;
  updatedAt: number;
}

/** 每天最多变化多少（长期账户不能一天暴涨暴跌） */
const DAILY_DRIFT = 0.12;
/** 长期不互动会不会变淡：非常慢，只是"没那么亲近" */
const NEGLECT_PER_DAY = 0.01;

export function defaultFavor(now = Date.now()): Favor {
  return { score: 0.5, updatedAt: now };
}

/**
 * 按事件调整好感：正事件加分、负事件减分，都按 |intensity| 缩放。
 *
 * 关键约束：**单次变化有上限**，所以一次吵架不会直接把好感清零——
 * 那不符合"人"的记账方式，也不符合用户对这个角色的期待。
 */
export function applyAffect(fav: Favor, intensity: number, now = Date.now()): Favor {
  const delta = Math.max(-DAILY_DRIFT, Math.min(DAILY_DRIFT, intensity * 0.06));
  return drift(fav, now, delta);
}

/** 时间漂移：向 0.5 缓慢回落，长期不互动再略微下降 */
export function decay(fav: Favor, now = Date.now()): Favor {
  return drift(fav, now, 0);
}

function drift(fav: Favor, now: number, extra: number): Favor {
  const days = Math.max(0, (now - fav.updatedAt) / (24 * 60 * 60 * 1000));
  if (days <= 0 && extra === 0) return fav;
  // 向 0.5 回归（按天比例，最多回归 10%/天），再叠加本次事件
  const pull = Math.min(0.1, days * 0.02);
  let score = fav.score + (0.5 - fav.score) * pull + extra;
  // 长期无互动：慢慢变淡一点点
  score -= Math.min(0.05, days * NEGLECT_PER_DAY);
  return { score: Math.max(0, Math.min(1, score)), updatedAt: now };
}

/** 给模型看的一句话（不含数字）；中间值返回空串，不干扰 */
export function favorLine(fav: Favor): string {
  if (fav.score >= 0.8) return "你对主人已经很亲近了，说话可以更随意、更黏一点。";
  if (fav.score >= 0.62) return "你和主人相处得不错，语气自然放松。";
  if (fav.score <= 0.22) return "你对主人有点疏远，话可以少一点，别主动讨好。";
  if (fav.score <= 0.38) return "你和主人之间有点生分，不用太热络。";
  return "";
}

/**
 * 心情 × 好感 → 一条综合语气提示。
 *
 * 这是两个模块真正"共同工作"的地方：单独看心情或单独看好感都会失真。
 */
export function toneLine(fav: Favor, moodValue: number): string {
  // 阈值必须和 affect.moodLine 对齐（-0.55 大生气 / -0.2 小不爽），
  // 否则同一个状态会出现"你还有点不爽" + "你在生气"两句话打架。
  if (moodValue <= -0.55) {
    if (fav.score >= 0.62) return "你在生气，但因为关系好，可以凶两句再自己找台阶下。";
    if (fav.score <= 0.38) return "你在生气，而且本来也不算亲近，语气可以冷一点。";
    return "你在生气，语气冲一点，别主动开新话题。";
  }
  if (moodValue < -0.2) {
    return fav.score >= 0.62
      ? "你还有点不爽，但关系好，嘴上带刺就行，别真的翻脸。"
      : "你还有点不爽，话可以少一点。";
  }
  if (moodValue >= 0.5 && fav.score >= 0.62) return "心情好又亲近，可以主动撒个娇或多说两句。";
  return "";
}
