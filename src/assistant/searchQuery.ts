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
