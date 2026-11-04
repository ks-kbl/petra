/**
 * 情绪趋势（纯函数，可单测）。
 *
 * EmotionEngine 维护的是一个**当下**的心情值（会被打滚、聊天、骂人等事件推动，
 * 并且随时间回落到基线），它不知道"这个人这一周过得怎么样"。
 *
 * 但对聊天有用的是后者：用户连着几天情绪偏低时，AI 说话的分寸该收一收
 * （别讲道理、别急着给方案、别开玩笑）；一直在基线以上时反而可以放松些。
 *
 * 所以这里每天留一个采样点（当天所有采样取平均），滚动保留 14 天，
 * 合成一句给模型看的"他最近的状态"。仍然只进 prompt，不露任何界面。
 */

export interface MoodSample {
  /** 本地自然日 YYYY-MM-DD */
  day: string;
  /** 当天平均心情值 0..1（0.5 为基线） */
  happiness: number;
  /** 当天采样次数 */
  count: number;
}

export const MOOD_KEEP_DAYS = 14;

export function moodDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function normalizeMoodSamples(raw: unknown): MoodSample[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => {
      if (!r || typeof r !== "object") return null;
      const o = r as Record<string, unknown>;
      const day = typeof o.day === "string" ? o.day : "";
      const happiness = Number(o.happiness);
      if (!day || !Number.isFinite(happiness)) return null;
      return {
        day,
        happiness: Math.min(1, Math.max(0, happiness)),
        count: Number.isFinite(o.count) ? Math.max(1, Number(o.count)) : 1,
      };
    })
    .filter((x): x is MoodSample => !!x)
    .slice(-MOOD_KEEP_DAYS);
}

/** 记一个采样点：同一天取加权平均，只保留最近 MOOD_KEEP_DAYS 天 */
export function recordMoodSample(
  samples: MoodSample[],
  happiness: number,
  now: number = Date.now(),
  keepDays: number = MOOD_KEEP_DAYS,
): MoodSample[] {
  const value = Math.min(1, Math.max(0, Number(happiness) || 0.5));
  const day = moodDayKey(now);
  const list = [...(samples || [])];
  const idx = list.findIndex((s) => s.day === day);
  if (idx >= 0) {
    const old = list[idx];
    const count = old.count + 1;
    list[idx] = { day, happiness: (old.happiness * old.count + value) / count, count };
  } else {
    list.push({ day, happiness: value, count: 1 });
  }
  list.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return list.slice(-keepDays);
}

export interface MoodTrend {
  /** 最近 3 天平均；样本不足时为 null */
  recent: number | null;
  /** 更早几天（4~10 天前）平均；没有则为 null */
  earlier: number | null;
  /** up / down / flat / unknown */
  trend: "up" | "down" | "flat" | "unknown";
  /** 有样本的天数 */
  days: number;
}

/** 最近 3 天 vs 更早一周的对比 */
export function summarizeMood(samples: MoodSample[], now: number = Date.now()): MoodTrend {
  const dayMs = 86400000;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const t0 = today.getTime();
  const inRange = (s: MoodSample, fromDaysAgo: number, toDaysAgo: number) => {
    const d = new Date(s.day + "T00:00:00").getTime();
    if (!Number.isFinite(d)) return false;
    const ago = Math.round((t0 - d) / dayMs);
    return ago >= fromDaysAgo && ago <= toDaysAgo;
  };
  const avg = (list: MoodSample[]) => (list.length ? list.reduce((s, x) => s + x.happiness, 0) / list.length : null);

  const recentList = samples.filter((s) => inRange(s, 0, 2));
  const earlierList = samples.filter((s) => inRange(s, 3, 10));
  const recent = avg(recentList);
  const earlier = avg(earlierList);
  let trend: MoodTrend["trend"] = "unknown";
  if (recent !== null && earlier !== null) {
    const diff = recent - earlier;
    trend = diff > 0.06 ? "up" : diff < -0.06 ? "down" : "flat";
  }
  return { recent, earlier, trend, days: samples.length };
}

/**
 * 注入 system prompt 的"他最近的状态"。
 * 心情正常（0.42~0.58）时不输出 —— 没话找话反而会让 AI 显得神经质。
 */
export function moodBlock(trend: MoodTrend | null | undefined): string {
  if (!trend || trend.days < 2 || trend.recent === null) return "";
  const r = trend.recent;
  const lines: string[] = [];
  if (r <= 0.38) {
    lines.push("他这几天情绪偏低、有点累。说话放软一点，先接住情绪再谈事，别讲道理、别急着给方案、别开玩笑。");
  } else if (r >= 0.62) {
    lines.push("他这几天状态不错。可以轻松一点，允许一点点俏皮和玩笑。");
  } else {
    return "";
  }
  if (trend.trend === "down") lines.push("而且比前些天更沉，注意收敛语气。");
  if (trend.trend === "up") lines.push("比前些天在好转，不用刻意小心翼翼。");
  return `【他最近的状态（你观察到的，不要说出来）】\n${lines.join("")}`;
}
