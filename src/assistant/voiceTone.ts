/**
 * 语音层的情绪表达（纯函数，可单测）。
 *
 * 两件事：
 * 1. **能力告知**——模型要知道自己"有没有嘴"，否则关了语音还在说"我念给你听"，
 *    或者开着语音却写一长段带括号、带符号的句子，念出来全是噪音。
 * 2. **情绪 → 语速/音调/音量**的微调。生气快一点、压一点；低落慢一点、轻一点；
 *    撒娇上扬一点。幅度都很小（语速 ±8、音调 ±2、音量 0.8~1）——
 *    再大就像在演话剧，用户要的是"她今天不对劲"，不是变声器。
 */

export interface VoiceTone {
  /** 语速偏移（-8~8，火山接口的 speech_rate） */
  rate: number;
  /** 音调偏移（-2~2） */
  pitch: number;
  /** 播放音量倍率（0.8~1） */
  volume: number;
}

export interface VoiceToneInput {
  /** 生气时的表达型（决定"冷怒"还是"爆发"） */
  style?: "sarcastic" | "terse" | "pretend";
  /** 当前心情 -1~1 */
  mood: number;
  /** 精力 0~1 */
  energy: number;
  /** 睡眠阶段 */
  sleep?: "awake" | "waking" | "asleep";
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 按心情与精力给一组语音参数 */
export function voiceToneFor(i: VoiceToneInput): VoiceTone {
  let rate = 0;
  let pitch = 0;
  let volume = 1;

  if (i.mood <= -0.55) {
    // 气头上的两种"怒"，听感完全不同：
    //   阴阳怪气 = 冷怒：音高压低、语速反而放慢（拖腔、带刺）
    //   话变少   = 闷怒：更短更轻，不给气口
    //   嘴硬装没事 = 憋着：几乎不变调，只把音高压一点
    if (i.style === "terse") { rate += 1; pitch -= 1.5; volume -= 0.05; }
    else if (i.style === "pretend") { rate -= 1; pitch -= 1; }
    else { rate -= 1; pitch -= 2; } // sarcastic：慢半拍 + 明显压低，最像"阴阳"
  } else if (i.mood < -0.2) {
    if (i.style === "sarcastic") { rate += 1; pitch -= 1; }
    else { rate += 2; pitch -= 0.5; }
  } else if (i.mood >= 0.5) {
    // 心情好：轻快、稍微上扬
    rate += 2; pitch += 1;
  }

  if (i.sleep === "waking") { rate -= 3; volume -= 0.05; }
  if (i.sleep === "asleep") { rate -= 5; volume -= 0.1; }
  if (i.energy < 0.3) { rate -= 4; pitch -= 0.5; volume -= 0.05; }
  else if (i.energy > 0.8 && i.mood >= 0) { rate += 1; }

  return {
    rate: clamp(Math.round(rate), -8, 8),
    pitch: clamp(Number(pitch.toFixed(1)), -3, 3),
    volume: clamp(Number(volume.toFixed(2)), 0.8, 1),
  };
}

/**
 * 给模型看的「你的语音状态」。
 *
 * 这正是项目里那条「能力不支持要前置说明」的延续：模型不知道自己有没有嘴，
 * 就会承诺一个做不到的动作（"我念给你听"），或者写一堆念出来是噪音的符号。
 */
export function voiceCapabilityLine(opts: { enabled: boolean; hasVoice: boolean }): string {
  if (opts.enabled && opts.hasVoice) {
    return "【语音】你的语音输出是开着的：你写的正文会被念出来。所以句子别太长、少用括号和符号，写完自己念一遍通不通顺。";
  }
  if (opts.enabled && !opts.hasVoice) {
    return "【语音】语音开关是开的，但还没配音色，实际上不会出声。不要提「念给你听」这类话。";
  }
  return "【语音】你的语音输出是关着的，只能打字。不要说「我念给你听」「你听我说」这类做不到的话。";
}
