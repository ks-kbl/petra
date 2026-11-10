/**
 * 唤醒暂停闸门：多个持有者（TTS / 录音识别 / 唤醒回应）共享同一个暂停状态，
 * 任何一个先释放都不能把别人的暂停顶掉。
 */
const Module = require("node:module");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

const calls = [];
global.window = { setTimeout: (fn, ms) => setTimeout(fn, ms) };
const originalLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === "@tauri-apps/api/core") {
    return { invoke: async (cmd, args) => { calls.push({ cmd, paused: args && args.paused }); } };
  }
  return originalLoad.call(this, request, parent, ...rest);
};
let gate;
try {
  gate = require("./build/audio/wakeGate.js");
} finally {
  Module._load = originalLoad;
}
const { holdWake, releaseWake, wakeHeld } = gate;

const lastPaused = () => calls.length ? calls[calls.length - 1].paused : null;

(async () => {
  holdWake("tts");
  check("第一次 hold 会暂停唤醒", lastPaused() === true, JSON.stringify(calls));

  holdWake("asr");
  const pausedCalls = calls.length;
  holdWake("asr"); // 重复持有同一个 reason 不该重复下发
  check("重复 hold 不重复下发", calls.length === pausedCalls, String(calls.length));
  check("两个持有者时仍处于暂停", wakeHeld() === true);

  releaseWake("tts", 0);
  check("释放其中一个后仍暂停（另一个还占着）", lastPaused() === true, JSON.stringify(calls));

  releaseWake("asr", 0);
  check("全部释放后才恢复监听", lastPaused() === false, JSON.stringify(calls));
  check("恢复后不再处于持有状态", wakeHeld() === false);

  // 延迟释放：这段时间内仍算暂停
  holdWake("wake-reply");
  releaseWake("wake-reply", 50);
  check("延迟释放期间仍暂停", wakeHeld() === true);
  await new Promise((r) => setTimeout(r, 80));
  check("延迟到点后恢复", wakeHeld() === false && lastPaused() === false);

  console.log(`wake-gate: fail=${fail}`);
  if (fail) process.exitCode = 1;
})();
