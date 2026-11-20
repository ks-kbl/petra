/**
 * 语气词拖音（②音频拉伸 + ③标点即标记）的纯函数测试。
 *
 * 这里不碰真实音频，用正弦波造一段「静音-发声-静音」，
 * 断言：拉伸后时长变长、但频率（音高）不变、没有 NaN。
 */
const sp = require("./build/tts/prosody.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

// ---------- ③ 标点即标记：拖多长由 AI 写的标点决定 ----------
{
  const think = sp.fillerStretchFor("嗯……然后呢，我就走了。");
  check("★ 省略号 → 思考中的长拖音", !!think && think.kind === "think" && think.factor >= 1.45, JSON.stringify(think));
  const dash = sp.fillerStretchFor("唉——算了算了。");
  check("★ 破折号也算长拖音", !!dash && dash.factor >= 1.45, JSON.stringify(dash));
  const soft = sp.fillerStretchFor("嗯，我知道了。");
  check("逗号 → 轻轻带过", !!soft && soft.kind === "soft" && soft.factor < 1.4, JSON.stringify(soft));
  const plain = sp.fillerStretchFor("嗯。");
  check("★ 句号 → 正常念，不拉", !!plain && plain.factor === 1, JSON.stringify(plain));
  const silent = sp.fillerStretchFor("我不知道你在说什么。");
  check("不是语气词开头就不处理", sp.fillerStretchFor("我不知道") === null);
  const twice = sp.fillerStretchFor("嗯嗯，那行吧。");
  check("★ 两个音节已经是「嗯嗯」了，不能再拉", sp.fillerStretchFor("嗯嗯，那行吧。") === null, JSON.stringify(twice));
  check("前面有空格也能认出来", !!sp.fillerStretchFor("  嗯……"), JSON.stringify(sp.fillerStretchFor("  嗯……")));
  const english = sp.fillerStretchFor("Okay, let me check.");
  check("英文不误伤", english === null);
}

// ---------- 定位：第一段连续发声 ----------
const sr = 24000;
{
  const ch = new Float32Array(sr);
  for (let i = Math.round(0.2 * sr); i < Math.round(0.35 * sr); i++) {
    ch[i] = Math.sin((2 * Math.PI * 200 * i) / sr) * 0.5;
  }
  const run = sp.findFirstVoicedRun([ch], sr, 0, sr);
  check("★ 定位到发声区间起点", !!run && Math.abs(run.start / sr - 0.2) < 0.03, JSON.stringify(run && run.start / sr));
  check("定位到发声区间终点", !!run && Math.abs(run.end / sr - 0.35) < 0.08, JSON.stringify(run && run.end / sr));
  check("全静音时返回 null", sp.findFirstVoicedRun([new Float32Array(sr)], sr, 0, sr) === null);
}

// ---------- ② WSOLA：时长变长，音高不变 ----------
const zeroCrossingsPerSecond = (buf, rate) => {
  let n = 0;
  for (let i = 1; i < buf.length; i++) if ((buf[i - 1] < 0 && buf[i] >= 0)) n++;
  return n / (buf.length / rate);
};
{
  const len = Math.round(0.4 * sr);
  const ch = new Float32Array(len);
  for (let i = 0; i < len; i++) ch[i] = Math.sin((2 * Math.PI * 300 * i) / sr) * 0.6;
  const out = sp.wsola([ch], sr, 0, len, 1.6);
  const o = out[0];
  check("★ 拉伸后时长约 1.6 倍", Math.abs(o.length / len - 1.6) < 0.08, String(o.length / len));
  const f0 = zeroCrossingsPerSecond(ch, sr);
  const f1 = zeroCrossingsPerSecond(o, sr);
  check("★ 音高没有被改变（过零率一致）", Math.abs(f1 - f0) / f0 < 0.06, `${f0.toFixed(1)} → ${f1.toFixed(1)}`);
  check("没有 NaN/Infinity", o.every((v) => Number.isFinite(v)));
  check("幅度量级没变", Math.max(...o) < 1 && Math.max(...o) > 0.3, String(Math.max(...o)));
  const same = sp.wsola([ch], sr, 0, len, 1.0);
  check("倍数 1 时原样返回", same[0].length === len, String(same[0].length));
}

// ---------- 拼接：长度、尾部衰减、边界 ----------
{
  const total = sr; // 1 秒
  const ch = new Float32Array(total);
  for (let i = 0; i < total; i++) ch[i] = Math.sin((2 * Math.PI * 220 * i) / sr) * 0.4;
  const span = { start: Math.round(0.1 * sr), end: Math.round(0.3 * sr) };
  const stretched = sp.wsola([ch], sr, span.start, span.end, 1.6);
  const out = sp.spliceStretched([ch], span, stretched, sr);
  const expect = total - (span.end - span.start) + stretched[0].length;
  check("★ 拼接后总长度正确", out[0].length === expect, `${out[0].length} vs ${expect}`);
  check("拼接后没有 NaN", out[0].every((v) => Number.isFinite(v)));
  check("段前内容原样保留", Math.abs(out[0][0] - ch[0]) < 1e-6);
  check("★ 拖音尾巴有衰减（不是硬戛然而止）", Math.abs(out[0][span.start + stretched[0].length - 1]) < Math.abs(out[0][span.start]) + 1e-6);
}

// ---------- 端到端：文字 + 音频 → 变长 ----------
{
  const total = Math.round(0.8 * sr);
  const ch = new Float32Array(total);
  // 前 0.15s 静音 → 0.15~0.35s 的「嗯」（200Hz 鼻音）→ 后面安静
  for (let i = Math.round(0.15 * sr); i < Math.round(0.35 * sr); i++) {
    ch[i] = Math.sin((2 * Math.PI * 200 * i) / sr) * 0.5;
  }
  const long = sp.stretchFillerInChannels([ch], sr, "嗯……然后我就去了。");
  check("★ 拖音生效：整段音频变长", long.stretched && long.channels[0].length > total, `${total} → ${long.channels[0].length}`);
  check("★ 拖音倍数收在 1.5（1.7 会拉开泛音变电音）", long.factor === 1.5, String(long.factor));
  check("拖音后没有 NaN", long.channels[0].every(Number.isFinite));
  const short = sp.stretchFillerInChannels([ch], sr, "我不知道。");
  check("不是语气词开头就不动音频", !short.stretched && short.channels[0].length === total);
  const plain = sp.stretchFillerInChannels([ch], sr, "嗯。");
  check("句号结尾的「嗯」不拉", !plain.stretched, String(plain.factor));
}

// ---------- 光一个语气词的判断（用来并回后一句） ----------
{
  check("★ 「嗯……」算纯语气词", sp.isBareFiller("嗯……") === true);
  check("「哦，」也算", sp.isBareFiller("哦，") === true);
  check("带内容就不算", sp.isBareFiller("嗯……这个我看看") === false);
  check("普通句子不算", sp.isBareFiller("我不知道。") === false);
}

// ---------- 音高下沉：拖长时音高要往下掉一点，才不像卡带 ----------
{
  const len = Math.round(0.3 * sr);
  const ch = new Float32Array(len);
  for (let i = 0; i < len; i++) ch[i] = Math.sin((2 * Math.PI * 200 * i) / sr) * 0.5;
  const out = sp.pitchDown([ch], 0.97)[0];
  check("★ 音高下沉后时长变长", out.length > len, `${len} → ${out.length}`);
  const before = zeroCrossingsPerSecond(ch, sr);
  const after = zeroCrossingsPerSecond(out, sr);
  check("★ 音高确实降低了约 3%", after < before && Math.abs(after / before - 0.97) < 0.03, `${before.toFixed(1)} → ${after.toFixed(1)}`);
  check("音高不变时原样返回", sp.pitchDown([ch], 1)[0].length === len);
}

// ---------- 短叹词：哼 / 切 / 啧（音高朝下、收得干脆） ----------
{
  const angry = sp.interjectionFor("哼！我才不要。");
  check("★ 认出生气的「哼」", !!angry && angry.spec.kind === "angry", JSON.stringify(angry && angry.spec.kind));
  const c0 = angry.spec.contour;
  check("★ 哼是降调（起始高、结束低）", c0[0].pitch > c0[c0.length - 1].pitch, JSON.stringify(c0));
  check("认出不以為然的「切」", sp.interjectionFor("切，谁稀罕。")?.spec.kind === "scoff");
  check("认出冷笑的「呵」", sp.interjectionFor("呵，是吗。")?.spec.kind === "sneer");
  check("「哼哼」两声不处理", sp.interjectionFor("哼哼，你猜。") === null);
  check("普通句子不误伤", sp.interjectionFor("我不知道。") === null);

  // 造一段 0.4 秒、200Hz 的"数据版 hēng"，看压完是不是变短、降调、收得快
  const total = Math.round(0.8 * sr);
  const ch = new Float32Array(total);
  for (let i = Math.round(0.15 * sr); i < Math.round(0.55 * sr); i++) {
    ch[i] = Math.sin((2 * Math.PI * 200 * i) / sr) * 0.5;
  }
  const span = { start: Math.round(0.15 * sr), end: Math.round(0.55 * sr) };
  const shaped = sp.shapeInterjection([ch], sr, span, angry.spec)[0];
  const want = Math.round(0.24 * sr);
  check("★ 压成短音（约 0.24 秒）", Math.abs(shaped.length - want) < sr * 0.05, `${(shaped.length / sr).toFixed(3)}s`);
  const quarter = Math.floor(shaped.length / 4);
  const head = zeroCrossingsPerSecond(shaped.subarray(0, quarter), sr);
  const tail = zeroCrossingsPerSecond(shaped.subarray(shaped.length - quarter), sr);
  check("★ 音高从高往低走（前段过零率更高）", head > tail * 1.1, `${head.toFixed(0)} → ${tail.toFixed(0)}`);
  const headAmp = Math.max(...shaped.subarray(0, quarter));
  const tailAmp = Math.max(...shaped.subarray(shaped.length - quarter));
  check("★ 收尾衰减（不是硬切断）", tailAmp < headAmp * 0.8, `${headAmp.toFixed(3)} → ${tailAmp.toFixed(3)}`);
  check("压完没有 NaN", shaped.every(Number.isFinite));

  // 端到端：整段音频应该变短（hēng 被压成一声"哼"）
  const res = sp.stretchFillerInChannels([ch], sr, "哼！我才不要。", 0);
  check("★ 端到端：整段音频变短", res.stretched && res.channels[0].length < total, `${total} → ${res.channels[0].length}`);
}

// ---------- 同一个字，标点不同 = 不同的音高曲线 ----------
{
  const curious = sp.interjectionFor("诶？你说啥。");
  check("★ 诶？是好奇上挑", !!curious && curious.spec.kind === "curious", JSON.stringify(curious && curious.spec.kind));
  const cq = curious.spec.contour;
  check("★ 上挑：结尾比开头高", cq[cq.length - 1].pitch > cq[0].pitch, JSON.stringify(cq));

  const startled = sp.interjectionFor("诶！你怎么在这。");
  check("诶！是被吓到", startled?.spec.kind === "surprised", String(startled?.spec.kind));
  const cs = startled.spec.contour;
  const peak = Math.max(...cs.map((p) => p.pitch));
  check("★ 先升后降：中间最高、两头低", peak > cs[0].pitch && peak > cs[cs.length - 1].pitch, JSON.stringify(cs));

  const realize = sp.interjectionFor("哦！原来是这样。");
  check("哦！是恍然大悟", realize?.spec.kind === "realize", String(realize?.spec.kind));
  check("哦？是追问", sp.interjectionFor("哦？真的假的。")?.spec.kind === "curious");
  check("啊？没听清", sp.interjectionFor("啊？你再说一遍。")?.spec.kind === "curious");
  check("哈？反问", sp.interjectionFor("哈？这也行？")?.spec.kind === "curious");
  check("哈！保留合成的笑声，不重制送气", sp.interjectionFor("哈！真有意思。")?.spec.preserveOriginal === true);
  check("嗯？是追问（上挑）", sp.interjectionFor("嗯？你刚说什么。")?.spec.kind === "curious");

  // 表里没有的组合要放行给拖音那条线，别抢
  check("★ 哦…… 交给拖音处理，不抢", sp.interjectionFor("哦……我想起来了。") === null);
  check("诶…… 同样放行", sp.interjectionFor("诶……好像有点印象。") === null);
  check("唉…… 也放行", sp.interjectionFor("唉……算了吧。") === null);
}

// ---------- 上挑的音高真的往上走（音频验证） ----------
{
  const total = Math.round(0.8 * sr);
  const ch = new Float32Array(total);
  for (let i = Math.round(0.15 * sr); i < Math.round(0.5 * sr); i++) {
    ch[i] = Math.sin((2 * Math.PI * 200 * i) / sr) * 0.5;
  }
  const res = sp.stretchFillerInChannels([ch], sr, "诶？你说啥。", 0);
  check("★ 诶？会被处理", res.stretched);
  const out = res.channels[0];
  const q = Math.floor(out.length / 4);
  // 找到处理后那段在整段里的位置：跳过前面的静音
  const run = sp.findFirstVoicedRun([out], sr, 0, out.length);
  const seg = out.subarray(run.start, run.end);
  // 用自相关测周期比数过零率稳（过零对低幅度尾音很敏感）
  const third = Math.floor(seg.length / 3);
  const pHead = sp.estimatePeriod(seg.subarray(0, third), sr);
  const pTail = sp.estimatePeriod(seg.subarray(seg.length - third), sr);
  const headHz = pHead ? sr / pHead : 0;
  const tailHz = pTail ? sr / pTail : 0;
  check("★ 上挑：尾部音高高于头部", tailHz > headHz * 1.05, `${headHz.toFixed(0)}Hz → ${tailHz.toFixed(0)}Hz`);
  check("上挑后没有 NaN", out.every(Number.isFinite));
}

// ---------- 周期拼接：治「电音」 ----------
{
  // 200Hz 的准周期信号：周期应是 sr/200 = 120 采样
  const len = Math.round(0.25 * sr);
  const ch = new Float32Array(len);
  for (let i = 0; i < len; i++) ch[i] = Math.sin((2 * Math.PI * 200 * i) / sr) * 0.5;
  const period = sp.estimatePeriod(ch.subarray(0, Math.round(sr * 0.04)), sr);
  check("★ 能估出基音周期（200Hz ≈ 120 采样）", !!period && Math.abs(period - sr / 200) < 6, String(period));

  const out = sp.stretchVoiced([ch], sr, 0, len, 1.5, period)[0];
  check("★ 周期拼接：时长约 1.5 倍", Math.abs(out.length / len - 1.5) < 0.1, (out.length / len).toFixed(2));
  const f0 = zeroCrossingsPerSecond(ch, sr);
  const f1 = zeroCrossingsPerSecond(out, sr);
  check("★ 周期拼接：音高不变", Math.abs(f1 - f0) / f0 < 0.05, `${f0.toFixed(0)} → ${f1.toFixed(0)}`);

  // 电音的典型特征是"幅度忽大忽小"：逐 10ms 窗口算 RMS，波动必须很小
  const frame = Math.round(sr * 0.01);
  const rms = [];
  for (let i = frame * 3; i + frame < out.length - frame * 3; i += frame) {
    let sum = 0;
    for (let k = 0; k < frame; k++) sum += out[i + k] * out[i + k];
    rms.push(Math.sqrt(sum / frame));
  }
  const rMax = Math.max(...rms);
  const rMin = Math.min(...rms);
  check("★ 周期拼接：包络平稳（没有电音那种起伏）", rMax / rMin < 1.4, (rMax / rMin).toFixed(2));

  // WSOLA 在同样输入上会出现更明显的起伏，这里只确认它还能跑（兜底路径别坏）
  const ws = sp.wsola([ch], sr, 0, len, 1.5)[0];
  check("兜底 WSOLA 仍然可用", ws.length > len && ws.every(Number.isFinite));
}

// ---------- 端到端：走的是周期拼接这条路 ----------
{
  const total = Math.round(0.8 * sr);
  const ch = new Float32Array(total);
  for (let i = Math.round(0.15 * sr); i < Math.round(0.4 * sr); i++) {
    ch[i] = Math.sin((2 * Math.PI * 180 * i) / sr) * 0.5;
  }
  const res = sp.stretchFillerInChannels([ch], sr, "嗯……这个我得先想想。", 0);
  check("★ 鼻音走的是 psola 路径（不是 wsola）", res.mode === "psola", String(res.mode));
  check("psola 结果没有 NaN", res.channels[0].every(Number.isFinite));
}

// ---------- 低通：电音的高频碎屑 ----------
{
  const mk = (hz) => {
    const len = Math.round(0.2 * sr);
    const ch = new Float32Array(len);
    for (let i = 0; i < len; i++) ch[i] = Math.sin((2 * Math.PI * hz * i) / sr) * 0.5;
    return ch;
  };
  const amp = (b) => Math.max(...b.subarray(Math.floor(b.length / 3)));
  const low = sp.lowpass([mk(200)], sr, 3600)[0];
  const high = sp.lowpass([mk(6000)], sr, 3600)[0];
  check("★ 低通保住基频", amp(low) > 0.3, amp(low).toFixed(2));
  check("★ 低通把 6kHz 毛刺压掉", amp(high) < 0.12, amp(high).toFixed(3));
}

// ---------- 短叹词的包络也要平稳（不能忽大忽小） ----------
{
  const total = Math.round(0.8 * sr);
  const ch = new Float32Array(total);
  for (let i = Math.round(0.15 * sr); i < Math.round(0.55 * sr); i++) {
    ch[i] = Math.sin((2 * Math.PI * 190 * i) / sr) * 0.5;
  }
  const shaped = sp.shapeInterjection([ch], sr, { start: Math.round(0.15 * sr), end: Math.round(0.55 * sr) },
    sp.interjectionFor("哼！我才不要。").spec)[0];
  const frame = Math.round(sr * 0.01);
  const rms = [];
  for (let i = frame; i + frame < shaped.length - frame; i += frame) {
    let sum = 0;
    for (let k = 0; k < frame; k++) sum += shaped[i + k] * shaped[i + k];
    rms.push(Math.sqrt(sum / frame));
  }
  // 短叹词本来就要"先响后收"，所以不能测"平不平"，要测"有没有来回抖"：
  // 电音的典型波形是幅度周期性忽大忽小，反映到 RMS 曲线上就是反复的升降反转。
  let reversals = 0;
  for (let i = 1; i < rms.length - 1; i++) {
    const a = rms[i] - rms[i - 1];
    const b = rms[i + 1] - rms[i];
    if (a * b < 0 && Math.abs(a) > 0.01 && Math.abs(b) > 0.01) reversals++;
  }
  check("★ 短叹词包络没有来回抖（电音特征）", reversals <= 2, `反转 ${reversals} 次`);
  check("短叹词仍然很短", shaped.length / sr < 0.3, (shaped.length / sr).toFixed(2));
}

// ---------- 塞擦音「切」不能被低通闷掉 ----------
{
  const qie = sp.interjectionFor("切，谁稀罕。");
  check("★ 切仍然被识别", !!qie && qie.spec.kind === "scoff");
  check("★ 切优先保留原始音频", qie?.spec.preserveOriginal === true);
  check("★ 切换不是短叹词", sp.interjectionFor("切换模型") === null);
  const source = new Float32Array([0, 0.15, -0.2, 0.25, -0.1, 0, 0.75]);
  const result = sp.stretchFillerInChannels([source], sr, "切，彩虹卡就把本鱼藏的红烧肉编进文案了？");
  check("★ 切和后续整句保持同一份 PCM，无增益/衰减/变调", !result.stretched && result.channels[0] === source);
  const direct = sp.shapeInterjection([source], sr, { start: 1, end: 5 }, qie.spec)[0];
  check("★ 直接调用整形也不会修改切的采样", direct.every((sample, i) => sample === source[i + 1]) && direct.length === 4);
  const heng = sp.interjectionFor("哼！我才不要。");
  check("鼻音「哼」仍可用较强低通", (heng.spec.cutoff ?? 6000) <= 6000, String(heng.spec.cutoff));

  // 直接验证低通截止的作用：同样是 6kHz，3600 会砍掉，9000 基本保留
  const len = Math.round(0.2 * sr);
  const high = new Float32Array(len);
  for (let i = 0; i < len; i++) high[i] = Math.sin((2 * Math.PI * 6000 * i) / sr) * 0.5;
  const amp = (b) => Math.max(...b.subarray(Math.floor(b.length / 3)));
  const cut36 = amp(sp.lowpass([high], sr, 3600)[0]);
  const cut9k = amp(sp.lowpass([high], sr, 9000)[0]);
  check("★ 9kHz 低通保留的高频远多于 3.6kHz", cut9k > cut36 * 2, `${cut36.toFixed(3)} vs ${cut9k.toFixed(3)}`);
}

// ---------- 全表体检：每种音都要选对低通、时长、起音 ----------
{
  const cases = [
    // [文本, 期望最低低通, 期望最短时长, 说明]
    ["哼！", 4000, 0.2, "鼻音：可以压"],
    ["呵，是吗。", 7500, 0.22, "送气冷笑：要保住 h"],
    ["切，谁稀罕。", 8500, 0.24, "塞擦音：要保住 q"],
    ["嘁。", 8500, 0.24, "塞擦音"],
    ["啧。", 8500, 0.22, "塞擦音"],
    ["呸！", 9000, 0.2, "爆破音：要保住冲音"],
    ["噗。", 9000, 0.2, "爆破音"],
    ["嘶——", 10000, 0.24, "擦音：全靠高频"],
    ["嘘——", 10000, 0.24, "擦音：全靠高频"],
    ["诶？", 6000, 0.26, "元音起头，正常低通"],
    ["咦？", 6500, 0.26, "元音起头"],
    ["哦！", 5500, 0.26, "元音"],
    ["啊？", 5500, 0.24, "元音"],
    ["哈？", 7500, 0.24, "送气：要保住 h"],
  ];
  for (const [text, minCut, minDur, why] of cases) {
    const hit = sp.interjectionFor(text);
    const name = text.replace(/[，。！？—]/g, "");
    check(`★ ${name} 能被识别（${why}）`, !!hit, text);
    if (!hit) continue;
    check(`★ ${name} 低通不低于 ${minCut}`, (hit.spec.cutoff ?? 6000) >= minCut, String(hit.spec.cutoff ?? "默认6000"));
    check(`★ ${name} 时长不短于 ${minDur}s`, hit.spec.duration >= minDur, String(hit.spec.duration));
  }
  // 爆破音/擦音的起音必须很冲，否则冲音被包络抹平
  for (const t of ["呸！", "噗。", "嘶——", "嘘——"]) {
    check(`★ ${t[0]} 的起音够冲（≤2ms）`, (sp.interjectionFor(t)?.spec.attack ?? 1) <= 0.002, String(sp.interjectionFor(t)?.spec.attack));
  }
}

// ---------- 按真实行为回归：高风险音全部保留原采样；不连带改后文 ----------
{
  const source = new Float32Array([0, 0.15, -0.2, 0.25, -0.1, 0, 0.75]);
  for (const token of ["切", "嘁", "啧", "呸", "啐", "噗", "嘶", "嘘", "呵", "哈"]) {
    const text = `${token}，你听见了吗？`;
    const spec = sp.interjectionFor(text)?.spec;
    const result = sp.stretchFillerInChannels([source], sr, text);
    check(`★ ${token} 独立叹词原声通过`, spec?.preserveOriginal && !result.stretched && result.channels[0] === source);
  }
  for (const literal of ["哼唱", "呵护", "切换", "噗通", "嘶哑", "哈哈", "哈欠", "切 片"]) {
    check(`★ ${literal} 不误判为独立叹词`, sp.interjectionFor(literal) === null);
  }
  const connected = Float32Array.from({ length: Math.round(sr * 0.35) }, (_, i) => Math.sin(2 * Math.PI * 200 * i / sr) * 0.4);
  for (const head of ["嗯……", "哼！", "诶？"]) {
    const result = sp.stretchFillerInChannels([connected], sr, `${head}后文实际连读`);
    check(`★ ${head} 未检测到停顿时保留原声`, !result.stretched && result.channels[0] === connected);
  }
  let random = 747;
  const noise = Float32Array.from({ length: Math.round(sr * 0.2) }, () => {
    random = (Math.imul(1664525, random) + 1013904223) >>> 0;
    return (random / 0x100000000 - 0.5) * 0.6;
  });
  const noisy = sp.stretchFillerInChannels([noise], sr, "嗯……");
  check("★ 无稳定周期的音频不走强行拼接", !noisy.stretched && noisy.channels[0] === noise);
  const suffix = Float32Array.from({ length: Math.round(sr * 0.05) }, () => 0.5);
  const input = new Float32Array(2 * suffix.length);
  input.set(suffix, suffix.length);
  const joined = sp.spliceStretched([input], { start: 0, end: suffix.length }, [new Float32Array(suffix.length * 2)], sr)[0];
  check("★ 下一段原声起音没有被拼接淡化", joined.subarray(-suffix.length).every((v, i) => v === suffix[i]));
}

// ---------- 低通的"柔和档"：单极只削毛边，不动中频 ----------
{
  const len = Math.round(0.2 * sr);
  const mk = (hz) => {
    const b = new Float32Array(len);
    for (let i = 0; i < len; i++) b[i] = Math.sin((2 * Math.PI * hz * i) / sr) * 0.5;
    return b;
  };
  const amp = (b) => Math.max(...b.subarray(Math.floor(b.length / 3)));
  const mid = mk(1500);
  const hard = sp.lowpass([mid], sr, 4300, 2)[0];
  const soft = sp.lowpass([mid], sr, 8000, 1)[0];
  check("★ 柔和档（单极 8kHz）基本不动中频", amp(soft) > amp(mid) * 0.85, amp(soft).toFixed(2));
  check("重度档（双极 4.3kHz）会明显削中频", amp(hard) < amp(mid) * 0.8, amp(hard).toFixed(2));
}

console.log(`prosody: fail=${fail}`);
process.exit(fail ? 1 : 0);
