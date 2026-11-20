/**
 * 搜索的查询改写与相关性自检（纯函数，可单测）。
 *
 * 模型常把整句当搜索词（"为什么我的电脑打不开网页"），搜索引擎对这种输入很敷衍。
 * 这里做两件事：
 *   1. 把一句话拆成 2~3 个更像搜索词的变体（去语气词、抽主体、补限定）；
 *   2. 算一下返回结果到底有多相关——不相关就换词重搜，而不是把垃圾交给模型硬答。
 */

/** 废话词：出现在搜索词里只会降低命中率 */
const NOISE = /(请问|帮我|帮忙|我想知道|想问一下|能不能|可不可以|怎么办|怎么样|是什么|为什么|有没有|的吗|呢|吗|啊|呀|吧|了)/g;

/** 中文二元组（和 Rust 侧 query_tokens 保持同一套口径） */
function tokens(text: string): string[] {
  const out: string[] = [];
  const s = (text || "").toLowerCase();
  let ascii = "";
  let cjk = "";
  const flushAscii = () => { if (ascii.length >= 2) out.push(ascii); ascii = ""; };
  const flushCjk = () => {
    if (cjk.length === 1) out.push(cjk);
    else for (let i = 0; i + 1 < cjk.length; i++) out.push(cjk.slice(i, i + 2));
    cjk = "";
  };
  for (const ch of s) {
    if (/[a-z0-9]/.test(ch)) { if (cjk) flushCjk(); ascii += ch; }
    else if (/[\u4e00-\u9fff]/.test(ch)) { flushAscii(); cjk += ch; }
    else { flushAscii(); flushCjk(); }
  }
  flushAscii(); flushCjk();
  return [...new Set(out)];
}

/**
 * 从一个整句生成 2~3 个搜索变体。
 *
 * 第一个永远是原句（模型可能已经写得很准），后面是"去掉废话"和"只留主体"的短版本。
 * 全程不调用模型，零成本。
 */
