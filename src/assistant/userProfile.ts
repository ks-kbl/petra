/**
 * 用户画像（UserProfile）：从长期记忆里合成"这是个什么样的人"。
 *
 * 用户的要求（原话）：「让 AI 自己根据和用户的对话自己总结用户画像，通过聊天来完善用户画像，
 * 从而更好地和用户对话，给用户营造出一种越聊越懂他，或者说越聊越投机的现象。」
 * 并且明确：**画像不在软件界面里展示**，只能通过对话过程"侧面体现"。
 *
 * 所以这里的定位是：
 * - 原子记忆（MemoryEntry）是"素材"，画像是对素材的**再提炼**，只在 system prompt 里给模型看；
 * - 画像不进 UI、不设面板，用户能感知到的只有"TA 好像真的记得我"；
 * - 提炼由模型完成，本文件只做 prompt 组装、结果解析、是否该重算的判定（纯函数，可单测）。
 *
 * 为什么要单独一层而不是把记忆直接塞 prompt：
 * 原子记忆是流水账（"用户在写小说"、"用户周末爬山"、"用户讨厌被问工作"），
 * 平铺 20 条模型读到的是碎片清单；画像把它们压成"这个人怎么生活、怎么说话最舒服"，
 * 模型才能自然地接话，而不是背诵条目。
 */

/** 画像里可结构化的稳定字段（程序判断 + 后续召回可用；不对外展示） */
export interface ProfileFacts {
  /** 希望被怎么称呼 */
  nickname: string;
  /** 身份/职业/在做什么 */
  occupation: string;
  /** 作息规律 */
  schedule: string;
  /** 兴趣、爱好、在追的东西 */
  interests: string[];
  /** 常用软件/工具/技术栈 */
  tools: string[];
  /** 怎么跟他说话最舒服（简短/爱被追问/讨厌客套…） */
  communication: string;
  /** 雷区：别碰的话题、别开的玩笑 */
  avoid: string[];
  /** 近期关注点（会过期，由提炼时判断是否还新鲜） */
  recentFocus: string;
}

export interface UserProfile {
  /** 一段 200~300 字的"这个人的自述"，注入时读这段，不读原始记忆 */
  narrative: string;
  facts: ProfileFacts;
  updatedAt: number;
  /** 每次重写 +1 */
  version: number;
  /** 合成时的记忆条数：判断"有没有攒够新素材值得重算" */
  memoriesSeen: number;
}

/** 画像注入 system prompt 时附带的"使用说明"——决定它是"侧面体现"还是"当台词念" */
export const PROFILE_USAGE_RULES =
  "【怎么用这份印象】\n" +
  "· 只在相关的时候自然地带出来，像老朋友一样接一句具体的，不要复述这份材料，不要说「根据我的记忆」「我记录过」这类话，更不要一条条列举。\n" +
  "· 不要每次都提。大部分回复用不到它，用不到就当没看见；一天里偶尔一两次刚好戳中，比句句都提更像「懂他」。\n" +
  "· 没把握的部分不要当事实讲，拿不准就用「你好像…」「是不是最近…」的口吻试探，让他来纠正你。\n" +
  "· 他明确说过不想被提起的事，永远不要主动提。\n" +
  "· 不要用这份印象去推销、劝说或教育他，只用来把话接得更准。";

