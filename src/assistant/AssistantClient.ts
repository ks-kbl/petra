import type { AssistantProvider } from "../utils/settings";
import { parseArgsSafe } from "./toolRuntime";
// Vite ?raw：打包时把 CHANGELOG.md 全文作为字符串打进 bundle；package.json 取版本号
// 让 AI 知道自己当前版本与最近更新了什么，主人聊到新功能时接得上话。
// @ts-ignore
import changelogRaw from "../../CHANGELOG.md?raw";
// @ts-ignore
import pkg from "../../package.json";
import { normalizeOpenAIBase } from "./apiKey";
import { invoke } from "@tauri-apps/api/core";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /**
   * 这条消息写进历史的时间戳。
   * 控制面板的「聊天记录」按天分组靠它；缺省时（老数据）会归到"更早"。
   */
  ts?: number;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

/**
 * 偶发错误的自动重试节奏（毫秒）。只覆盖"还没开始接收流"的失败：
 * 429 限流、5xx/408 网关抖动、以及网络层直接失败。
 * 400/401/402/403 这类重试也没用，直接报给用户。
 */
const RETRY_DELAYS_MS = [600, 1800];

/**
 * 已经确认"不支持 function calling"的端点（base + model）。
 * 第一次 400 后自动降级为纯文本请求，后续直接按兼容模式发，避免每条消息都失败一次。
 */
const NO_TOOLS_ENDPOINTS = new Set<string>();

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}


/** 结构化记忆条目 */
export interface MemoryEntry {
  id: string;                          // 唯一标识
  category: "identity" | "preference" | "habit" | "schedule" | "relationship" | "event" | "other";
  content: string;                     // "用户叫小明"
  keywords: string[];                  // ["名字", "小明"]
  source: "user_said" | "ai_inferred"; // 谁发现的
  createdAt: number;                   // 首次记录时间戳
  lastUsedAt: number;                  // 最近一次被引用的时间
  importance: 1 | 2 | 3;              // 1=核心 2=重要 3=琐碎
}

export type MemoryStore = MemoryEntry[];

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** 模型给的参数不是合法 JSON 时的原因（调用仍会回一条 tool 消息，让模型自我纠正） */
  argsError?: string;
}

export interface ProviderInfo {
  label: string;
  base: string;
  defaultModel: string;
  placeholder: string;
}

export const PROVIDERS: Record<AssistantProvider, ProviderInfo> = {
  deepseek:     { label: "DeepSeek",         base: "https://api.deepseek.com",              defaultModel: "deepseek-chat",           placeholder: "sk-..." },
  openai:       { label: "OpenAI",           base: "https://api.openai.com/v1",             defaultModel: "gpt-4o-mini",             placeholder: "sk-..." },
  moonshot:     { label: "Moonshot (Kimi)",   base: "https://api.moonshot.cn/v1",            defaultModel: "moonshot-v1-8k",          placeholder: "sk-..." },
  zhipu:        { label: "智谱 (GLM)",        base: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4-flash",             placeholder: "..." },
  qwen:         { label: "通义千问",          base: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen-turbo", placeholder: "sk-..." },
  siliconflow:  { label: "SiliconFlow",      base: "https://api.siliconflow.cn/v1",         defaultModel: "Qwen/Qwen2.5-7B-Instruct", placeholder: "sk-..." },
  openrouter:   { label: "OpenRouter",       base: "https://openrouter.ai/api/v1",         defaultModel: "openai/gpt-4o-mini",     placeholder: "sk-or-..." },
  groq:         { label: "Groq",             base: "https://api.groq.com/openai/v1",       defaultModel: "llama-3.1-8b-instant",    placeholder: "gsk_..." },
  ollama:       { label: "Ollama (本地)",     base: "http://localhost:11434/v1",             defaultModel: "qwen2.5:7b",              placeholder: "通常无需填写" },
  custom:       { label: "自定义",            base: "",                                      defaultModel: "",                        placeholder: "API Key" },
};

/**
 * 有些供应商根本不需要 API Key（本地 Ollama；指向本机的自定义端点如 LM Studio / llama.cpp）。
 * 以前所有门禁都只看"Key 是否非空"，于是设置面板里明明写着「Ollama：API Key 留空」，
 * 照做的用户却会被拦下说"未配置 API Key"。
 */
export function isKeylessProvider(provider: AssistantProvider, customBaseUrl = ""): boolean {
  if (provider === "ollama") return true;
  if (provider !== "custom") return false;
  const base = (customBaseUrl || "").trim().toLowerCase();
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])([:\/]|$)/.test(base);
}

/** 这个配置是否已经可以用来发请求（不需要 Key 的供应商不填也算就绪） */
export function isProviderReady(
  assistant: { provider: AssistantProvider; customBaseUrl?: string },
  apiKey: string,
): boolean {
  if (isKeylessProvider(assistant.provider, assistant.customBaseUrl ?? "")) return true;
  return Boolean((apiKey ?? "").trim());
}

/**
 * 是否是 MiniMax 端点（api.minimax.cn / api.minimax.io / api.minimaxi.com 等）。
 *
 * 为什么需要单独判断：**MiniMax 的 M 系列默认开启 thinking**，且默认把思考内容
 * **以 `<think>` 标签保留在 `content` 字段内**（官方文档：`reasoning_split` 为 false 时
 * thinking 以 `<think>` 标签保留在 `content` 内）。
 * 本文件下面的流式解析只取 `delta.content`，于是"思考过程"会被当成正文显示在气泡里
 * —— 用户侧的表现就是"回复里混着思考过程和标签"。
 *
 * 开启 `reasoning_split` 后，thinking 被拆分到 `reasoning_content` 字段，
 * `content` 只留正文，解析逻辑**无需改动**。
 * 该开关对 M3 与 M2.x 都有效，且不依赖"能否关闭 thinking"——
 * 因为 `thinking: { type: "disabled" }` **对 M2.x 无效**，
 * 对 **M3.1-Flash-Preview 更会直接返回 400**（其 thinking 强制开启），
 * 所以不能把它当作通用手段来用。
 */
export function isMiniMaxEndpoint(base: string): boolean {
  return /minimax/i.test(base ?? "");
}

/**
 * 把 OpenAI 兼容响应里的 `content` 统一转成字符串。
 *
 * 大多数端点给字符串，但新版多模态 / 中转站可能给数组：
 *   [{ type: "text", text: "..." }, { type: "image_url", ... }]
 * 以前直接 `text += delta.content`，数组会被拼成 "[object Object]"，
 * 用户看到的就是"模型回了乱码/没回复"。这里只取文本片段，忽略图片等非文本部分。
 */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const p = part as { type?: string; text?: unknown; content?: unknown };
        if (typeof p.text === "string") return p.text;
        if (typeof p.content === "string") return p.content;
        return "";
      })
      .join("");
  }
  if (content && typeof content === "object") {
    const p = content as { text?: unknown; content?: unknown };
    if (typeof p.text === "string") return p.text;
    if (typeof p.content === "string") return p.content;
  }
  return "";
}

/** 从响应 JSON 里取一段可读的错误文本（OpenAI 的 {"error":{"message":...}} / 字符串） */
export function apiErrorMessage(json: unknown): string {
  const j = json as { error?: unknown; message?: unknown } | null | undefined;
  if (!j) return "";
  const err = j.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; code?: unknown; type?: unknown };
    if (typeof e.message === "string" && e.message.trim()) return e.message;
    if (typeof e.code === "string" && e.code.trim()) return e.code;
    if (typeof e.type === "string" && e.type.trim()) return e.type;
  }
  if (typeof j.message === "string" && j.message.trim()) return j.message;
  return "";
}

/**
 * 某些模型/中转站不支持 function calling：把 tools 发过去会直接 400。
 * 这不是"配置错了"，而是端点能力差异 —— 应该自动降级成纯文本请求再试一次，
 * 否则用户会看到"这个模型用不了"，其实只是不能调工具。
 */
export function shouldRetryWithoutTools(status: number, body: string): boolean {
  // 401/402/403/404/429 等都不是"工具字段不被支持"，重试没有意义
  if (![400, 422].includes(status)) return false;
  const t = (body || "").toLowerCase();
  // 明确的工具相关报错
  if (/tool|function[_ ]?call|function calling|tools?[_ ]?(are|is)?[_ ]?not|unknown[_ ]?field|unsupported|unrecognized|extra[_ ]?field|invalid[_ ]?(parameter|value)/i.test(t)) {
    return true;
  }
  // 很多中转站只回一句 "Bad Request" / "invalid request"，没有细节；
  // 这时也值得剥掉 tools 再试一次（最多多一次请求）。
  return t.length < 80 || /bad request|invalid request|参数|不支持/i.test(t);
}

