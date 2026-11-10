/**
 * 生图模型接入的厂商表。
 *
 * **只收能直接打的 OpenAI 兼容端点**。2026-11-09 实测（无 Key 直接 POST 看返回码）：
 *   硅基流动 /v1/images/generations → 401（存在，需鉴权）
 *   智谱     /api/paas/v4/images/generations → 401
 *   火山方舟 /api/v3/images/generations → 401
 *   OpenAI   /v1/images/generations → 本机网络不通（000），按官方文档保留
 *   xAI      /v1/images/generations → 本机网络不通（000），按官方文档保留
 *   阿里百炼 /compatible-mode/v1/images/generations → **404**，已从内置表移除：
 *     通义万相走的是原生异步任务接口（/api/v1/services/aigc/text2image/image-synthesis），
 *     协议与 OpenAI 不兼容，硬塞进来就是"填完 Key 也报错"。要接就选「自定义 / 中转站」。
 *
 * 背景（用户原话）：「现在很少有既能对话还能生图的模型，那么桌宠想生图只能在加一个生图模型接口，
 * 像接入对话模型API一样……原来嵌在API接入里面的生图模型识别就取消吧，相当于两种模型分开填写」。
 *
 * 所以这里和 AssistantClient 里的 `PROVIDERS`（对话）是**两套独立的表**：
 * 各自有 base、各自的 Key 槽位（`image:<provider>`）、各自的模型清单。
 * 只有 OpenAI 兼容、真的走 `POST {base}/images/generations` 的厂商才列进来——
 * 用户要求「内置的厂商要确保填完 Key 后可以接入并使用」，宁可少列，也不放"填了也跑不通"的项。
 */
import type { ImageProviderId } from "../utils/settings";
import { normalizeOpenAIBase } from "./apiKey";

export interface ImageProviderInfo {
  label: string;
  base: string;
  /** Key 输入框的占位提示（各家的 Key 长相不一样） */
  placeholder: string;
  /** 拉不到 /models 时用的兜底模型清单（保证填完 Key 至少有一个能试） */
  defaultModels: string[];
  /** 需要额外提醒的坑（比如火山方舟要填推理接入点 ID） */
  note?: string;
}

export const IMAGE_PROVIDERS: Record<ImageProviderId, ImageProviderInfo> = {
  siliconflow: {
    label: "SiliconFlow（硅基流动）",
    base: "https://api.siliconflow.cn/v1",
    placeholder: "sk-...",
    defaultModels: ["Kwai-Kolors/Kolors", "Qwen/Qwen-Image"],
  },
  zhipu: {
    label: "智谱 GLM（CogView）",
    base: "https://open.bigmodel.cn/api/paas/v4",
    placeholder: "API Key（形如 xxxxxxxx.yyyyyyyy）",
    defaultModels: ["cogview-4", "cogview-3-flash"],
  },
  ark: {
    label: "火山方舟（Seedream）",
    base: "https://ark.cn-beijing.volces.com/api/v3",
    placeholder: "方舟 API Key",
    defaultModels: ["doubao-seedream-3-0-t2i-250415"],
    note: "模型名要填方舟控制台里的「推理接入点 ID」（ep- 开头）或模型名，没开通会报 No available channel",
  },
  openai: {
    label: "OpenAI",
    base: "https://api.openai.com/v1",
    placeholder: "sk-...",
    defaultModels: ["gpt-image-1", "dall-e-3"],
  },
  xai: {
    label: "xAI（Grok Image）",
    base: "https://api.x.ai/v1",
    placeholder: "xai-...",
    defaultModels: ["grok-2-image-1212"],
  },
  custom: {
    label: "自定义 / 中转站",
    base: "",
    placeholder: "API Key",
    defaultModels: [],
    note: "填一个 OpenAI 兼容、且提供 /images/generations 的端点（如自己搭的 New-API 分组）",
  },
};

/** 面板下拉框用：保持这个顺序 */
export const IMAGE_PROVIDER_IDS = Object.keys(IMAGE_PROVIDERS) as ImageProviderId[];

/**
 * 旧的 Key 槽位名（按供应商存）。
 * 现在生图也支持预设：有预设就用 `imagePreset:<id>`，这个只作为"手填配置"和老数据回读用。
 */
export function imageKeyScope(provider: ImageProviderId): string {
  return `image:${provider || "custom"}`;
}

/** 生图预设的 Key 槽位：每个预设一把 Key，切预设时 Key 跟着切（同对话的 preset:<id>） */
export function imagePresetKeyScope(id: string): string {
  return `imagePreset:${id}`;
}

/** 当前该用哪个 Key 槽位：应用了预设就用预设的，否则用按供应商的那个 */
export function currentImageKeyScope(image: {
  provider?: ImageProviderId | "";
  activePresetId?: string;
} | undefined): string {
  if (!image || !image.provider) return imageKeyScope("custom");
  if (image.activePresetId) return imagePresetKeyScope(image.activePresetId);
  return imageKeyScope(image.provider);
}

/** 把配置解析成实际请求用的 base（自定义端点会补 /v1、去掉多余路径） */
export function resolveImageBase(provider: ImageProviderId, customBaseUrl = ""): string {
  if (provider === "custom") {
    const b = normalizeOpenAIBase(customBaseUrl);
    if (!b) throw new Error("生图接入选了「自定义」，但没填接口地址");
    return b;
  }
  const info = IMAGE_PROVIDERS[provider];
  if (!info) throw new Error(`未知的生图供应商：${provider}`);
  return info.base;
}

/** 这个供应商的兜底模型清单（拉不到 /models 时用） */
export function defaultImageModels(provider: ImageProviderId): string[] {
  return [...(IMAGE_PROVIDERS[provider]?.defaultModels ?? [])];
}

/** 这套生图配置是不是"看起来配好了"（不看 Key，Key 要异步查） */
export function isImageConfigured(
  image: { provider?: ImageProviderId; model?: string; customBaseUrl?: string } | undefined,
): boolean {
  if (!image || !image.provider) return false;
  if (image.provider === "custom" && !(image.customBaseUrl || "").trim()) return false;
  return true;
}
