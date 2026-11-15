/**
 * 把原始 API 错误翻译成用户能看懂的提示（纯函数，可单测）。
 *
 * 2026-11 修：以前这里是**按关键词在整条错误串上乱匹配**，而我们自己在消息里加的解释
 * 提示里也带着这些词 —— 于是 `API 错误 0 (自定义/中转站端点：请确认 URL 是否带 /v1、
 * 模型名是否与中转站文档一致)` 因为括号里出现了「模型名」三个字，被 `/模型/` 命中，
 * 弹成「🤖 模型名或接口地址不存在」。用户拿着这句去检查模型名和地址，当然什么都查不出来
 * ——真正的错误是那次请求**一个响应都没收到**（网络层失败 / 本地服务没起来 / 跨域被拦）。
 *
 * 现在的规矩：
 * 1. **先看状态码**，状态码能定性就不再看文本；
 * 2. 只有需要看正文时，才去匹配 **冒号之后的响应正文**，绝不匹配我们自己加的提示话术；
 * 3. 状态码 0（没有收到任何响应）单独成一类，并区分本地端点（多半是服务没启动或跨域）。
 */

import { localizeUiText } from "../utils/uiText";

/** 从各种形态的错误串里抠出 HTTP 状态码；拿不到返回 -1（注意「API 错误 0」是有效值） */
export function pickErrorStatus(raw: string): number {
  const m =
    /API\s*错误\s*(\d{1,3})/i.exec(raw) ||
    /HTTP\s*(\d{3})/i.exec(raw) ||
    /状态码\s*(\d{3})/.exec(raw);
  return m ? Number(m[1]) : -1;
}

/** 我们自己拼的错误串形如「API 错误 400 (提示): 正文」——只取正文，别让提示话术干扰判断 */
export function errorBody(raw: string): string {
  const i = raw.indexOf("): ");
  if (i >= 0) return raw.slice(i + 3);
  const j = raw.indexOf(": ");
  return j >= 0 ? raw.slice(j + 2) : raw;
}

const NETWORK_RE =
  /failed to fetch|networkerror|load failed|fetch failed|network request failed|network error|econnrefused|econnreset|enotfound|eai_again|etimedout|timed out|timeout|超时|连接被拒绝|无法解析|跨域|cors|没有收到任何响应/i;

export function friendlyApiError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const status = pickErrorStatus(raw);
  const body = errorBody(raw);
  const noResponse = status === 0 || /没有收到任何响应/.test(raw);

  // ① 一个响应都没收到 —— 不是 Key/模型的问题，别让用户去改设置
  if (noResponse) {
    const local = /127\.0\.0\.1|localhost|\[::1\]/i.test(raw);
    return local
      ? "🌐 没连上本地服务：端点地址里的服务没在跑，或者被浏览器跨域拦了。\n先确认那个端口上的程序开着（比如 Ollama 要设 OLLAMA_ORIGINS=* 再重启），再试一次。"
      : "🌐 没连上服务端：请求一个响应都没收到（网络断了、代理/防火墙挡了，或端点地址不对）。\n检查一下网络和「API 端点」，再试一次。";
  }
  // ② 有状态码的先按状态码定性
  if (status === 402 || /insufficient balance|余额不足|欠费|quota exceeded|exceeded your current quota/i.test(body)) {
    return "💸 API 余额不足或额度已用完：请到「小助手设置」充值，或换一个可用的 API Key。\n（AI 暂时下线，但右键 →「🎮 小游戏」，桌宠还能陪你打麻将哦～）";
  }
  if (status === 401 || status === 403 || /invalid_api_key|incorrect api key|unauthorized|forbidden|令牌|鉴权/i.test(body)) {
    return "🔑 API Key 无效、已过期或没有权限，请到「小助手设置」重新填写。";
  }
  if (status === 429 || /rate limit|too many requests|限流/i.test(body)) {
    return "⏳ 请求太频繁了，缓一缓再聊吧～";
  }
  if (status === 404 || /model not found|model_not_found|does not exist|no such model/i.test(body)) {
    return "🤖 模型名或接口地址不存在：请在设置里检查「API 端点 / 模型名」，或点「自动获取模型」重新选择。";
  }
  if (status === 400 || status === 422) {
    return "⚠️ 请求参数不被服务端接受（400/422）：请检查模型名、端点地址，以及当前模型是否支持该功能。";
  }
  if (status >= 500 && status <= 599) {
    return "🛠️ 服务端暂时不可用，请稍后重试。";
  }
  // ③ 没有状态码可依时，才回头看正文里的网络类关键词
  if (NETWORK_RE.test(body)) {
    return "🌐 网络不可用或请求超时，请检查网络/代理后再试。";
  }
  // 未知错误：给用户一句中文兜底，原始英文只写日志（调用方已调用 debug_mark）
  return localizeUiText(raw) || "AI 请求失败，请稍后重试。";
}
