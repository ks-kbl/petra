export interface ImageRef { name: string; dataUrl: string; root?: ImageRef[]; selected?: boolean; mask?: Blob }
export function imageCapabilityKey(provider: string, base: string, model: string, preset = ""): string {
  return JSON.stringify([provider, base, model, preset]);
}
export function imageCapability(key: string, mode: "generate" | "edit"): string {
  try { return localStorage.getItem(`petra.image-capability:${mode}:${key}`) ?? ""; } catch { return ""; }
}
export function recordImageCapability(key: string, mode: "generate" | "edit", status: "ok" | "unsupported"): void {
  try { localStorage.setItem(`petra.image-capability:${mode}:${key}`, status); } catch { /* optional */ }
}
export const allowsMultiImageEdit = (text: string) => /(?:都|一起|多张|两张|三张|融合|合成|拼成|组合|参考图|用这些|每张|全部)/.test(text);
export const asksOriginal = (text: string) => /(?:用|回到|从|按)(?:最初的|最开始的|最早的|之前的)?原图|原图重来/i.test(text);
export const isExplicitImageOperation = (text: string) => /^(?:请|帮我|给我|麻烦)?\s*(?:图生图|图改图|改图|(?:把|将)(?:刚才的|刚画的|上一张|这张)?(?:图片|图|原图).{0,24}(?:改|换|修))/.test(text.trim()) || asksOriginal(text);
export function asksImageEdit(text: string, hasSource: boolean, recentOnly = false): boolean {
  if (!hasSource || /(?:怎么|如何)(?:用|做|实现)?(?:图生图|改图)|什么是图生图/.test(text)) return false;
  if (recentOnly && !asksOriginal(text) && !/(?:原图|这张图|刚才.{0,6}图|图片|改图|图生图|^再(?:暗|亮|淡|深|暖|冷|清晰|鲜艳|自然)一点)/.test(text.trim())) return false;
  return asksOriginal(text) || /^(?:(?:请|帮我|给我|麻烦)\s*)*(?:再(?:暗|亮|淡|深|暖|冷|清晰|鲜艳|自然)一点|(?:把|给|将).{0,35}(?:换成|改成|去掉|加上|删掉|移除|调成|变成)|(?:换|改|去掉|去除|移除|删掉|加上|裁剪|修复|修一下|扩图|图生图|图改图|改图)|(?:照着|参考|基于)(?:这张|原图|刚才|上面|附件)|(?:make it|remove the|change the|edit this|replace the))/i.test(text.trim());
}
export function selectImageSources(text: string, attached: ImageRef[], current: ImageRef[]): ImageRef[] {
  if (attached.length) return asksOriginal(text) ? attached.flatMap(img => img.root ?? [img]) : attached;
  return asksOriginal(text) ? current.flatMap(img => img.root ?? [img]) : current;
}

export async function requestImageEdit(opts: {
  base: string; apiKey: string; model: string; prompt: string; images: ImageRef[]; mask?: Blob; signal?: AbortSignal;
}): Promise<{ base64?: string; url?: string; model: string }> {
  const { model, prompt, images, mask, signal } = opts;
  if (signal?.aborted) throw new Error("已取消改图，原图未改动");
  if (!model.trim()) throw new Error("请先在生图模型接入选择支持改图的模型");
  if (!prompt.trim() || !images.length) throw new Error("请先选原图，再说明要改什么");
  if (mask && images.length !== 1) throw new Error("局部编辑请只选一张图");
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  for (let i = 0; i < images.length; i++) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=\s]+)$/i.exec(images[i].dataUrl);
    if (!match) throw new Error("改图只支持有效的 PNG、JPEG 或 WebP 图片");
    const bytes = Uint8Array.from(atob(match[2]), ch => ch.charCodeAt(0));
    form.append(images.length === 1 ? "image" : "image[]", new Blob([bytes], { type: match[1] }), `source-${i + 1}.${match[1].split("/")[1]}`);
  }
  if (mask) form.append("mask", mask, "mask.png");
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, 120_000);
  try {
    const res = await fetch(`${opts.base.replace(/\/+$/, "")}/images/edits`, {
      method: "POST", redirect: "error", headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}, body: form, signal: ctrl.signal,
    });
    if (res.status === 404 || res.status === 405 || res.status === 501) throw new Error(`此接入未提供可用的图像编辑接口（HTTP ${res.status}），请选支持 /images/edits 的端点或模型`);
    if (res.status === 401 || res.status === 403) throw new Error(`改图授权失败（HTTP ${res.status}），请检查生图 Key 和模型权限`);
    if (!res.ok) throw new Error(`改图请求失败（HTTP ${res.status}），请检查模型是否支持此编辑方式及图片格式`);
    const first = (await res.json())?.data?.[0];
    if (typeof first?.b64_json === "string" && first.b64_json) return { base64: first.b64_json, model };
    if (typeof first?.url === "string" && /^https?:\/\//i.test(first.url)) return { url: first.url, model };
    throw new Error("改图服务没有返回图片");
  } catch (e) {
    if (signal?.aborted) throw new Error("已取消改图，原图未改动");
    if (ctrl.signal.aborted) throw new Error("改图超时，原图未改动");
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
