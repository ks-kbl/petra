/**
 * 日记 → 长期记忆的提炼（纯函数，可单测）。
 *
 * 现状痛点：日记和记忆是两套系统，各存各的——她日记里写着「今天他终于把论文交了」，
 * 但聊天时完全想不起来。这里把日记里**明确的、具体的事件**抽成记忆条目，
 * 让"日记里的事"在对话里也能被想起来。
 *
 * 为什么用规则而不是再调一次模型：一天只有一篇日记，规则足够稳（要求句子带具体动词/
 * 时间/对象），而且零成本、可测。模型提炼留给"事后追问细节"那种场景。
 */

export interface DiaryFact {
  /** 写进记忆库的一句话 */
  content: string;
  /** 来源日期，用于去重和"什么时候的事" */
  date: string;
}

/** 带"做了什么事"的动词——没有这些的句子多半是感想，不进事实层 */
const ACTION_RE = /(打开|关掉|写完|写了|改|修|做|交|发|学|看|读|开|装|删|买|吃|喝|睡|起|跑|约|聊|问|答|试|调|部署|上线|打卡|面试|考试|提交)/;

/** 纯感想/情绪句：这些留在日记里，不抽成事实 */
const FEELING_RE = /(我觉得|感觉|好像|也许|大概|心情|有点累|开心|难过|舍不得|希望|担心)/;

/**
 * 从一篇日记里抽出 0~2 条"事实"。
 *
 * 只看正文（不看译文），按句子切，挑**同时满足**：有具体动作、不是纯感想、
 * 长度适中（8~40 字）的句子。这样抽出来的东西才敢写进记忆库。
 */
export function extractDiaryFacts(entry: { date: string; content: string }): DiaryFact[] {
  const body = (entry.content || "").replace(/\r/g, "");
  if (!body.trim()) return [];
  // 按中英文句号/感叹号/问号切句，保留标点
  const sentences = body
    .split(/(?<=[。！？!?])/)
    .map((x) => x.trim())
    .filter(Boolean);
  const out: DiaryFact[] = [];
  for (const raw of sentences) {
    const s = raw.replace(/\s+/g, " ");
    const len = s.replace(/[。！？!?，,、；;：:「」“”"']/g, "").length;
    if (len < 8 || len > 40) continue;
    if (!ACTION_RE.test(s)) continue;
    if (FEELING_RE.test(s) && !ACTION_RE.test(s)) continue;
    // 去掉首尾的过渡词，留下可直接入记忆库的陈述
    const content = s
      .replace(/^(今天|昨天|上午|下午|晚上|刚才|然后|后来|结果|看来)[，,]?/, "")
      .replace(/[。！？!?]+$/, "")
      .trim();
    if (content.length < 6) continue;
    out.push({ content, date: entry.date });
    if (out.length >= 2) break;
  }
  return out;
}

/** 记忆库里那一句话的写法：带上日期，免得以后分不清是哪天的事 */
export function memoryLineFor(fact: DiaryFact): string {
  return `${fact.date}：${fact.content}`;
}
