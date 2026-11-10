/**
 * 语气控制（火山声音复刻 2.0）的纯函数：
 * - emotionToneInstruction：情绪 → 中文语气口令
 * - wrapCotTag：情绪 → <cot text=…> 语音标签，超长返回 null（调用方退回口令）
 */
const Module = require("node:module");
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
const { wrapCotTag, emotionToneInstruction } = mod;

let n = 0;
const ok = (name, cond, extra = "") => { n++; if (!cond) { console.error("FAIL", name, extra); process.exitCode = 1; } else console.log("PASS", name); };

// 情绪 → 口令：六种已知情绪各有自己的句子，未知情绪回落到 neutral
ok("开心有专属口令", /轻快|开心/.test(emotionToneInstruction("happy")), emotionToneInstruction("happy"));
ok("难过有专属口令", /低落/.test(emotionToneInstruction("sad")), emotionToneInstruction("sad"));
ok("未知情绪回落中性", emotionToneInstruction("whatever") === emotionToneInstruction("neutral"));

// CoT 标签：短句能包，长句返回 null（调用方会退回自然语言口令）
const short = wrapCotTag("今天也要开心哦", "happy");
ok("短句能包成 cot 标签", short === "<cot text=开心>今天也要开心哦</cot>", String(short));
ok("长句拒绝包装", wrapCotTag("啊".repeat(80), "happy") === null);

// 边界：刚好卡在上限内要能包，超一个字就拒绝
const base = "<cot text=开心></cot>".length;
ok("恰好等于上限可以包", wrapCotTag("啊".repeat(60 - base), "happy", 60) !== null);
ok("超过上限一个字拒绝", wrapCotTag("啊".repeat(61 - base), "happy", 60) === null);

console.log(`tts-tone: pass=${n} fail=${process.exitCode ? 1 : 0}`);