/** 个别兼容端点不接受 stream=true（或只支持非流式）。识别这类报错后降级重试 */
export function shouldRetryNonStream(status: number, body: string): boolean {
  if (![400, 422].includes(status)) return false;
  return /stream|sse|流式/i.test(body || "") && /not|unsupported|invalid|不支持|拒绝/i.test(body || "");
}

/**
 * 不支持工具的端点降级后，历史里的 assistant.tool_calls / role=tool 也要清掉：
 * 只把 tools 字段删掉、却还带着一条 tool 结果，同样会 400。
 */
export function stripToolData(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool") continue;
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const content = (m.content ?? "").trim();
      if (!content) continue; // 只有 tool_calls、没有正文的 assistant 轮次，对纯文本端点没有意义
      const plain: ChatMessage = { role: m.role, content: m.content };
      if (m.name) plain.name = m.name;
      out.push(plain);
      continue;
    }
    out.push(m);
  }
  return out;
}

/** 模型名里明显不是对话模型的排除项（中转站的 /models 常把 embedding/tts/image 混在一起） */
const NON_CHAT_MODEL_RE =
  /(embed|embedding|rerank|whisper|tts|speech|transcri|audio|image|dall[-_ ]?e|moderation|bge|clip|stable[-_ ]?diffusion|sdxl|flux|ocr|guard|safety)/i;
/**
 * 这个模型名看起来是不是"非对话模型"（图像/语音/向量/审核…）。
 * 中转站的 /models 常把它们和聊天模型混在一起，用户很容易挑到 gpt-image-2 这种，
 * 然后 chat/completions 直接 400 —— 给一句能读懂的解释。
 */
export function looksLikeNonChatModel(name: string): boolean {
  return NON_CHAT_MODEL_RE.test(String(name || ""));
}

/** 名字像"生图模型"的特征（各家中转站叫法差别很大，尽量宽一点） */
const IMAGE_MODEL_RE =
  /(image|dall[-_ ]?e|flux|stable[-_ ]?diffusion|sdxl|kolors|seedream|imagen|midjourney|wanx|t2i|text2image|draw|paint|nano[-_ ]?banana)/i;

/** 这个模型名看起来能不能生图 */
export function looksLikeImageModel(name: string): boolean {
  return IMAGE_MODEL_RE.test(String(name || ""));
}

/**
 * 从 `/models` 列表里自动挑出生图模型。
 *
 * 用户的原话："生图模型不能用户填完 API、选完模型自动识别吗" —— 能：
 * 拉模型列表时顺手把像生图的挑出来，用户不用再单独填一遍名字。
 */
