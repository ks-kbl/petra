/**
 * 语音「更流畅」的两个纯函数：
 * - findSpeechBounds：裁掉每段音频首尾的静音 padding（原来句间一顿一顿的主因）
 * - pauseAfterSegment：句末留短停顿、逗号处几乎不留缝
 *
 * 这里不碰真实音频，只用 Float32Array 造一段「静音-声音-静音」，
 * 断言裁剪边界合理、全静音时不会把整句裁没。
 */
const path = require("node:path");
const Module = require("node:module");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

global.window = {};
const playerPath = require.resolve("./build/tts/TTSPlayer.js");
const originalLoad = Module._load;
let mod;
try {
  Module._load = function (request, parent, ...rest) {
    if (request === "@tauri-apps/api/core") return { invoke: async () => "" };
    return originalLoad.call(this, request, parent, ...rest);
  };
  mod = require(playerPath);
} finally {
  Module._load = originalLoad;
}

const sr = 24000;
const mk = () => new Float32Array(sr);

// ---------- 静音-声音-静音 ----------
{
  const ch = mk();
  for (let i = Math.round(0.3 * sr); i < Math.round(0.7 * sr); i++) ch[i] = 0.5;
  const b = mod.findSpeechBounds([ch], sr);
  check("裁掉开头静音", b.offset > 0.25 && b.offset < 0.31, String(b.offset));
  check("裁掉结尾静音", b.offset + b.duration < 0.78, String(b.offset + b.duration));
  check("保留 90% 以上有效语音", b.duration > 0.38, String(b.duration));
}

// ---------- 全静音：不能裁没 ----------
{
  const b = mod.findSpeechBounds([mk()], sr);
  check("全静音时回退到完整区间", b.offset === 0 && Math.abs(b.duration - 1) < 0.001, JSON.stringify(b));
}

// ---------- 多声道：任一声道有声音就算 ----------
{
  const a = mk();
  const bch = mk();
  for (let i = Math.round(0.4 * sr); i < Math.round(0.5 * sr); i++) bch[i] = 0.2;
  const b = mod.findSpeechBounds([a, bch], sr);
  check("多声道任一声道有声即保留", b.duration > 0.05, String(b.duration));
}

// ---------- 停顿（2026-11 调大：70ms 听起来等于没停顿） ----------
check("句末留自然停顿", mod.pauseAfterSegment("今天天气不错。") === 0.3);
check("问号也算句末", mod.pauseAfterSegment("吃了吗？") === 0.3);
check("★ 省略号停得比句号久", mod.pauseAfterSegment("我在想……") === 0.5);
check("英文省略号同样处理", mod.pauseAfterSegment("wait...") === 0.5);
check("逗号处只留短缝", mod.pauseAfterSegment("今天天气不错，") === 0.08);
check("没标点的兜底段", mod.pauseAfterSegment("第一行内容足够长了吧") === 0.16);
check("空串不炸", typeof mod.pauseAfterSegment("") === "number");

// ---------- 按「切分原因」给停顿：换行/省略号靠这个才停得下来 ----------
check("★ 换行切开留段落停顿", mod.pauseForBoundary("newline") === 0.35);
check("★ 省略号留最长停顿", mod.pauseForBoundary("ellipsis") === 0.5);
check("句末停顿", mod.pauseForBoundary("sentence") === 0.3);
check("逗号兜底切", mod.pauseForBoundary("soft") === 0.08);
check("硬切兜底", mod.pauseForBoundary("hard") === 0.16);
check("换行停顿 > 句末 > 逗号", mod.pauseForBoundary("newline") > mod.pauseForBoundary("sentence") && mod.pauseForBoundary("sentence") > mod.pauseForBoundary("soft"));

console.log(`tts-fluency: fail=${fail}`);
process.exit(fail ? 1 : 0);
