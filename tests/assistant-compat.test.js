/**
 * 自定义端点 / 中转站兼容性测试。
 *
 * 覆盖用户报障的两个根因：
 * 1. 中转站不实现 /models：只填端点 + Key、没填模型时，要能从 /models 自动挑一个
 *    对话模型（不能选 embedding/tts），而不是直接报"未设置模型名"。
 * 2. 部分模型 / 中转站不支持 tools 或 stream：先带 tools 请求失败后，要自动降级为
 *    纯文本请求，后续同一端点也不再重复失败。
 *
 * 运行：node tests/assistant-compat.test.js（由 npm run test:assistant 串起来）
 */
const ac = require("./load-assistant-client.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

const sse = (text) => {
  const body =
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
    "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

(async () => {
  const originalFetch = global.fetch;
  try {
    // ---- 0) /models 报 401：提示必须指向"Key 无效"，不能甩锅给"站点不支持 /models" ----
    {
      global.fetch = async () => json({ error: { message: "无效的令牌" } }, 401);
      let err = "";
      try {
        await ac.listModels("custom", "sk-bad-key", "https://example.com/v1");
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
      }
      check("401 时提示 Key 问题", /Key 的问题|重新生成/.test(err), err.slice(0, 80));
      check("401 时不再提「不提供 /models」", !/不提供 \/models/.test(err), err.slice(0, 80));
    }
    // ---- 0b) /models 报 404：这时才该建议手填模型名 ----
    {
      global.fetch = async () => json({ error: { message: "Invalid URL" } }, 404);
      let err = "";
      try {
        await ac.listModels("custom", "sk-key", "https://example.com/v1");
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
      }
      check("404 时建议手填模型名", /手填|手动填写/.test(err), err.slice(0, 80));
    }

    // ---- 0c) /models 里图像/语音模型混进来：要过滤掉，别让用户选到必 400 的模型 ----
    {
      global.fetch = async () =>
        json({ data: [{ id: "gpt-image-2" }, { id: "deepseek-v4.1-flash" }, { id: "gpt-image-2.5" }] });
      const list = await ac.listModels("custom", "sk-key", "https://example.com/v1");
      check("过滤掉图像模型", list.length === 1 && list[0] === "deepseek-v4.1-flash", JSON.stringify(list));
    }
    check("能识别非对话模型名", ac.looksLikeNonChatModel("gpt-image-2") === true);
    check("普通聊天模型不误判", ac.looksLikeNonChatModel("deepseek-v4.1-flash") === false);

    // ---- 0d) 生图模型自动识别：用户不用手填模型名 ----
    {
      const names = ["gpt-4o", "gpt-image-2", "deepseek-v4.1-flash", "kolors", "flux-schnell", "gpt-image-2.5"];
      const imgs = ac.detectImageModels(names);
      check("自动识别生图模型", imgs.length === 4 && imgs[0] === "gpt-image-2", JSON.stringify(imgs));
      check("聊天模型不算生图模型", !imgs.includes("gpt-4o") && !imgs.includes("deepseek-v4.1-flash"));
      check("生图判断不误伤", ac.looksLikeImageModel("kimi-k3") === false);
    }
    // ---- 0e) /images/generations 回 url 时要能下载并转 base64 ----
    {
      global.fetch = async (url) => {
        if (String(url).includes("/images/generations")) {
          return json({ data: [{ url: "https://example.com/a.png" }] });
        }
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      };
      const img = await ac.generateImage({
        provider: "custom", apiKey: "k", customBaseUrl: "https://example.com/v1",
        model: "gpt-image-2", prompt: "一只鲸鱼",
      });
      check("url 形式的生图结果被转成 base64", img.base64 === "AQID", img.base64);
    }
    // ---- 0f) 没配生图模型时给中文提示 ----
    {
      let err = "";
      try {
        await ac.generateImage({ provider: "custom", apiKey: "k", customBaseUrl: "https://example.com/v1", model: "", prompt: "x" });
      } catch (e) { err = e instanceof Error ? e.message : String(e); }
      check("无生图模型时提示中文", /生图模型/.test(err), err);
    }

    // ---- 1) tools 被拒 → 自动降级为无工具请求，并记住该端点 ----
    {
      const requests = [];
      global.fetch = async (url, init = {}) => {
        const body = init.body ? JSON.parse(String(init.body)) : null;
        requests.push({ url: String(url), body, headers: init.headers || {} });
        if (requests.length === 1) {
          return json({ error: { message: "tools are not supported by this model" } }, 400);
        }
        return sse("降级成功");
      };
      const deltas = [];
      const res = await ac.chatStream(
        "custom", "sk-test", "relay-model", [{ role: "user", content: "hi" }],
        "人设", [], "https://relay-a.example.com", (d) => deltas.push(d), true,
      );
      check("tools 400 后自动重试一次", requests.length === 2, String(requests.length));
      check("第一次请求带 tools", Array.isArray(requests[0]?.body?.tools));
      check("降级请求不再带 tools", requests[1] && !("tools" in requests[1].body));
      check("降级后正常收到正文", res.text === "降级成功" && deltas.join("") === "降级成功", res.text);

      // 同一端点 + 模型第二次调用应直接走兼容模式（只发一次、无 tools）
      const before = requests.length;
      const deltas2 = [];
      const res2 = await ac.chatStream(
        "custom", "sk-test", "relay-model", [{ role: "user", content: "again" }],
        "人设", [], "https://relay-a.example.com", (d) => deltas2.push(d), true,
      );
      check("同一端点不再重复撞 tools", requests.length === before + 1);
      check("后续请求直接无 tools", !("tools" in requests[before].body));
      check("后续请求正常返回", res2.text === "降级成功" && deltas2.join("") === "降级成功");
    }

    // ---- 2) 端点无视 stream=true，直接返回整段 JSON ----
    {
      global.fetch = async () => json({
        choices: [{ message: { content: "非流式回复" } }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      });
      const deltas = [];
      const res = await ac.chatStream(
        "custom", "sk-test", "json-model", [{ role: "user", content: "hi" }],
        "人设", [], "https://relay-b.example.com", (d) => deltas.push(d), false,
      );
      check("application/json 响应也能解析正文", res.text === "非流式回复", res.text);
      check("非流式响应也回调 onDelta", deltas.join("") === "非流式回复");
      check("服务端 usage 被采用", res.usage.source === "server" && res.usage.input === 10);
    }

    // ---- 3) 没填模型时自动从 /models 里挑对话模型（避开 embedding）----
    {
      const requests = [];
      global.fetch = async (url, init = {}) => {
        const method = (init.method || "GET").toUpperCase();
        requests.push({ url: String(url), method, body: init.body ? JSON.parse(String(init.body)) : null, headers: init.headers || {} });
        if (method === "GET") {
          return json({ data: [{ id: "text-embedding-3-small" }, { id: "gpt-4o-mini" }, { id: "tts-1" }] });
        }
        return sse("自动选模型成功");
      };
      const res = await ac.chatStream(
        "custom", "", "", [{ role: "user", content: "hi" }],
        "人设", [], "https://relay-c.example.com", () => {}, false,
      );
      check("空模型名会先请求 /models", requests.some((r) => r.method === "GET" && r.url.endsWith("/models")));
      const chatReq = requests.find((r) => r.method === "POST");
      check("自动选中对话模型（不是 embedding）", chatReq?.body?.model === "gpt-4o-mini", chatReq?.body?.model);
      check("空 Key 时不发空的 Bearer 头", chatReq && !chatReq.headers.Authorization);
      check("自动选模型后正常返回", res.text === "自动选模型成功");
    }

    // ---- 4) 响应里带 error 的 SSE 要抛出可读错误，而不是静默空回复 ----
    {
      global.fetch = async () => new Response(
        `data: ${JSON.stringify({ error: { message: "quota exceeded" } })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
      let err = "";
      try {
        await ac.chatStream(
          "custom", "k", "err-model", [{ role: "user", content: "hi" }],
          "人设", [], "https://relay-d.example.com", () => {}, false,
        );
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
      }
      check("SSE 内嵌 error 会抛错", err.includes("quota exceeded"), err);
    }
  } finally {
    global.fetch = originalFetch;
  }

  console.log("assistant-compat: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("assistant-compat: crashed", e);
  process.exit(1);
});