export function detectImageModels(models: string[]): string[] {
  const out: string[] = [];
  for (const m of models || []) {
    const name = String(m || "").trim();
    if (name && looksLikeImageModel(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** 对话模型的常见关键词，用于在候选里优先挑一个能聊的 */
const CHAT_MODEL_HINT_RE =
  /(chat|instruct|gpt|claude|deepseek|qwen|glm|llama|mixtral|gemini|grok|moonshot|kimi|yi-|ernie|command-r|mistral|sonnet|opus|haiku|o1|o3|o4)/i;

/**
 * 从 `/models` 返回的列表里挑一个默认对话模型。
 *
 * 之前直接选 `models[0]` —— 中转站的列表第一位经常是 text-embedding / tts / 画图模型，
 * 自动选完一发消息就 404/400，用户以为"中转站的模型都用不了"。
 */
export function pickDefaultChatModel(models: string[]): string {
  const all = (models || []).map((m) => String(m || "").trim()).filter(Boolean);
  if (!all.length) return "";
  const chatLike = all.filter((m) => !NON_CHAT_MODEL_RE.test(m));
  const pool = chatLike.length ? chatLike : all;
  return pool.find((m) => CHAT_MODEL_HINT_RE.test(m)) ?? pool[0] ?? "";
}

function resolveBase(provider: AssistantProvider, customBaseUrl: string): string {
  if (provider === "custom") {
    // 规范化：补 /v1、去掉多余的 /chat/completions。用户经常把完整请求地址直接贴进来，
    // 以前会再拼一次 /chat/completions 变成 .../v1/chat/completions/chat/completions。
    const b = normalizeOpenAIBase(customBaseUrl);
    if (!b) throw new Error("未设置自定义 API 端点 URL");
    return b;
  }
  return PROVIDERS[provider].base;
}

const BASE_PROMPT =
  "严格按照上面的人格设定说话，每一句话都符合该人设的语气、口吻、用词和情绪。不要像客服，不要像AI，你就是那个人。\n" +
  "【你是谁】Petra 是你自己的名字（应用名，你的第二名字）；你的第一名字是用户给你起的、写在上面人格设定里的那个，自称用第一名字。窗口标题或进程里出现 Petra、petra.exe、桌宠，都是**你自己的窗口**，不是主人在用别的软件，别提它、也别问「Petra 是什么」。\n" +
  "【工具能力】用户需要时可以：打开软件、查天气、调音量、搜网页、开网址、关网页、设提醒、锁屏、关机、查当前窗口、在桌面/文档/下载里新建文件或文件夹、读文件内容、改文件（改前自动备份）。改文件前先读一遍，改完说清楚改了什么、备份在哪。工具只在意图明确时调用，结果用符合人设的口语转述，失败就如实说。\n" +
  "【联网】遇到时效性信息（新闻、版本号、价格、赛事、人物近况、最近发生的事）或你自己拿不准的事实时，先调用 search_web 查真实网页再回答，不要凭记忆编造；搜到结果后用自己的话转述，别把整段摘要念出来。搜索失败（超时/没结果）时最多换个更短更常见的关键词再试一次，还不行就如实说「这次没查到」，不要硬编也不要反复重试。\n" +
  "【记忆】用户透露偏好/习惯/情绪就调用 remember；同一件事有新进展就用同主题再记一次（会覆盖旧的），用户纠正你时一定要记对的那条。记住是为了把话接得更准，不要拿出来炫耀「我记得」。\n" +
  "【旧任务】对话历史里几天前的计时、提醒、待办、约定默认已经结束或过期；除非用户明确问起，否则不要把它们当成当前正在做的事，也不要主动复述。\n" +
  "不要主动提工具能力，不要说\"作为AI\"之类的话。";

const TOOLS = [
  {
    type: "function",
    function: {
      name: "launch_application",
      description:
        "打开/启动本机已安装的软件时调用。只传应用名称，系统自动解析安装位置。",
      parameters: {
        type: "object",
        properties: { application: { type: "string", description: "应用名称，如\"网易云音乐\"、\"记事本\"、\"VS Code\"" } },
        required: ["application"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description:
        "执行一条 Windows cmd 只读查询命令（白名单：ipconfig/dir/ping/netstat/systeminfo/tasklist/whoami/tree/type/echo 等）。禁止修改/删除类操作。",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "要执行的完整 cmd 命令" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description: "把用户个人信息/偏好/习惯归档到长期记忆。category: identity/preference/habit/schedule/relationship/event/other；importance: 1核心 2重要 3琐碎。",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "要记住的内容，用简洁的中文陈述句" },
          category: { type: "string", enum: ["identity", "preference", "habit", "schedule", "relationship", "event", "other"], description: "记忆分类" },
          importance: { type: "number", description: "重要度 1-3，1=核心 2=重要 3=琐碎" },
        },
        required: ["content", "category", "importance"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_wrong_history",
      description: "当用户强烈纠正你之前记错的事实时，调用此工具删除旧对话里相关的错误对话。传入错误事实相关的具体关键词，系统会删除命中的完整旧对话轮次，保留用户本轮的纠正。此工具不修改长期记忆。",
      parameters: {
        type: "object",
        properties: {
          keywords: { type: "string", description: "错误事实相关的关键词，多个关键词用空格隔开，比如：没睡觉 熬夜 通宵" },
        },
        required: ["keywords"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_volume",
      description:
        "调节系统音量。传 level (0-100) 设置音量百分比，传 mute (true/false) 静音/取消静音。",
      parameters: {
        type: "object",
        properties: {
          level: { type: "number", description: "音量 0-100" },
          mute: { type: "boolean", description: "true=静音, false=取消静音" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_reminder",
      description: "定时提醒用户。传入分钟后触发，显示一条提醒气泡。",
      parameters: {
        type: "object",
        properties: {
          minutes: { type: "number", description: "多少分钟后提醒" },
          message: { type: "string", description: "提醒内容" },
        },
        required: ["minutes", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "获取当前天气信息，返回简短天气文字。无需参数。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_shutdown",
      description: "定时关机。传入分钟后自动关机（1~1440分钟）。",
      parameters: {
        type: "object",
        properties: {
          minutes: { type: "number", description: "多少分钟后关机" },
        },
        required: ["minutes"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_shutdown",
      description: "取消之前设定的定时关机。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_web",
      description:
        "联网搜索，返回真实网页的标题、链接和摘要（不是打开浏览器）。遇到时效性信息（新闻、版本号、价格、赛事、近况）或自己拿不准的事实时主动调用它查证，不要凭记忆编造。关键词用 2~5 个词的短查询效果最好；搜不到就换个说法再试一次，不要原地重复同一个词。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" },
        },    required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_url",
      description: "用系统默认浏览器打开一个网址（http/https）。用户给了具体链接时用它。",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "完整网址，需带 http:// 或 https://" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_web_page",
      description:
        "关闭浏览器里用户指定的那个网页（标签页）。keyword 传页面标题或站点名里的关键词，例如「bilibili」「淘宝」「那个视频」。只关一个：如果匹配到多个页面，工具会返回候选列表，你要先问用户是哪一个，不要自己猜。",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "要关闭的页面的关键词（页面标题或站点名的一部分，至少 2 个字）" },
        },
        required: ["keyword"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_path",
      description: "用系统默认程序打开本机的文件或文件夹（路径必须真实存在）。如「打开我的下载文件夹」。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "文件或文件夹的完整路径" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_entry",
      description:
        "新建文件夹或文件。路径必须是绝对路径，且只能建在 桌面/文档/下载 之内（其它位置会被拒绝）。is_dir=true 建文件夹；建文件时可传 content 直接写入内容。已存在的文件不会被覆盖（改内容请用 edit_text_file / write_text_file）。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "完整绝对路径，例如 D:\\桌面\\笔记\\todo.txt" },
          is_dir: { type: "boolean", description: "true=新建文件夹，false=新建文件" },
          content: { type: "string", description: "新建文件时的初始内容（可选）" },
        },
        required: ["path", "is_dir"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description:
        "用生图模型画一张图，**生成后自动保存到用户桌面**并把文件路径返回给用户。用户说「画一张…」「生成一张…图片」「来张壁纸」时调用。prompt 要写得具体：主体、风格、构图、颜色、光线。",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "画面描述（中文即可，越具体越好）" },
          size: { type: "string", description: "可选尺寸，如 1024x1024、1024x1536；不确定就别传" },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "copy_to_desktop",
      description:
        "把**已经存在的**文件复制到用户桌面（例如把刚生成的图放桌面、把别的目录里的图片拿过来）。用户说「把图片放到我桌面」「把那个文件弄到桌面」时调用。只需要源文件的完整路径。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "要复制的文件完整绝对路径" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_text_file",
      description:
        "读取一个文本文件的**内容**（不是用默认程序打开，那个用 open_path）。返回带行号信息的一段内容；文件很大时只会返回一部分（truncated=true），可以再用 start_line 接着读。二进制文件会被拒绝。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件完整绝对路径" },
          start_line: { type: "number", description: "从第几行开始读（1 基，默认 1）" },
          max_lines: { type: "number", description: "最多读多少行（默认 200，上限 2000）" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_text_file",
      description:
        "修改文件内容：把 old_string 精确替换成 new_string。old_string 必须与文件里的内容**完全一致**（含缩进和换行），所以通常先用 read_text_file 看一遍。匹配到多处时必须给出更长的唯一片段，或把 replace_all 设为 true。覆盖前会自动备份成 xxx.petra-bak。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件完整绝对路径" },
          old_string: { type: "string", description: "要被替换掉的原文（必须与文件内容完全一致）" },
          new_string: { type: "string", description: "替换成的新内容；传空串表示删除这段" },
          replace_all: { type: "boolean", description: "true=替换所有匹配（默认 false，多处匹配会报错让模型收敛）" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_text_file",
      description:
        "整个写入一个文件（覆盖或追加）。覆盖已有文件前会自动备份成 xxx.petra-bak；新建可执行/脚本类文件（exe/bat/ps1 等）会被拒绝。只是改几处内容时优先用 edit_text_file，避免误伤其它内容。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件完整绝对路径" },
          content: { type: "string", description: "要写入的完整内容" },
          mode: { type: "string", enum: ["overwrite", "append"], description: "overwrite=覆盖（默认），append=追加到末尾" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description:
        "列出文件夹里有什么（目录在前）。用户说「桌面有什么/我下载里那个文件叫啥」时用它先看一遍；小助手只能列 桌面/文档/下载 之内的目录。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "文件夹完整绝对路径" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_installed_apps",
      description: "列出开始菜单里可启动的软件名。用户想打开某个软件但你拿不准名字时，先查一次再调用 launch_application。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "active_window_title",
      description: "查看用户当前正在使用的窗口标题（知道主人在用什么软件）。用户问「我在干嘛/现在开着什么」时可用。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "capture_screen",
      description: "截取当前屏幕画面。当用户想让你「看屏幕/看看桌面/截图/我屏幕上有什么/帮我看看这个界面」时调用。调用后你会看到屏幕画面内容，可以据此回答用户关于屏幕上显示了什么的问题。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_idle_seconds",
      description: "查看用户已经多久没有操作电脑（秒）。用于判断主人在不在，例如要不要轻声问候。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "send_notification",
      description: "弹一条桌面通知给用户（标题+内容）。适合「帮我记一下/过会儿提醒」这类不需要打断的告知。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "通知标题，简短" },
          body: { type: "string", description: "通知正文" },
        },
        required: ["title", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lock_screen",
      description: "锁定电脑屏幕。仅在用户明确说「锁屏/离开一下」时调用。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "daily_card",
      description:
        "仅在用户明确说「抽卡/今日运势/来一发」时调用（每天一次，已抽过返回今天结果）。其他任何情况都不要调用，也不要主动提起抽卡。拿到结果后用你的人设风格点评，不要原样复述。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "view_diary",
      description:
        "仅在用户明确说「看日记/今天写了什么」时调用。不传日期返回最近 3 条摘要，传日期（YYYY-MM-DD）返回那天完整日记。",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "日期，格式 YYYY-MM-DD。留空则返回最近几条摘要。" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_chat_history",
      description:
        "搜索完整聊天历史（不受最近 120 条窗口限制）。用户问「之前/上次/以前/我说过/你让我/那个提醒/计时」等旧事，或需要确认过去约定时调用。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索关键词，尽量用用户提到的核心词" },
          days: { type: "number", description: "向前搜索多少天，默认 30；填 0 表示全部历史" },
          limit: { type: "number", description: "返回几条命中，默认 5，最多 10" },
        },
        required: ["query"],
      },
    },
  },
];

/** system prompt 最多注入的记忆条数（token 控制；聊天时按场景召回后再传入） */
const MAX_MEMORY_IN_PROMPT = 20;

/**
 * 流式响应两次数据之间的最长等待（毫秒）。
 *
 * 断网、代理挂住、服务端发完 [DONE] 却不关连接时，`reader.read()` 会**永远不返回**：
 * send() 的 finally 不执行 → busy 永久 true → 之后每条消息都被静默丢弃，只能重启。
 * 60 秒足够覆盖首 token 慢的思考模型，又不会让用户无限期地以为"正在生成"。
 */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/**
 * 版本与更新日志注入：让 AI 知道自己当前版本号和最近更新了什么。
 * 取 CHANGELOG 第一个 ## 段（Unreleased 或最新版）的 bullet，截断到合理长度，
 * 避免把整份更新历史塞进 system prompt 烧 token。
 */
let _versionInfoCache: string | null = null;
function buildVersionInfo(): string {
  if (_versionInfoCache !== null) return _versionInfoCache;
  const version: string = pkg?.version ?? "未知";
  // 解析 CHANGELOG：第一个 "## [" 段（Unreleased 或最新发布版）里的 "- " 条目
  const lines = (changelogRaw as string).split(/\r?\n/);
  const items: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (line.startsWith("## [")) {
      if (inSection) break;       // 下一个版本段开始 → 停
      inSection = true;
      continue;
    }
    if (inSection && line.trimStart().startsWith("- ")) {
      items.push(line.trim().replace(/^-\s*/, ""));
    }
  }
  // 截断：最多 12 条；总长不超过 1200 字符，超出就硬切
  let picked = items.slice(0, 12).join("\n· ");
  if (picked.length > 1200) picked = picked.slice(0, 1200) + "…";
  _versionInfoCache =
    `\n\n【你当前的版本】Petra v${version}` +
    `\n【最近更新内容】（主人可能会聊到；知道即可，不要主动推销，被问到时自然地聊）` +
    `\n· ${picked}`;
  return _versionInfoCache;
}

/** 组装 system prompt。导出是为了让测试能锁住"语言指令必须在最后"这条顺序（见 tests/assistant-tools.test.js）。 */
export function systemPrompt(
  persona: string,
  memory: MemoryStore,
  extraContext = "",
  profileText = "",
  historySummary = "",
): string {
  // 画像放 BASE_PROMPT 之后、记忆清单之前：
  // 先让模型知道"这是谁"，再看到具体条目；extraContext（语言指令）仍压在最尾部。
  const prof = profileText.trim() ? "\n\n" + profileText.trim() : "";
  // 更早对话的滚动摘要：补 buildMessages 窗口切掉的上下文（长聊不失忆）
  const hist = historySummary.trim() ? "\n\n" + historySummary.trim() : "";
  let mem = "";
  if (memory.length > 0) {
    // 按重要度排序，核心记忆在前，超限截断
    const sorted = [...memory].sort((a, b) => a.importance - b.importance).slice(0, MAX_MEMORY_IN_PROMPT);
    mem = "\n\n关于用户的记忆（按重要度排序）：\n" +
      sorted.map((m) => {
        const age = Date.now() - m.createdAt;
        const days = Math.floor(age / 86400000);
        const timeNote = days > 30 ? `（${Math.floor(days / 30)}个月前）` : days > 0 ? `（${days}天前）` : "（今天）";
        return `- [${m.category}] ${m.content} ${timeNote}`;
      }).join("\n");
  }
  // extraContext 放**最后**：它里面压着语言指令（"必须全程用日语回复"）。
  // 之前它排在 BASE_PROMPT 和记忆前面，后面紧跟着一大段中文，模型就顺着中文继续说中文
  // （"设置日语却回中文"的根因）。指令要放尾部，模型对末尾最敏感。
  return `${persona ? persona + "\n\n" : ""}${BASE_PROMPT}${prof}${mem}${hist}${extraContext ? "\n\n" + extraContext : ""}`;
}

/**
 * 修复非法的工具调用序列。
 *
 * OpenAI 兼容端点的硬性要求：每条 `role:"tool"` 必须紧跟带 tool_calls 的 assistant，
 * 且**每个 tool_call_id 都要有且只有一条结果**。实际运行中这套序列会被打断：
 *   - 工具执行中途抛异常/被取消/预算用尽 → assistant 有 tool_calls 但结果不全；
 *   - 历史被截断或「删除错误历史」删掉一半 → 出现孤立的 tool 消息。
 * 只要带上一次坏序列，之后**每一轮**请求都会 400，用户只能反复重发。
 * 这里在发送前统一修：序列完整就保留，不完整就整组丢掉（模型不该看到半截调用）。
 */
export function sanitizeToolHistory(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === "tool") {
      // 没有配对的 assistant（它的 tool_calls 已被删除）→ 丢掉
      i++;
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const ids = new Set(m.tool_calls.map((c) => c.id));
      const results: ChatMessage[] = [];
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") {
        results.push(messages[j]);
        j++;
      }
      const answered = new Set(results.map((r) => r.tool_call_id).filter(Boolean));
      const complete = results.length === ids.size && [...ids].every((id) => answered.has(id));
      if (complete) out.push(m, ...results);
      i = j;
      continue;
    }
    out.push(m);
    i++;
  }
  return out;
}

/** 上下文窗口管理：截断 history（最近 N 条 + 字符上限），记忆并入 system。
 *  截断时不切断 tool_calls 序列（不删除紧跟 tool 消息的 assistant 消息）。 */
function buildMessages(
  history: ChatMessage[],
  persona: string,
  memory: MemoryStore,
  extraContext = "",
  systemOverride = "",
  profileText = "",
  historySummary = "",
): ChatMessage[] {
  const MAX_MSGS = 120;
  const MAX_CHARS = 30000;
  // 先修序列再截断：坏序列留着会让整轮 400
  let msgs = sanitizeToolHistory(history).slice(-MAX_MSGS);
  // 定长切片可能正好从一条 tool 结果开始：OpenAI/DeepSeek 兼容端点要求 role=tool
  // 必须紧跟带 tool_calls 的 assistant，否则整轮直接 400。历史是持久化且不限长的，
  // 用过工具/日记/文件的长会话迟早会踩到。
  msgs = sanitizeToolHistory(msgs);
  let total = msgs.reduce((s, m) => s + (m.content?.length ?? 0), 0);
  while (msgs.length > 2 && total > MAX_CHARS) {
    // 若下一条是 tool 消息，说明当前是带 tool_calls 的 assistant，不能删
    if (msgs[1]?.role === "tool") break;
    total -= msgs[0].content?.length ?? 0;
    msgs = msgs.slice(1);
  }
  // 字符裁剪同样可能裁出孤立 tool（比如裁掉 assistant 那一轮）
  msgs = sanitizeToolHistory(msgs);
  // systemOverride：轻量调用（如麻将实时点评）用它替代完整系统提示，省掉 BASE_PROMPT 与记忆
  const system = systemOverride || systemPrompt(persona, memory, extraContext, profileText, historySummary);
  return [{ role: "system", content: system }, ...msgs];
}

/**
 * 把截图挂到最后一条 user 消息上 —— 转成 OpenAI 的多模态 content 数组：
 *   content: [ { type: "text", ... }, { type: "image_url", image_url: { url } } ]
 *
 * 为什么不直接改 `ChatMessage.content` 的类型：那个类型被 4 个文件引用，
 * 放宽成数组会连带影响 buildMessages 的字符统计、历史序列化、气泡渲染。
 * 这里**只在"发出去的那一份"上做转换**，历史与类型都不动，改动面最小。
 *
 * 没有截图 / 历史里没有 user 消息时原样返回。
 */
function attachScreenImage(messages: ChatMessage[], images?: string[] | string): unknown {
  const list = Array.isArray(images) ? images.filter(Boolean) : images ? [images] : [];
  if (!list.length) return messages;
  let idx = -1;
  for (let n = messages.length - 1; n >= 0; n--) {
    if (messages[n].role === "user") { idx = n; break; }
  }
  if (idx < 0) return messages;
  return messages.map((m, n) =>
    n !== idx
      ? m
      : {
          ...m,
          content: [
            { type: "text", text: m.content ?? "" },
            ...list.map((url) => ({ type: "image_url", image_url: { url } })),
          ],
        },
  );
}

/** 兼容端点的请求头：没有 Key 时不要发 `Bearer `（部分本地服务/中转站会因此 400） */
function chatHeaders(apiKey: string, accept = "text/event-stream"): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: accept,
  };
  const key = (apiKey || "").trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

/** 一次请求都没填模型名时，按端点自动挑一个对话模型（只在内存里缓存，不写用户设置） */
const AUTO_MODEL_CACHE = new Map<string, string>();

async function resolveModelForRequest(
  provider: AssistantProvider,
  model: string,
  apiKey: string,
  base: string,
  customBaseUrl: string,
): Promise<string> {
  const explicit = (model || "").trim();
  if (explicit) return explicit;
  const fallback = PROVIDERS[provider]?.defaultModel?.trim();
  if (fallback) return fallback;
  // 自定义端点（自定义/中转站）没有默认模型：先问一次 /models，再挑一个像聊天模型的。
  // 这样用户只填了端点 + Key、忘了填模型时也能直接开聊；失败时给出可操作的提示。
  const cached = AUTO_MODEL_CACHE.get(base);
  if (cached) return cached;
  let models: string[] = [];
  try {
    models = await listModels(provider, apiKey, customBaseUrl);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`未设置模型名，且自动获取模型失败：${detail}`);
  }
  const picked = pickDefaultChatModel(models);
  if (!picked) {
    throw new Error("未设置模型名：该端点没有返回可用模型，请手动填写模型名（中转站常需要手动填）");
  }
  AUTO_MODEL_CACHE.set(base, picked);
  return picked;
}

/**
 * 「测试连接」专用：用最小的一次非流式对话请求验证 端点 + Key + 模型。
 *
 * 为什么不用 /models：很多中转站不实现 /models，但 /chat/completions 完全正常。
 * 只测 /models 会把能用的端点误判成"连接失败"。
 * 返回值是实际使用的模型名，方便面板提示。
 */
export async function probeChatConnection(
  provider: AssistantProvider,
  apiKey: string,
  model: string,
  customBaseUrl: string,
): Promise<{ model: string }> {
  const base = resolveBase(provider, customBaseUrl);
  const m = await resolveModelForRequest(provider, model, apiKey, base, customBaseUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: chatHeaders(apiKey, "application/json"),
      body: JSON.stringify({
        model: m,
        messages: [{ role: "user", content: "只回复 OK" }],
        max_tokens: 8,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    const raw = await res.text().catch(() => "");
    let json: unknown = null;
    try { json = raw ? JSON.parse(raw) : null; } catch { /* 非 JSON 错误体 */ }
    if (!res.ok) {
      const detail = apiErrorMessage(json) || raw.slice(0, 200) || `HTTP ${res.status}`;
      throw new Error(`HTTP ${res.status}：${detail}`);
    }
    const err = apiErrorMessage(json);
    if (err) throw new Error(err);
    // 有些端点 200 但 body 是 HTML/代理页；至少要求能解析出 choices 或 message
    const choices = (json as { choices?: unknown[] } | null)?.choices;
    if (json && !Array.isArray(choices)) {
      throw new Error("端点返回的内容不是 OpenAI 兼容格式（缺少 choices）");
    }
    return { model: m };
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("请求超时（20 秒）");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 网页端 fetch 彻底失败时的兜底：改用 Rust 发同一份请求（非流式）。
 *
 * 触发场景实测过：WebView 里报 `Failed to fetch`，而同一时刻 Rust 的天气/歌词请求
 * 一切正常。这时把请求体改 `stream:false` 交给 Rust，能拿回完整回复，
 * 前端一次性 push 出文字（虽然丢了逐字效果，但比"网络不可用"强得多）。
 */
async function chatViaRust(opts: {
  url: string;
  apiKey: string;
  body: string;
  onDelta: (t: string) => void;
  requestOptions: ChatRequestOptions;
}): Promise<{ text: string; toolCalls: ToolCall[]; usage: ChatUsage } | null> {
  let parsed: { stream?: boolean; model?: string } = {};
  try {
    parsed = JSON.parse(opts.body);
  } catch {
    return null;
  }
  const body = JSON.stringify({ ...parsed, stream: false });
  const res = await invoke<{ status: number; body: string }>("http_post_json", {
    url: opts.url,
    headers: [
      ["Content-Type", "application/json"],
      ["Accept", "application/json"],
      ...(opts.apiKey.trim() ? [["Authorization", `Bearer ${opts.apiKey.trim()}`]] : []),
    ],
    body,
    timeoutSecs: 180,
  });
  if (!res || res.status < 200 || res.status >= 300) {
    throw new Error(`Rust 兜底也被拒：HTTP ${res?.status ?? 0} ${(res?.body ?? "").slice(0, 200)}`);
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    throw new Error(`Rust 兜底返回的不是 JSON：${res.body.slice(0, 120)}`);
  }
  const choices = (json as { choices?: unknown }).choices;
  const first = Array.isArray(choices) ? (choices[0] as Record<string, unknown>) : undefined;
  const msg = (first?.message ?? {}) as Record<string, unknown>;
  const rawContent = msg.content;
  const text = typeof rawContent === "string"
    ? rawContent
    : Array.isArray(rawContent)
      ? rawContent.map((p) => (p as { text?: string }).text ?? "").join("")
      : "";
  if (text) opts.onDelta(text);
  const rawCalls = Array.isArray(msg.tool_calls) ? (msg.tool_calls as Record<string, unknown>[]) : [];
  const toolCalls: ToolCall[] = rawCalls
    .map((c) => {
      const fn = (c.function ?? {}) as { name?: string; arguments?: string };
      const safe = parseArgsSafe(fn.arguments ?? "{}");
      return {
        id: String(c.id ?? `rust_${Math.random().toString(36).slice(2)}`),
        name: String(fn.name ?? ""),
        args: safe.args,
        argsError: safe.error,
      };
    })
    .filter((c) => c.name);
  const usage: ChatUsage = { input: 0, output: 0, cached: 0, source: "estimated" };
  return { text, toolCalls, usage };
}

/** OpenAI 兼容流式 chat；返回完整文本 + 工具调用。enableTools=false 时不带 tools（纯文本生成，如日记/抽卡文案） */
export async function chatStream(
  provider: AssistantProvider,
  apiKey: string,
  model: string,
  history: ChatMessage[],
  persona: string,
  memory: MemoryStore, customBaseUrl: string,
  onDelta: (t: string) => void,
  enableTools = true,
  extraContext = "",
  systemOverride = "",
  requestOptions: ChatRequestOptions = {},
): Promise<{ text: string; toolCalls: ToolCall[]; usage: ChatUsage }> {
  const base = resolveBase(provider, customBaseUrl);
  const m = await resolveModelForRequest(provider, model, apiKey, base, customBaseUrl);
  if (!m) throw new Error("未设置模型名");
  const baseMessages = buildMessages(
    history, persona, memory, extraContext, systemOverride,
    requestOptions.profileText ?? "", requestOptions.historySummary ?? "",
  );
  // 插件工具是运行时注册的：每次请求都重新拼一份，不能缓存在模块级常量里。
  const off = new Set(requestOptions.disabledTools ?? []);
  const toolDefs = enableTools
    ? [...TOOLS, ...(requestOptions.extraTools ?? [])].filter((t) => {
        const name = (t as { function?: { name?: string } }).function?.name ?? "";
        return !off.has(name);
      })
    : [];
  // 支持流式 usage 回传的提供商白名单（其余端点可能拒绝未知字段）
  const supportsStreamUsage = USAGE_STREAM_PROVIDERS.has(provider);

  // 某些模型/中转站不支持 tools 或 stream：同一端点降级过一次后记住，后续请求直接走兼容模式，
  // 不要每条消息都先失败一次。
  const compatKey = `${base}||${m}`;
  let useTools = enableTools && !NO_TOOLS_ENDPOINTS.has(compatKey);
  let useStream = true;

  const bodyFor = (toolsOn: boolean, streamOn: boolean): string => {
    const messages = toolsOn ? baseMessages : stripToolData(baseMessages);
    return JSON.stringify({
      model: m,
      messages: attachScreenImage(
        messages,
        [...(requestOptions.screenImage ? [requestOptions.screenImage] : []), ...(requestOptions.userImages ?? [])],
      ),
      // 不支持工具的端点（不少本地模型/中转站/推理模型）一旦带上 tools 就会 400；
      // 降级后这里自动不带，历史里的 tool_calls 也由 stripToolData 清掉。
      ...(toolsOn && toolDefs.length ? { tools: toolDefs } : {}),
      ...(streamOn && supportsStreamUsage ? { stream_options: { include_usage: true } } : {}),
      ...(requestOptions.maxOutputTokens ? { max_tokens: requestOptions.maxOutputTokens } : {}),
      // MiniMax：让思考内容与正文分离（详见 isMiniMaxEndpoint 的说明）。
      // 只对 MiniMax 端点发送，避免其他兼容端点拒绝未知字段。
      ...(isMiniMaxEndpoint(base) ? { reasoning_split: true } : {}),
      stream: streamOn,
    });
  };

  // 偶发失败自动重试：限流(429)、网关/服务端 5xx、408、以及网络层直接失败，
  // 都是"过一会儿再发就好了"的类型 —— 以前只能弹错误让用户手动重发。
  // 注意只在**还没开始接收流**时重试，避免把已经吐出来的文字重复一遍。
  let res: Response | null = null;
  let errText = "";
  let lastStatus = 0;
  const netErrors: string[] = [];
  /** 已经试过一次 Rust 兜底了吗（只试一次，避免死循环） */
  let triedRust = false;
  /** 网络层失败后是否已经退回过非流式 */
  let triedNonStream = false;
  for (let compat = 0; compat < 3; compat++) {
    const requestBody = bodyFor(useTools, useStream);
    let attemptRes: Response | null = null;
    errText = "";
    lastStatus = 0;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        attemptRes = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: chatHeaders(apiKey, useStream ? "text/event-stream" : "application/json"),
          body: requestBody,
          signal: requestOptions.signal,
        });
      } catch (e) {
        if (requestOptions.signal?.aborted) throw e;
        netErrors.push(e instanceof Error ? e.message : String(e));
        if (attempt < RETRY_DELAYS_MS.length) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
          continue;
        }
        // 有些中转站的流式连接会被中间设备掐断（表现就是 Failed to fetch）：
        // 先退回非流式在**网页端**再试一次，通了就继续走正常解析路径。
        if (useStream && !triedNonStream) {
          triedNonStream = true;
          useStream = false;
          continue;
        }
        // 网页端彻底连不上：换 Rust 再发一次（同一份请求体）
        if (!triedRust) {
          triedRust = true;
          try {
            const viaRust = await chatViaRust({
              url: `${base}/chat/completions`,
              apiKey,
              body: bodyFor(useTools, false),
              onDelta,
              requestOptions,
            });
            if (viaRust) return viaRust;
          } catch (rustErr) {
            netErrors.push(`Rust 兜底也失败：${rustErr instanceof Error ? rustErr.message : String(rustErr)}`);
          }
        }
        throw new Error(
          `网络错误：${netErrors[netErrors.length - 1] || "请求失败"}`
          + `（网页端重试 ${netErrors.length} 次仍失败，Rust 兜底也不通；`
          + `请检查网络/代理，或确认该端点允许被跨域访问：${base}）`,
        );
      }
      if (attemptRes.ok && attemptRes.body) break;
      lastStatus = attemptRes.status;
      errText = await attemptRes.text().catch(() => "");
      if (isRetryableStatus(attemptRes.status) && attempt < RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      break;
    }
    if (attemptRes && attemptRes.ok && attemptRes.body) {
      res = attemptRes;
      break;
    }
    // 1) 工具字段不被支持 → 去掉 tools / tool 历史再试。
    // 先不写入 NO_TOOLS_ENDPOINTS：只有这次降级真的成功才记住，
    // 免得把"模型名写错 / 参数问题"的 400 也当成端点不支持工具而永久禁用。
    if (useTools && shouldRetryWithoutTools(lastStatus, errText)) {
      useTools = false;
      continue;
    }
    // 2) 流式不被支持 → 改非流式再试
    if (useStream && shouldRetryNonStream(lastStatus, errText)) {
      useStream = false;
      continue;
    }
    const hint = provider === "custom"
      ? " (自定义/中转站端点：请确认 URL 是否带 /v1、模型名是否与中转站文档一致)"
      : "";
    // 选了图像/语音类模型时，端点只会回一句 Upstream request failed / 400 —— 这里补一句人话
    const nonChat = looksLikeNonChatModel(m)
      ? "（这个模型看起来是图像/语音类模型，不是对话模型，换一个聊天模型试试，比如 deepseek-chat、gpt-4o-mini）"
      : "";
    throw new Error(`API 错误 ${lastStatus || 0}${hint}: ${errText.slice(0, 300)}${nonChat}`);
  }
  if (!res || !res.body) {
    throw new Error(`API 错误 ${lastStatus || 0}: ${errText.slice(0, 300) || "没有收到响应"}`);
  }
  // 只有"带 tools 失败、去掉 tools 后成功"才把端点记为不支持工具
  if (enableTools && !useTools) NO_TOOLS_ENDPOINTS.add(compatKey);

  const finalMessages = useTools ? baseMessages : stripToolData(baseMessages);
  const inputTokens = estimateTokens(JSON.stringify(finalMessages))
    + (useTools ? estimateToolsTokens(toolDefs) : 0) + 4;

  let text = "";
  const toolCalls: { id: string; name: string; args: string }[] = [];
  let serverUsage: { input: number; output: number; cached: number } | null = null;
  let sawDone = false;

  const appendToolDelta = (calls: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>) => {
    for (let i = 0; i < calls.length; i++) {
      const tc = calls[i];
      // 流式分片一般带 index；非流式返回的完整 tool_calls 不带 index，用数组下标兜底
      // （否则多个 tool call 会全被塞进第 0 个，后面的调用直接丢失）。
      const idx = tc.index ?? i;
      toolCalls[idx] ??= { id: tc.id ?? "", name: "", args: "" };
      if (tc.id) toolCalls[idx].id = tc.id;
      if (tc.function?.name) {
        // 分片拼接：有的兼容端点第一帧只给名字，有的每帧都重发**完整**名字，
        // 直接 += 会拼出 "run_shellrun_shell"，这里按前缀判断一下
        const cur = toolCalls[idx].name;
        const frag = tc.function.name;
        toolCalls[idx].name = !cur ? frag : frag.startsWith(cur) ? frag : cur.endsWith(frag) ? cur : cur + frag;
      }
      if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments;
    }
  };

  /** 处理一条完整的 OpenAI chunk（流式/非流式、标准 message/delta 都兼容） */
  const handleChunkJson = (json: unknown): void => {
    const j = json as {
      error?: unknown;
      choices?: Array<{
        text?: unknown;
        delta?: {
          content?: unknown;
          tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
          function_call?: { name?: string; arguments?: string };
        };
        message?: {
          content?: unknown;
          tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
        };
      }>;
      usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    } | null | undefined;
    if (!j) return;
    const err = apiErrorMessage(j);
    if (err) throw new Error(`API 错误：${err}`);
    const choice = j.choices?.[0];
    const delta = choice?.delta;
    const message = choice?.message;
    const piece = contentToText(delta?.content)
      || contentToText(message?.content)
      || contentToText(choice?.text);
    if (piece) {
      text += piece;
      onDelta(piece);
    }
    if (Array.isArray(delta?.tool_calls)) appendToolDelta(delta.tool_calls);
    if (Array.isArray(message?.tool_calls)) appendToolDelta(message.tool_calls);
    // 老式 function_call（部分兼容端点仍用这个字段）
    if (delta?.function_call?.name) {
      appendToolDelta([{
        index: 0,
        type: "function",
        function: { name: delta.function_call.name, arguments: delta.function_call.arguments ?? "" },
      }]);
    }
    // usage：{ prompt_tokens, completion_tokens, prompt_tokens_details.cached_tokens }
    const u = j.usage;
    if (u && (typeof u.total_tokens === "number" || typeof u.prompt_tokens === "number")) {
      serverUsage = {
        input: u.prompt_tokens ?? inputTokens,
        output: u.completion_tokens ?? 0,
        cached: u.prompt_tokens_details?.cached_tokens ?? 0,
      };
    }
  };

  const consumeSseLine = (rawLine: string): void => {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === "[DONE]") {
      // 收到 [DONE] 就主动结束：有的端点在 [DONE] 之后保持连接不关，
      // 继续 read 会一直挂到超时。
      sawDone = true;
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return; // 忽略不完整/非 JSON 行
    }
    handleChunkJson(json);
  };

  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  // 服务端无视 stream=true、直接回了一整段 JSON（一些中转站会这样）：按非流式解析，
  // 否则我们的 SSE 解析器一条 data: 都读不到，用户看到空回复。
  const responseIsJson = contentType.includes("application/json") && !contentType.includes("event-stream");
  if (!useStream || responseIsJson) {
    const raw = await res.text();
    let json: unknown = null;
    try { json = raw ? JSON.parse(raw) : null; } catch { /* 可能是被标错 content-type 的 SSE */ }
    if (json) {
      handleChunkJson(json);
    } else {
      for (const line of raw.split(/\r?\n/)) consumeSseLine(line);
    }
  } else {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // 没有任何新数据超过这个时间就认为连接已死：断网/代理挂住/服务端发完 [DONE] 却不关连接
    // 都会让 reader.read() 永远不返回，send() 的 finally 不执行 → busy 永久 true，
    // 之后每条消息都被静默丢弃，只能重启。这里给每次 read 套一个空闲超时。
    const idleTimeoutMs = requestOptions.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    try {
      for (;;) {
        if (requestOptions.signal?.aborted) {
          void reader.cancel().catch(() => {});
          throw new Error("已取消");
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        let chunk: { done: boolean; value?: Uint8Array };
        try {
          chunk = await Promise.race([
            reader.read() as Promise<{ done: boolean; value?: Uint8Array }>,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`响应超时：${Math.round(idleTimeoutMs / 1000)} 秒没有收到新数据（网络或服务端卡住了）`)),
                idleTimeoutMs,
              );
            }),
          ]);
        } catch (err) {
          // 超时/中止后必须把底层流关掉，否则悬挂的 read 会一直占着连接
          void reader.cancel().catch(() => {});
          throw err;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
        const { done, value } = chunk;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const rawLine of lines) {
          consumeSseLine(rawLine);
          if (sawDone) break;
        }
        if (sawDone) {
          // [DONE] 之后连接可能还挂着，主动取消读取，别让下一次 read 干等
          void reader.cancel().catch(() => {});
          break;
        }
      }
      // 流结束前最后一行可能没有换行符
      if (!sawDone && buffer.trim()) {
        for (const line of buffer.split(/\r?\n/)) consumeSseLine(line);
      }
    } catch (err) {
      void reader.cancel().catch(() => {});
      throw err;
    }
  }

  const parsed: ToolCall[] = toolCalls
    .map((tc) => {
      // 参数解析失败也**保留**这次调用：回一条"参数不合法"的 tool 结果让模型重发，
      // 静默丢掉会让模型以为自己调过了，然后一遍遍重复同一个调用。
      const safe = parseArgsSafe(tc.args);
      return {
        id: tc.id || `local_${Math.random().toString(36).slice(2)}`,
        name: tc.name,
        args: safe.args,
        argsError: safe.error,
      };
    })
    .filter((tc) => tc.name);
  const outputTokens = estimateTokens(text) + estimateTokens(toolCalls.map((t) => t.args).join(" "));
  // 服务端有真实 usage 时优先用真实值
  // TS 的控制流分析看不到 handleChunkJson 闭包里的赋值，这里显式取一次当前值
  const finalServerUsage = serverUsage as { input: number; output: number; cached: number } | null;
  const usage: ChatUsage = finalServerUsage
    ? { input: finalServerUsage.input, output: finalServerUsage.output, cached: finalServerUsage.cached, source: "server" }
    : { input: inputTokens, output: outputTokens, cached: 0, source: "estimated" };
  recordUsage(usage.input, usage.output, usage.cached);
  requestOptions.onUsage?.(usage);
  return { text, toolCalls: parsed, usage };
}

