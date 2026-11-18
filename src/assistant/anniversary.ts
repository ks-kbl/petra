/**
 * 纪念日（纯函数，可单测）。
 *
 * 不做「用户自己填纪念日」那种设置项——那违反"表现类只给一个开关"的准则。
 * 这里只从**已经存在的客观时间**推：第一次见到用户的那天（首次启动），
 * 加上 7/30/100/200/365/500/730/1000 天这些节点。
 * 到了那天，问候会自然带一句"今天是我们认识第 N 天"，而不是突然弹一条系统通知。
 */

export interface Anniversary {
  /** 稳定的标识，用于去重（同一天只提一次） */
  key: string;
  /** 给模型看的一句话 */
  line: string;
  /** 距离今天还有几天（0 = 就是今天） */
  daysUntil: number;
  /** 纪念日当天的日期键，形如 2026-11-18 */
  dateKey: string;
}

const MILESTONES = [7, 30, 100, 200, 365, 500, 730, 1000];

const DAY = 24 * 60 * 60 * 1000;

/** 把时间戳归一到"当天零点"，避免时分秒影响天数计算 */
export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 两个时间戳之间相差的自然日数（按本地零点算，不受夏令时影响太多） */
export function daysBetween(fromTs: number, toTs: number): number {
  return Math.round((startOfDay(toTs) - startOfDay(fromTs)) / DAY);
}

export function dayKeyOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 未来 `withinDays` 天内（含今天）的纪念日。
 *
 * @param firstMetAt 第一次见到用户的时间戳（首次启动时刻），0 表示还不知道
 */
export function upcomingAnniversaries(firstMetAt: number, now: number, withinDays = 7): Anniversary[] {
  if (!firstMetAt || firstMetAt > now) return [];
  const today = daysBetween(firstMetAt, now);
  const out: Anniversary[] = [];
  for (const n of MILESTONES) {
    const diff = n - today;
    if (diff < 0 || diff > withinDays) continue;
    out.push({
      key: `met-${n}`,
      line: diff === 0
        ? `今天是你们认识第 ${n} 天`
        : `${diff} 天后是你们认识第 ${n} 天`,
      daysUntil: diff,
      dateKey: dayKeyOf(now + diff * DAY),
    });
  }
  return out;
}