export function buildQueryVariants(text: string): string[] {
  const raw = (text || "").trim();
  if (!raw) return [];
  const variants: string[] = [raw];

  // ① 去掉语气词/疑问词，保留原来的词序
  const stripped = raw.replace(NOISE, " ").replace(/[，。！？、,.!?；;：:]/g, " ").replace(/\s+/g, " ").trim();
  if (stripped && stripped !== raw && stripped.length >= 2) variants.push(stripped);

  // ② 取前 6 个"实词"（去掉单字和纯数字）
  const words = raw
    .replace(NOISE, " ")
    .split(/[\s，。！？、,.!?；;：:（）()]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
  if (words.length >= 2) {
    const kw = words.slice(0, 6).join(" ");
    if (kw && !variants.includes(kw)) variants.push(kw);
  }

  return variants.slice(0, 3);
}

/**
 * 这批结果到底有多相关（0~1）。
 *
 * 用"命中了多少比例的关键词"来算：全部命中 = 1，完全没命中 = 0。
 * 低于阈值就说明这次搜索基本白搜了，应该换词重来，而不是硬答。
 */
export function hitRelevance(hits: { title?: string; snippet?: string }[], query: string): number {
  if (!hits.length) return 0;
  const qs = tokens(query);
  if (!qs.length) return 0;
  let best = 0;
  for (const h of hits) {
    const text = `${h.title ?? ""} ${h.snippet ?? ""}`.toLowerCase();
    if (!text.trim()) continue;
    let hit = 0;
    for (const t of qs) if (text.includes(t)) hit += 1;
    best = Math.max(best, hit / qs.length);
  }
  return Math.round(best * 100) / 100;
}

/** 结果够不够好：低于 0.25 就值得换词重搜一次 */
export const RELEVANCE_FLOOR = 0.25;

/** 主查询始终保留；词条释义或全名扩展可以补充，不能替换主查询。 */
export function searchPlan(query: string, alternatives: string[], userText = ""): string[] {
  const main = query.trim();
  if (!main) return [];
  const user = userText.trim();
  const concise = buildQueryVariants(user)[1] ?? user;
  // 只补简短的公开事实问句；附件、长文本、链接或凭据样式不可自动拼进外部搜索。
  const publicQuestion = user.length >= 6 && user.length <= 100 && !/[\r\n]|https?:|(?:api.?key|token|密码|密钥|sk-[\w-]+|[\w.+-]+@[\w.-]+\.[a-z]{2,})/i.test(user);
  const drift = publicQuestion && needsWebEvidence(user) && hitRelevance([{ title: main }], concise) < 0.35;
  const extra = alternatives.map(s => s.trim()).filter(s => s && hitRelevance([{ title: s }], main) >= 0.3);
  // 明显换了问题时让用户原问题排第一，模型写法只补召回，不再决定最终排序。
  const facet = /下岗|卸任|辞职|离职|上任|人事|辞任|CEO|resign/i;
  const issueDrift = drift && facet.test(concise) && !facet.test(main);
  return [...new Set([...(issueDrift ? [concise, main] : [main, ...(drift ? [concise] : [])]), ...extra, ...buildQueryVariants(main)])].slice(0, 3);
}

export function needsWebEvidence(text: string): boolean {
  return /最新|最近|目前|现任|刚刚|今天|本周|今年|消息|新闻|传闻|真假|属实|卸任|上任|离职|下岗|辞职|任免|版本|发布|发售|价格|多少钱|股价|价格表|比分|结果|政策|法规|公告|何时生效|latest|today|current|price|release|resign|version|policy/i.test(text);
}

export interface WebHit { title: string; url: string; snippet: string; engine?: string; score?: number }
export interface WebEvidencePage { title: string; url: string; text: string; truncated: boolean }
const clean = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
function sourceHost(url: string): string {
  try {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) return "";
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch { return ""; }
}

export async function collectWebEvidence(hits: WebHit[], query: string, read: (url: string) => Promise<WebEvidencePage>): Promise<WebEvidencePage[]> {
  const candidates: WebHit[] = [];
  const hosts = new Set<string>();
  for (const hit of hits) {
    const host = sourceHost(hit.url);
    if (!host || hosts.has(host) || hitRelevance([hit], query) < RELEVANCE_FLOOR) continue;
    const snippet = clean(hit.snippet);
    if (snippet.length >= 24 && candidates.some(h => clean(h.snippet) === snippet)) continue;
    hosts.add(host);
    candidates.push(hit);
    if (candidates.length === 4) break;
  }
  const pages: WebEvidencePage[] = [];
  for (let i = 0; i < candidates.length && pages.length < 2; i += 2) {
    const results = await Promise.allSettled(candidates.slice(i, i + 2).map(hit => read(hit.url)));
    for (const res of results) {
      if (res.status !== "fulfilled") continue;
      const page = res.value;
      const host = sourceHost(page.url);
      const bodyKey = clean(page.text).slice(0, 350);
      if (!host || bodyKey.length < 35 || hitRelevance([{ snippet: page.text }], query) < RELEVANCE_FLOOR) continue;
      if (pages.some(p => sourceHost(p.url) === host || clean(p.text).slice(0, 350) === bodyKey)) continue;
      pages.push(page);
      if (pages.length === 2) break;
    }
  }
  return pages;
}

/** 保留正文中命中查询的部分，不把 8 千字页头和导航直接塞进聊天。 */
export function evidenceExcerpt(text: string, query: string, limit = 1100): string {
  if (text.length <= limit) return text;
  const words = tokens(query);
  const step = Math.floor(limit / 2);
  if (step < 1) return text.slice(0, limit);
  let bestStart = 0;
  let bestScore = 0;
  for (let i = 0; i < text.length; i += step) {
    const block = text.slice(i, i + limit).toLowerCase();
    const score = words.filter(t => block.includes(t)).length;
    if (score > bestScore) { bestStart = i; bestScore = score; }
  }
  return `${bestStart ? "…" : ""}${text.slice(bestStart, bestStart + limit)}…`;
}