// ==================== 本地 token 估算与用量统计 ====================
// 说明：不依赖服务端 usage 字段（各厂商流式支持不一致），用字符规则本地估算，
// 仅用于给用户展示相对用量趋势，非计费依据。

export interface UsageStats {
  calls: number;       // 总调用次数
  inputTokens: number; // 输入 token（服务端 usage 可用时用真实值，否则本地估算）
  outputTokens: number; // 输出 token
  cachedTokens: number; // 服务端报告的前缀缓存命中 token（DeepSeek 等）
  lastInput: number;
  lastOutput: number;
  lastCached: number;
  lastAt: number;
}

const USAGE_KEY = "petra-token-usage";
/** 支持流式 stream_options.include_usage 的提供商白名单（OpenAI 兼容且实测支持） */
const USAGE_STREAM_PROVIDERS: ReadonlySet<string> = new Set([
  "deepseek", "openai", "moonshot", "qwen", "siliconflow", "openrouter", "groq",
]);
const DEFAULT_USAGE: UsageStats = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, lastInput: 0, lastOutput: 0, lastCached: 0, lastAt: 0 };
let toolsTokensCache = -1;
let toolsTokensKey = "";

/** 估算一段文本的 token 数：中文≈0.8/字，其他≈3.6 字/token，emoji≈1 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isCjk =
      (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意
      (code >= 0x3000 && code <= 0x30ff) || // CJK 标点/假名
      (code >= 0xff00 && code <= 0xffef) || // 全角
      code > 0x10000;                        // emoji 等
    if (isCjk) cjk++;
    else other++;
  }
  return Math.max(1, Math.round(cjk * 0.8 + other / 3.6));
}

/** 工具定义整体 token 估算（按当前工具集合缓存；插件热加载后自动失效） */
function estimateToolsTokens(tools: unknown[]): number {
  const key = JSON.stringify(tools);
  if (toolsTokensCache < 0 || toolsTokensKey !== key) {
    toolsTokensCache = estimateTokens(key) + 8;
    toolsTokensKey = key;
  }
  return toolsTokensCache;
}

