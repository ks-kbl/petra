/**
 * 语气控制（火山声音复刻 2.0）的纯函数：
 * - emotionToneInstruction：情绪 → 中文语气口令
 * - wrapCotTag：情绪 → <cot text=…> 语音标签，超长返回 null（调用方退回口令）
 */
const Module = require("node:module");
global.window = {};
const sent = [];
const playerPath = require.resolve("./build/tts/TTSPlayer.js");
const originalLoad = Module._load;
let mod;
try {
  Module._load = function (request, parent, ...rest) {
    if (request === "@tauri-apps/api/core") {
      return { invoke: async (cmd, args) => { if (cmd === "tts_synthesize") sent.push(args); return ""; } };
    }
    return originalLoad.call(this, request, parent, ...rest);
  };
  mod = require(playerPath);
} finally {
  Module._load = originalLoad;
}
const { wrapCotTag, emotionToneInstruction, composeContextTexts } = mod;
(async () => {

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

// 跨句上下文（A 层整段合成）：前文 + 语气口令一起塞进 context_texts
{
  const ctx = composeContextTexts("上一句我说的是这个意思。", "用日常聊天的语气说");
  ok("★ 上下文第一条是前一段原文", ctx[0] === "上一句我说的是这个意思。", JSON.stringify(ctx));
  ok("★ 上下文后面跟语气口令", ctx[1] === "用日常聊天的语气说", JSON.stringify(ctx));
  ok("没有前文时只有口令", composeContextTexts("", "用轻快的语气说").length === 1);
  ok("没前文也没口令时为空", composeContextTexts("", "").length === 0);
  const longPrev = "啊".repeat(200);
  const cut = composeContextTexts(longPrev, "口令");
  ok("★ 超长前文取尾部（保住最新内容）", cut[0].length === 80 && cut[0] === longPrev.slice(-80), String(cut[0].length));
  ok("换行压成空格，别把换行喂给合成", composeContextTexts("第一行\n第二行", "").length === 1);
  ok("最多 4 条", composeContextTexts("a", "b").length <= 4);
}

// 边界：刚好卡在上限内要能包，超一个字就拒绝
const base = "<cot text=开心></cot>".length;
ok("恰好等于上限可以包", wrapCotTag("啊".repeat(60 - base), "happy", 60) !== null);
ok("超过上限一个字拒绝", wrapCotTag("啊".repeat(61 - base), "happy", 60) === null);

// ★ 情绪语音参数不能在"增强语气"关着时被整段吞掉
// （以前 buildTone 一进来就 if (!enhanced) return，导致没开增强语气的人永远听不出情绪）
{
  const { ttsPlayer } = mod;
  sent.length = 0;
  ttsPlayer.setConfig(true, "k", "s");
  ttsPlayer.setMoodTone({ rate: 6, tilt: 0.5, volume: 0.9 });
  ttsPlayer.pushDelta("嗯……行吧，随便你。");
  ttsPlayer.flush();
  await new Promise((r) => setTimeout(r, 10));
  const tone = sent[0]?.tone;
  ok("★ 增强语气关着时，情绪语速仍然发出去", !!tone && tone.speechRate === 6, JSON.stringify(tone));
  ok("★ 不再向服务端发变调（电音根源）", !tone || tone.pitch === undefined, JSON.stringify(tone));
  ok("★ 但不会偷偷开表现力模型", !tone || !tone.model, JSON.stringify(tone));
}

console.log(`tts-tone: pass=${n} fail=${process.exitCode ? 1 : 0}`);
})();
