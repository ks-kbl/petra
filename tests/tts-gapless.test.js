/**
 * TTS 的「无缝连播」路径（Web Audio）。
 *
 * 用假的 AudioContext 验证三件事：
 * 1. 每段音频都被解码并按静音边界裁剪（不是整段原样播）；
 * 2. 后一句在**前一句还没播完时**就排进时间轴（这是消除句间空档的关键）；
 * 3. 静音开关作用在总音量节点上，排队中的句子开播时也是静音。
 */
const Module = require("node:module");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

// ---------- Web Audio 替身 ----------
const sources = [];
class FakeGain {
  constructor() {
    this.gain = {
      value: 1,
      setValueAtTime() {},
      linearRampToValueAtTime() {},
    };
  }
  connect() { return this; }
  disconnect() {}
}
class FakeSource {
  constructor() {
    this.buffer = null;
    this.onended = null;
    this.startArgs = null;
    sources.push(this);
  }
  connect() {}
  start(when, offset, duration) { this.startArgs = { when, offset, duration }; }
  stop() {}
}
const SR = 24000;
function makeBuffer() {
  const n = Math.round(0.3 * SR);
  const ch = new Float32Array(n);
  // 0.05s ~ 0.25s 有声音，其余是静音 padding
  for (let i = Math.round(0.05 * SR); i < Math.round(0.25 * SR); i++) ch[i] = 0.6;
  return {
    duration: n / SR,
    sampleRate: SR,
    numberOfChannels: 1,
    length: n,
    getChannelData: () => ch,
  };
}
class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = "running";
    this.destination = {};
    this.gains = [];
  }
  createGain() { const g = new FakeGain(); this.gains.push(g); return g; }
  createBufferSource() { return new FakeSource(); }
  async decodeAudioData() { return makeBuffer(); }
  resume() { return Promise.resolve(); }
}

global.window = { AudioContext: FakeAudioContext };
global.Blob = class { constructor(parts) { this.parts = parts; } };
URL.createObjectURL = () => "blob:test";

const playerPath = require.resolve("./build/tts/TTSPlayer.js");
const originalLoad = Module._load;
let player;
try {
  Module._load = function (request, parent, ...rest) {
    if (request === "@tauri-apps/api/core") {
      return { invoke: async () => Buffer.from([1, 2, 3]).toString("base64") };
    }
    return originalLoad.call(this, request, parent, ...rest);
  };
  ({ ttsPlayer: player } = require(playerPath));
} finally {
  Module._load = originalLoad;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  player.setConfig(true, "key", "speaker");
  const idled = [];

  player.pushDelta("第一句要说得长一点，够断句了。");
  player.pushDelta("第二句也要说得长一点，才能单独成段。");
  // 真实调用方是在 flush 之后注册的：这时队列里已经有内容，必须等播完才回调
  player.onIdle(() => idled.push(1));
  await settle();
  await settle();
  await settle();

  check("两段都已解码并排进时间轴", sources.length === 2, String(sources.length));
  if (sources.length === 2) {
    const a = sources[0].startArgs;
    const b = sources[1].startArgs;
    check("按文字顺序调度", !!a && !!b);
    check("第一段裁掉了开头静音", a.offset > 0, String(a.offset));
    check("第一段裁掉了结尾静音", a.duration < 0.3, String(a.duration));
    check(
      "第二段在第一段结束前就已排好（无缝）",
      b.when >= a.when + a.duration && b.when < a.when + a.duration + 0.2,
      JSON.stringify({ a, b }),
    );
  }

  // 静音：作用在总音量节点上（私有字段在 JS 里可访问）
  player.setMuted(true);
  const master = player.masterGain;
  check("静音作用在总音量节点", !!master && master.gain.value === 0, String(master?.gain?.value));
  check("静音不打断排期", sources.length === 2);
  check("静音状态被记住", player.muted === true);

  // 两段播完 → 只触发一次 idle（气泡淡出依赖它）
  if (sources.length === 2) {
    sources[0].onended();
    check("第一段结束时不提前 idle", idled.length === 0, String(idled.length));
    sources[1].onended();
    check("最后一段结束才 idle 一次", idled.length === 1, String(idled.length));
  }

  console.log(`tts-gapless: fail=${fail}`);
  process.exit(fail ? 1 : 0);
})();