export function getUsageStats(): UsageStats {
  try {
    const raw = localStorage.getItem(USAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return { ...DEFAULT_USAGE, ...p };
    }
  } catch {
    /* 忽略 */
  }
  return { ...DEFAULT_USAGE };
}

export function resetUsageStats(): void {
  try {
    localStorage.removeItem(USAGE_KEY);
  } catch {
    /* 忽略 */
  }
}

function recordUsage(input: number, output: number, cached = 0): void {
  try {
    const s = getUsageStats();
    s.calls++;
    s.inputTokens += input;
    s.outputTokens += output;
    s.cachedTokens += cached;
    s.lastInput = input;
    s.lastOutput = output;
    s.lastCached = cached;
    s.lastAt = Date.now();
    localStorage.setItem(USAGE_KEY, JSON.stringify(s));
  } catch {
    /* 忽略 */
  }
}

/**
 * 解析模型列表（纯函数，便于单测）：
 * - OpenAI 兼容格式：{ data: [{ id }] }
 * - Ollama 原生格式：{ models: [{ name/model }] }
 */
export function parseModelList(json: unknown): string[] {
  const out = new Set<string>();
  const addObject = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    const o = v as { id?: unknown; name?: unknown; model?: unknown; slug?: unknown; model_name?: unknown };
    for (const key of ["id", "name", "model", "slug", "model_name"] as const) {
      const val = o[key];
      if (typeof val === "string" && val.trim()) {
        out.add(val.trim());
        return;
      }
    }
  };
  // 中转站/代理的返回格式很杂：OpenAI 的 {data:[{id}]}、Ollama 的 {models:[{name}]}，
  // 还有 {data:{models:["a","b"]}}、直接返回 ["a","b"]、甚至套一层 result/items。
  // 以前只认前两种，导致"自动获取模型"失败、模型名留空，最后每条消息都发不出去。
  const walk = (node: unknown, depth: number) => {
    if (node == null || depth > 4) return;
    if (typeof node === "string") {
      // 单个字符串不是模型列表；只有数组里的字符串才当模型名（见下面的 Array 分支）
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        if (typeof item === "string") addObject({ id: item });
        else if (item && typeof item === "object") addObject(item);
        else walk(item, depth + 1);
      }
      return;
    }
    if (typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    // 有 id/name 的对象本身就是一个模型项
    if (["id", "name", "model", "slug", "model_name"].some((k) => typeof obj[k] === "string")) {
      addObject(obj);
    }
    for (const key of ["data", "models", "result", "results", "items", "model_list"]) {
      if (key in obj) walk(obj[key], depth + 1);
    }
  };
  walk(json, 0);
  return [...out];
}

