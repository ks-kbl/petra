/**
 * 聊天记录页的纯逻辑（无 DOM、无网络），浏览器和 node 测试共用同一份。
 *
 * 为什么要单独拆出来：这页原来两千行内联 JS 全靠肉眼验证，改一次只能靠截图碰运气。
 * 这里只放"能输入输出、能断言"的部分：日期归属、消息清洗、搜索分段、导出 Markdown。
 * 面板通过 <script src="/chatlog-core.js"> 引入（Rust 用 include_str! 内嵌），
 * 测试用 require 直接加载 —— 一份代码，两处用。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PetraChatLog = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  /** 系统语言提醒行：会附在用户消息末尾，展示时必须去掉 */
  const REMINDER_RE = /^\[系统提醒/;
  /** 问候标记：展示成徽标而不是文字 */
  const GREETING_RE = /^【问候】\s*/;

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  /** 时间戳 → 本地自然日 YYYY-MM-DD */
  function dayKey(ts) {
    const d = new Date(ts);
    if (!Number.isFinite(d.getTime())) return "";
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  /** 日期键 → 周几 */
  function weekOf(key) {
    const d = new Date(key + "T00:00:00");
    return Number.isFinite(d.getTime()) ? WEEK[d.getDay()] : "";
  }

  /** 时间戳 → HH:MM */
  function timeText(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (!Number.isFinite(d.getTime())) return "";
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  /** 去掉用户消息末尾的语言提醒行 */
  function stripReminder(text) {
    return String(text || "")
      .split(/\r?\n/)
      .filter((line) => !REMINDER_RE.test(line.trim()))
      .join("\n")
      .trim();
  }

  /** 「原文 --- 译文」拆开 */
  function splitTranslation(raw) {
    const text = String(raw || "");
    const m = /-{3,}\r?\n?/.exec(text);
    if (!m) return { main: text.trim(), trans: "" };
    return {
      main: text.slice(0, m.index).trim(),
      trans: text.slice(m.index + m[0].length).trim(),
    };
  }

  function isChat(m) {
    return !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim() !== "";
  }

  function isTool(m) {
    return !!m && m.role === "tool" && typeof m.content === "string" && m.content.trim() !== "";
  }

  function isGreeting(m) {
    return isChat(m) && m.role === "assistant" && GREETING_RE.test(stripReminder(m.content));
  }

  /** 把消息按天分组；早于 minKey（30 天前）或没有 ts 的算进 undated */
  function groupByDay(messages, minKey, maxKey) {
    const byDay = new Map();
    let undated = 0;
    let toolCount = 0;
    for (const m of messages || []) {
      if (!isChat(m) && !isTool(m)) continue;
      if (!m.ts || (minKey && dayKey(m.ts) < minKey) || (maxKey && dayKey(m.ts) > maxKey)) {
        undated++;
        continue;
      }
      const k = dayKey(m.ts);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(m);
      if (isTool(m)) toolCount++;
    }
    // 按时间排一遍：历史里夹着工具消息、迁移后可能乱序，展示必须按发生顺序
    for (const list of byDay.values()) {
      list.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    }
    return { byDay, undated, toolCount };
  }

  /** 按关键词过滤（大小写不敏感），空查询返回原列表 */
  function filterByQuery(list, query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return list || [];
    return (list || []).filter((m) => String(m && m.content ? m.content : "").toLowerCase().includes(q));
  }

  /**
   * 把文本按命中片段切成 [{text, hit}]，供渲染层生成 <mark>。
   * 不返回 HTML 字符串 —— 消息内容里可能有任何字符，拼 HTML 会出事。
   */
  function highlightSegments(text, query) {
    const src = String(text || "");
    const q = String(query || "").trim();
    if (!q) return [{ text: src, hit: false }];
    const lower = src.toLowerCase();
    const needle = q.toLowerCase();
    const out = [];
    let i = 0;
    let idx = lower.indexOf(needle, i);
    while (idx >= 0) {
      if (idx > i) out.push({ text: src.slice(i, idx), hit: false });
      out.push({ text: src.slice(idx, idx + needle.length), hit: true });
      i = idx + needle.length;
      idx = lower.indexOf(needle, i);
    }
    if (i < src.length) out.push({ text: src.slice(i), hit: false });
    return out.length ? out : [{ text: src, hit: false }];
  }

  /** 导出某天为 Markdown（不含工具调用噪音，去掉问候标记与语言提醒） */
  function buildMarkdown(list, dayLabel) {
    const lines = [`# Petra 聊天记录 · ${dayLabel || ""}`, ""];
    (list || []).filter(isChat).forEach((m) => {
      const who = m.role === "user" ? "你" : "Petra";
      const t = timeText(m.ts);
      lines.push(`**${who}**${t ? " · " + t : ""}`, "");
      lines.push(stripReminder(m.content).replace(GREETING_RE, ""), "");
    });
    return lines.join("\n");
  }

  /** 一天的统计：对话条数 / 工具条数 / 首末时间 */
  function dayStats(list) {
    const chats = (list || []).filter(isChat);
    const tools = (list || []).filter(isTool);
    const times = chats.map((m) => m.ts).filter((t) => t > 0).sort((a, b) => a - b);
    return {
      chats: chats.length,
      tools: tools.length,
      first: times.length ? timeText(times[0]) : "",
      last: times.length ? timeText(times[times.length - 1]) : "",
    };
  }

  return {
    WEEK,
    pad2,
    dayKey,
    weekOf,
    timeText,
    stripReminder,
    splitTranslation,
    isChat,
    isTool,
    isGreeting,
    groupByDay,
    filterByQuery,
    highlightSegments,
    buildMarkdown,
    dayStats,
  };
});