export function emptyProfile(): UserProfile {
  return {
    narrative: "",
    facts: {
      nickname: "",
      occupation: "",
      schedule: "",
      interests: [],
      tools: [],
      communication: "",
      avoid: [],
      recentFocus: "",
    },
    updatedAt: 0,
    version: 0,
    memoriesSeen: 0,
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .slice(0, 8);
}

/** 宽容解析存档（老版本/手改/字段缺失都不能炸） */
export function normalizeProfile(raw: unknown): UserProfile {
  const base = emptyProfile();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const f = (r.facts && typeof r.facts === "object" ? r.facts : {}) as Record<string, unknown>;
  return {
    narrative: str(r.narrative),
    facts: {
      nickname: str(f.nickname),
      occupation: str(f.occupation),
      schedule: str(f.schedule),
      interests: strList(f.interests),
      tools: strList(f.tools),
      communication: str(f.communication),
      avoid: strList(f.avoid),
      recentFocus: str(f.recentFocus),
    },
    updatedAt: Number.isFinite(r.updatedAt) ? Number(r.updatedAt) : 0,
    version: Number.isFinite(r.version) ? Number(r.version) : 0,
    memoriesSeen: Number.isFinite(r.memoriesSeen) ? Number(r.memoriesSeen) : 0,
  };
}

/** 画像有没有可用内容（没内容就不要往 prompt 里塞空壳） */
export function isProfileEmpty(p: UserProfile | null | undefined): boolean {
  return !p || !p.narrative.trim();
}

/**
 * 注入 system prompt 的文本块（不带前导换行，调用方自己拼）。
 * 注意：这里刻意不输出 id / 时间戳 / "记忆条目数"这类内部字段，
 * 避免模型把它们当台词说出来。
 */
export function profileBlock(p: UserProfile | null | undefined): string {
  if (isProfileEmpty(p)) return "";
  const prof = p as UserProfile;
  const f = prof.facts;
  const lines: string[] = [`- 你心里的他：${prof.narrative.trim()}`];
  if (f.nickname) lines.push(`- 称呼：${f.nickname}`);
  if (f.occupation) lines.push(`- 身份/在做的事：${f.occupation}`);
  if (f.schedule) lines.push(`- 作息：${f.schedule}`);
  if (f.interests.length) lines.push(`- 在意/喜欢的：${f.interests.join("、")}`);
  if (f.tools.length) lines.push(`- 常用工具：${f.tools.join("、")}`);
  if (f.communication) lines.push(`- 怎么跟他说话最舒服：${f.communication}`);
  if (f.avoid.length) lines.push(`- 别碰：${f.avoid.join("、")}`);
  if (f.recentFocus) lines.push(`- 最近在忙：${f.recentFocus}`);
  return `【关于主人（你们长期相处攒下的印象，不是他这轮刚说的）】\n${lines.join("\n")}\n${PROFILE_USAGE_RULES}`;
}

/** 首次合成至少要有的记忆条数：素材太少时合成的画像全是脑补 */
export const PROFILE_MIN_FIRST = 3;
/** 单次提炼最多喂多少条记忆（超了按"重要的优先 + 最近的补齐"挑） */
export const PROFILE_MAX_MEMORIES = 120;
/** 之后每攒够这么多条新记忆才重算一次（控制 token 与抖动） */
export const PROFILE_MIN_NEW = 6;
/** 很久没更新且有新素材时也补一次（跨天用，避免画像停在一周前） */
export const PROFILE_MAX_AGE_MS = 12 * 3600 * 1000;

export function shouldSynthesize(
  p: UserProfile | null | undefined,
  memoryCount: number,
  now: number = Date.now(),
): boolean {
  if (memoryCount <= 0) return false;
  if (isProfileEmpty(p)) return memoryCount >= PROFILE_MIN_FIRST;
  const prof = p as UserProfile;
  if (memoryCount - prof.memoriesSeen >= PROFILE_MIN_NEW) return true;
  return now - prof.updatedAt > PROFILE_MAX_AGE_MS && memoryCount > prof.memoriesSeen;
}

/** 提炼器能接受的最小记忆形状（方便单测直接造数据） */
export interface ProfileMemoryInput {
  content: string;
  category?: string;
  importance?: number;
  createdAt?: number;
}

function fmtDate(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * 提炼用 messages。输出严格 JSON：
 *   {"narrative":"…","facts":{…}}
 * 规则里最重要的两条：只写有记忆支撑的内容（禁止编造）、冲突以更新的为准。
 */
export function buildProfileMessages(
  memory: ProfileMemoryInput[],
  prev: UserProfile | null | undefined,
): { role: "system" | "user"; content: string }[] {
  const system =
    "你是一个人物档案整理器。你会看到关于同一位用户的若干条零散记忆（带日期与类别），以及一份旧档案。\n" +
    "请把这些素材整理成一份新的档案，只输出 JSON，不要任何解释文字：\n" +
    '{"narrative":"一份 200~300 字、像老朋友口吻的对这个人的了解",' +
    '"facts":{"nickname":"","occupation":"","schedule":"","interests":[],"tools":[],"communication":"","avoid":[],"recentFocus":""}}\n' +
    "规则：\n" +
    "1. 只写有记忆支撑的内容。没有任何依据的字段留空字符串或空数组，绝对不要编造，也不要写「不详」「未知」。\n" +
    "2. 记忆日期越靠后越新；信息冲突时以新的为准，旧结论直接丢掉，不要并列。\n" +
    "3. 同类信息合并成一句人话，不要罗列流水账，不要照抄记忆原句。\n" +
    "4. narrative 要具体、有人味：他是谁、日子怎么过、在意什么、情绪上怕什么、怎么跟他说话最舒服、最近在忙什么。不要写成标签清单。\n" +
    "5. recentFocus 只保留最近两周内还成立的事，过期的留空。\n" +
    "6. 不要写任何关于「AI 记住了什么」「系统」「档案」的元描述，只写这个人本身。\n" +
    "7. 用中文写。";

  // 素材上限：长期使用后记忆能到 200 条，全塞进去既贵又容易让模型在细节里迷路。
  // 优先保住"核心 + 重要"（importance 1/2），其余用最近的补齐。
  let src = memory.filter((m) => m && typeof m.content === "string" && m.content.trim());
  if (src.length > PROFILE_MAX_MEMORIES) {
    const byNew = [...src].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const important = byNew.filter((m) => (m.importance ?? 2) <= 2).slice(0, 80);
    const rest = byNew.filter((m) => !important.includes(m)).slice(0, PROFILE_MAX_MEMORIES - important.length);
    src = [...important, ...rest].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }

  const lines = src
    .map((m) => {
      const parts = [fmtDate(m.createdAt ?? 0), `[${m.category ?? "other"}]`, m.content.trim()];
      return "- " + parts.filter(Boolean).join(" ");
    })
    .join("\n");

  const prevText = isProfileEmpty(prev)
    ? "（还没有旧档案，这是第一次整理）"
    : `旧档案（仅供参考，可以被新素材推翻）：\n${(prev as UserProfile).narrative}`;

  return [
    { role: "system", content: system },
    { role: "user", content: `素材记忆：\n${lines}\n\n${prevText}` },
  ];
}

/** 从模型输出里抠出档案；不合法就返回 null（调用方保持旧档案，绝不写坏数据） */
export function parseProfileResponse(
  text: string,
  prev: UserProfile | null | undefined,
  memoriesSeen: number,
  now: number = Date.now(),
): UserProfile | null {
  if (typeof text !== "string" || !text.trim()) return null;
  // 容忍 ```json 包裹、前后寒暄、以及模型自作主张多写的说明
  const cleaned = text.replace(/```json/gi, "```").split("```").join("\n");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const narrative = str(r.narrative);
  if (!narrative) return null;
  // 模型偶尔把整个档案写成一段话塞进 narrative：长度兜底，别让一条消息吃满 prompt
  const base = normalizeProfile(prev ?? emptyProfile());
  const next = normalizeProfile({ ...r, narrative: narrative.slice(0, 600) });
  return {
    narrative: next.narrative,
    // 新结果为空、旧档案有值的字段保留旧值：模型这次没提到不等于事实变了
    facts: {
      nickname: next.facts.nickname || base.facts.nickname,
      occupation: next.facts.occupation || base.facts.occupation,
      schedule: next.facts.schedule || base.facts.schedule,
      interests: next.facts.interests.length ? next.facts.interests : base.facts.interests,
      tools: next.facts.tools.length ? next.facts.tools : base.facts.tools,
      communication: next.facts.communication || base.facts.communication,
      avoid: next.facts.avoid.length ? next.facts.avoid : base.facts.avoid,
      recentFocus: next.facts.recentFocus,
    },
    updatedAt: now,
    version: base.version + 1,
    memoriesSeen,
  };
}