/** Ollama 原生接口在 /api/tags，去掉可能存在的 /v1 尾巴 */
function ollamaOrigin(base: string): string {
  return base.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** 请求一个端点并解析模型列表 */
async function fetchModelList(url: string, apiKey: string): Promise<string[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${body ? ": " + body.slice(0, 100) : ""}`);
    }
    return parseModelList(await res.json());
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("请求超时（8 秒）");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉取可用模型列表。
 *
 * Ollama 优先走**原生接口 /api/tags**：老版本 Ollama 没有 OpenAI 兼容的 /v1/models，
 * 直接查 /v1/models 会 404，于是"明明装了很多模型却列不出来"。失败再退回 /v1/models。
 */
export async function listModels(
  provider: AssistantProvider,
  apiKey: string,
  customBaseUrl: string,
  /** 过滤统计回调：告诉调用方"站点返回了多少、过滤掉多少"，面板才能解释"为什么只有这么几个" */
  onStats?: (info: { raw: string[]; kept: string[]; imageModels: string[] }) => void,
): Promise<string[]> {
  const base = resolveBase(provider, customBaseUrl);
  const useOllamaApi = provider === "ollama" || /:11434(\/|$)/.test(base);
  const urls = useOllamaApi ? [`${ollamaOrigin(base)}/api/tags`, `${base}/models`] : [`${base}/models`];

  const errors: string[] = [];
  /** 失败到底是"Key 不对"还是"这个端点没有 /models"，两者给的建议完全不同 */
  let authFailed = false;
  let noModelsApi = false;
  for (const url of urls) {
    try {
      const arr = await fetchModelList(url, apiKey);
      if (arr.length) {
        // 中转站常把图像/语音/向量模型混在同一个列表里（比如 gpt-image-2），
        // 选错就是 400。这里只留像对话模型的；万一全被过滤就原样返回，别让用户没得选。
        const chatLike = arr.filter((m) => !looksLikeNonChatModel(m));
        const kept = chatLike.length ? chatLike : arr;
        onStats?.({ raw: arr, kept, imageModels: detectImageModels(arr) });
        return kept;
      }
      errors.push(`${url}：返回了空的模型列表`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${url}：${msg}`);
      if (/HTTP\s*(401|403)|无效的令牌|Invalid token|Unauthorized|invalid_api_key/i.test(msg)) authFailed = true;
      if (/HTTP\s*(404|405|501)|not\s*found|不支持|Invalid URL/i.test(msg)) noModelsApi = true;
    }
  }
  const localHint = /(localhost|127\.0\.0\.1)/.test(base)
    ? "（本地服务：若报 Failed to fetch，多半是浏览器跨域被拦——给服务设 OLLAMA_ORIGINS=* 后重启即可）"
    : "";
  // 按失败原因给**对应**的建议。
  // 以前不管什么原因都追加"很多中转站不提供 /models" —— 用户 Key 填错（401）时看到
  // 这句会以为"是站点不支持、不是我的问题"，反而找不到真正原因。
  let hint = "";
  if (authFailed) {
    hint = "（这是 Key 的问题：请到中转站/供应商后台重新生成一个 API Key，粘贴时注意别带上空格或换行；换 Key 后可以再点一次「获取模型列表」）";
  } else if (noModelsApi && provider === "custom") {
    hint = "（这个端点没有 /models 接口，但不影响聊天：直接在「模型名」里手动填写中转站文档里写的模型名即可）";
  } else if (provider === "custom") {
    hint = "（若确认 Key 没错，可能就是站点不提供 /models：直接在「模型名」里手填模型名即可）";
  }
  throw new Error(errors.join("；") + localHint + hint);
}

