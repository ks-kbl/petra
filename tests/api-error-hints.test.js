/**
 * API 错误 → 中文提示的映射（纯函数）。
 *
 * 回归重点：**我们自己加的提示话术不能反过来影响判断**。
 * 真实事故：`API 错误 0 (自定义/中转站端点：请确认 URL 是否带 /v1、模型名是否与中转站文档一致)`
 * 因为括号里出现「模型名」，被 `/模型/` 命中，弹成「模型名或接口地址不存在」——
 * 用户照着改了半小时设置，真正的原因是那次请求一个响应都没收到。
 */
const eh = require("./build/assistant/errorHints.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

const f = (msg) => eh.friendlyApiError(new Error(msg));

// ---------- 状态码解析 ----------
check("解析 API 错误码", eh.pickErrorStatus("API 错误 404: x") === 404);
check("★ 「API 错误 0」是有效值，不能被当成没解析到", eh.pickErrorStatus("API 错误 0（没有收到任何响应）: 空响应") === 0);
check("解析 HTTP 状态码", eh.pickErrorStatus("HTTP 401: nope") === 401);
check("没有状态码返回 -1", eh.pickErrorStatus("纯文字错误") === -1);
check("只取冒号后的正文", eh.errorBody("API 错误 400 (提示): 正文内容").startsWith("正文"));

// ---------- 事故回归 ----------
{
  const msg = "API 错误 0（没有收到任何响应：端点 http://127.0.0.1:8765/v1 不可达）: 空响应";
  const out = f(msg);
  check("★ 状态码 0 不再被说成「模型名不存在」", !out.includes("模型名或接口地址不存在"), out);
  check("★ 本地端点给出「本地服务没起来/跨域」的解释", out.includes("本地服务") && out.includes("跨域"), out);
  const remote = f("API 错误 0（没有收到任何响应：端点 https://api.example.com/v1 不可达）: 空响应");
  check("远程端点给网络类提示", remote.includes("没连上服务端"), remote);
}
{
  // 带「中转站」提示话术的真实错误：正文是空的，必须按状态码判断
  const out = f("API 错误 0 (自定义/中转站端点：请确认 URL 是否带 /v1、模型名是否与中转站文档一致): ");
  check("★ 提示话术里的「模型名」不再污染判断", !out.includes("模型名或接口地址不存在"), out);
}

// ---------- 正常分类 ----------
check("402 余额不足", f("API 错误 402: insufficient balance").includes("余额不足"));
check("401 Key 无效", f("API 错误 401: invalid_api_key").includes("API Key 无效"));
check("403 也算 Key/权限", f("HTTP 403: forbidden").includes("API Key"));
check("429 限流", f("API 错误 429: rate limit").includes("太频繁"));
check("★ 404 才是模型/地址不存在", f("API 错误 404: model_not_found").includes("模型名或接口地址不存在"));
check("★ 400 不再被误判成模型不存在", (() => {
  const out = f("API 错误 400 (提示): bad request");
  return out.includes("400/422") && !out.includes("模型名或接口地址不存在");
})(), f("API 错误 400 (提示): bad request"));
check("5xx 服务端不可用", f("API 错误 503: service unavailable").includes("服务端暂时不可用"));
check("正文里的 timeout 归到网络", f("API 错误 -1: request timeout").includes("网络") || f("API 错误 -1: request timeout").includes("超时"));
check("完全未知的错误有中文兜底", f("something weird happened").length > 0);

// ---------- 图像模型提示不再误伤 ----------
{
  const out = f("API 错误 400 (提示): upstream failed（这个模型看起来是图像/语音类模型，不是对话模型）");
  check("★ 图像模型提示后缀不会触发「模型不存在」", out.includes("400/422"), out);
}

console.log("api-error-hints: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