/**
 * 只拉"生图模型"清单。
 *
 * 生图有自己独立的端点（生图接入的 base），所以这里直接收 base 而不是对话用的 provider。
 * 失败时抛错：面板要能告诉用户"是 Key 错了还是这个站没有 /models"；
 * 工具调用那边用 listImageModelsSafe() 包一层，失败就当没有清单。
 */
export async function listImageModels(base: string, apiKey: string): Promise<string[]> {
  if (!base) return [];
  return detectImageModels(await fetchModelList(`${base}/models`, apiKey));
}

/** 工具调用用的静默版：拿不到就返回空清单，不打断生图（还有兜底模型可选） */
export async function listImageModelsSafe(base: string, apiKey: string): Promise<string[]> {
  try {
    return await listImageModels(base, apiKey);
  } catch {
    return [];
  }
}

export interface GeneratedImage {
  /** PNG/JPEG 的 base64（不带 data: 前缀）；服务端只回 url 时为空 */
  base64?: string;
  /**
   * 服务端给的图片地址。
   * **不在网页里下载**：对象存储（Cloudflare R2 等）不带 CORS 头，网页 fetch 会直接
   * 报 Failed to fetch；交给 Rust 的 `save_image_from_url` 去下。
   */
  url?: string;
  /** 实际画成功的是哪个模型（自动兜底后可能与请求的不一样） */
  model: string;
  /** 服务端可能改写过的提示词 */
  revisedPrompt?: string;
}

/**
 * 这个失败是不是"该换下一个模型试试"。
 *
 * 中转站的 `/models` 会列出**没开通渠道**的模型（实测某站列了 gpt-image-2.6-flare，
 * 一调就 503 `model_not_found: No available channel for model ... under group default`）。
 * 这类错误换个模型多半就好了，不能直接判死刑。
 */
function isModelUnavailable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /model_not_found|No available channel|HTTP\s*(404|503)|not\s*found|无可用渠道|没有可用/i.test(msg);
}


/**
 * 调用 OpenAI 兼容的 `/images/generations` 画一张图。
 *
 * 各家中转站实现差异很大：有的只回 `b64_json`、有的只回 `url`、有的把 `data`
 * 包在别的字段里，所以这里做了两重兼容；失败时也把服务端原文带出来，别只说"失败了"。
 */
export async function generateImage(opts: {
  /** 生图接入解析出来的 base（已经是 …/v1 这种形态） */
  base: string;
  apiKey: string;
  model: string;
  /** 备选模型：第一个失败（没开通渠道之类）就换下一个试 */
  fallbackModels?: string[];
  prompt: string;
  size?: string;
  /** 外部取消信号（用户在进度气泡上点"取消"） */
  signal?: AbortSignal;
}): Promise<GeneratedImage> {
  const base = String(opts.base || "").replace(/\/+$/, "");
  if (!base) throw new Error("还没有配置生图接入：控制面板 → 小助手 → 生图模型接入");
  const candidates: string[] = [];
  for (const m of [opts.model, ...(opts.fallbackModels ?? [])]) {
    const name = (m || "").trim();
    if (name && !candidates.includes(name)) candidates.push(name);
  }
  if (!candidates.length) throw new Error("还没有可用的生图模型：去「控制面板 → 小助手 → 生图模型接入」里获取一次模型列表，或手动填一个模型名");
  const prompt = (opts.prompt || "").trim();
  if (!prompt) throw new Error("要画什么？给我一句画面描述");

  let lastErr: unknown = null;
  const tried: string[] = [];
  for (const model of candidates) {
    try {
      const img = await requestImageOnce(base, opts.apiKey, model, prompt, opts.size, opts.signal);
      return { ...img, model };
    } catch (e) {
      tried.push(model);
      lastErr = e;
      if (!isModelUnavailable(e)) throw e;
    }
  }
  throw new Error(
    `${lastErr instanceof Error ? lastErr.message : String(lastErr)}（试过的模型：${tried.join("、")}；这些模型可能都没开通渠道，换一个供应商或分组试试）`,
  );
}

/** 真正发一次生图请求（单模型） */
async function requestImageOnce(
  base: string,
  apiKey: string,
  model: string,
  prompt: string,
  size?: string,
  signal?: AbortSignal,
): Promise<Omit<GeneratedImage, "model">> {
  const body: Record<string, unknown> = { model, prompt, n: 1, response_format: "b64_json" };
  if (size) body.size = size;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000); // 生图慢，给 2 分钟
  try {
    const res = await fetch(`${base}/images/generations`, {
      method: "POST",
      headers: chatHeaders(apiKey, "application/json"),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 404 || res.status === 405) {
        throw new Error(
          `这个生图端点不支持 /images/generations（HTTP ${res.status}）：${text.slice(0, 160)} —— 请在「控制面板 → 小助手 → 生图模型接入」里换一个供应商，或填一个支持生图的中转站`,
        );
      }
      throw new Error(`生图失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`生图返回的不是 JSON：${text.slice(0, 120)}`);
    }
    const data = (json as { data?: unknown }).data;
    const first = Array.isArray(data) ? (data[0] as Record<string, unknown>) : undefined;
    if (!first) throw new Error(`生图返回里没有图片数据：${text.slice(0, 160)}`);
    const b64 = typeof first.b64_json === "string" ? first.b64_json : "";
    if (b64) {
      return { base64: b64, revisedPrompt: typeof first.revised_prompt === "string" ? first.revised_prompt : undefined };
    }
    const url = typeof first.url === "string" ? first.url : "";
    if (url) {
      return { url, revisedPrompt: typeof first.revised_prompt === "string" ? first.revised_prompt : undefined };
    }
    throw new Error(`生图返回里既没有 b64_json 也没有 url：${text.slice(0, 160)}`);
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") throw new Error("生图超时（2 分钟），换个小一点的尺寸或稍后再试");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 从 AI 自由文本中提取 CMD: <命令> 行（兜底，不用 function calling 时） */
export function extractCommand(text: string): string | null {
  const m = /(?:^|\n)\s*CMD:\s*([^\n]+)/.exec(text);
  return m ? m[1].trim() : null;
}

export function stripCommand(text: string): string {
  return text.replace(/(?:^|\n)\s*CMD:\s*[^\n]+/g, "").trim();
}

export interface ChatUsage {
  input: number;
  output: number;
  cached: number;
  source: "server" | "estimated";
}

export interface ChatRequestOptions {
  signal?: AbortSignal;
  maxOutputTokens?: number;
  /** 两次流式数据之间允许的最长间隔（毫秒），默认 60s；超时会中断本次请求并抛错 */
  idleTimeoutMs?: number;
  onUsage?: (usage: ChatUsage) => void;
  /**
   * 本轮随消息附带的屏幕截图（data URL，形如 `data:image/png;base64,...`）。
   *
   * 只注入到**最后一条 user 消息**，且**不进对话历史** —— 否则 base64 会把
   * 历史文件撑爆，也会让 buildMessages 的字符预算（MAX_CHARS）失真。
   */
  screenImage?: string;
  /** 用户本轮附加的图片（dataURL）。只在本轮请求里编码，不写进历史 */
  userImages?: string[];
  /**
   * 额外的工具定义（插件工具）。内置 TOOLS 始终会一起发；
   * 这里只放插件注册的工具，避免和内置表重复。
   */
  extraTools?: unknown[];
  /** 本轮禁用的内置工具名（例如端点没有生图能力时禁掉 generate_image） */
  disabledTools?: string[];
  /**
   * 用户画像块（由 userProfile.profileBlock 生成）。
   *
   * 放在 requestOptions 里而不是多加一个位置参数：chatStream 的参数已经很长，
   * 且现有调用方都在尾部传 options 对象，加在这里不会破坏任何老调用。
   * 画像只进 system prompt，不进对话历史、不落盘。
   */
  profileText?: string;
  /**
   * 更早对话的滚动摘要（由 chatSummary.summaryBlock 生成）。
   * 同样只进 system prompt：补上 buildMessages 窗口截断后丢掉的上下文，长聊才不会失忆。
   */
  historySummary?: string;
}
