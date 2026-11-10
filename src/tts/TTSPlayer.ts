/**
 * TTS 播放队列 - 调用豆包声音复刻 API
 *
 * 断句 → 预加载 → 顺序播放。
 *
 * 2026-11 的「更流畅」改造：
 * 以前每一句都是独立的 `new Audio()`：句与句之间要等上一段 `onended` 再 `play()`，
 * 而每段合成音频首尾都带着几十到几百毫秒的静音 padding —— 连起来就是明显的
 * 「一顿一顿」。现在改成：
 *   1. 用 Web Audio 解码，把每段首尾的静音裁掉（保留一点点自然尾音）；
 *   2. 多段音频**提前排好时间轴**连续调度，段与段之间不再等事件回调；
 *   3. 只在真正的句末留 ~70ms 停顿，逗号/超长兜底切开的地方只留 ~15ms；
 *   4. 每段进出各做几毫秒淡入淡出，接缝处没有咔哒声。
 * 浏览器不支持 Web Audio 或解码失败时，自动退回原来的 HTMLAudioElement 队列
 * （Node 单测也走这条兜底路径，逻辑和旧版一致）。
 */

import { invoke } from "@tauri-apps/api/core";
import { loadSettings } from "../utils/settings";
import { takeSpeechSegment, flushSpeechSegment } from "./sentenceSplit";

interface QueueItem {
  text: string;
  /** 合成出来的 MP3 字节（失败时为 null） */
  bytes: Uint8Array | null;
  /** 兜底播放用的音频元素（Web Audio 解码成功时不需要） */
  audio: HTMLAudioElement | null;
  blobUrl: string | null;
  ready: boolean;
  /** 解码后的音频 + 裁剪后的起点/时长 */
  decoded: { buffer: AudioBuffer; offset: number; duration: number } | null;
  /** 入队时的播放代次：stop() 之后旧请求的异步结果不能再影响新一轮 */
  gen: number;
  /** 这段之后该停多久（秒）：按原文结尾判断，不能看补过句号的 text */
  pause: number;
}

/** 句末标点：只有这些结尾才值得留一个自然停顿 */
const SENTENCE_END_RE = /[。！？!?…]$/;
/** 句末停顿（秒）；逗号/兜底切开处只留很短的接缝 */
const PAUSE_SENTENCE = 0.07;
const PAUSE_SOFT = 0.015;
/** 调度时留一点提前量，避免 `currentTime` 已经越过开始时间 */
const SCHEDULE_LEAD = 0.035;
/** 裁剪静音时首尾各保留的余量（秒） */
const TRIM_HEAD_PAD = 0.015;
const TRIM_TAIL_PAD = 0.025;

/**
 * 找出音频里「真正有声音」的区间（纯函数，方便单测）。
 *
 * 阈值按本段峰值自适应：安静录音不会被误判成全程静音，而轻喷麦/底噪又不会被当成语音。
 * 整段都低于阈值时返回完整区间 —— 宁可多播一点静音，也不能把整句裁没。
 */
export function findSpeechBounds(
  channels: Float32Array[],
  sampleRate: number,
): { offset: number; duration: number } {
  const total = channels[0]?.length ?? 0;
  if (!total || !sampleRate) return { offset: 0, duration: 0 };
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i]);
      if (v > peak) peak = v;
    }
  }
  if (peak <= 0) return { offset: 0, duration: total / sampleRate };
  const threshold = Math.max(0.002, Math.min(0.01, peak * 0.015));
  const loudAt = (i: number) => {
    for (const ch of channels) {
      if (Math.abs(ch[i]) >= threshold) return true;
    }
    return false;
  };
  let start = 0;
  while (start < total && !loudAt(start)) start++;
  if (start >= total) return { offset: 0, duration: total / sampleRate };
  let end = total - 1;
  while (end > start && !loudAt(end)) end--;
  const headPad = Math.round(TRIM_HEAD_PAD * sampleRate);
  const tailPad = Math.round(TRIM_TAIL_PAD * sampleRate);
  start = Math.max(0, start - headPad);
  end = Math.min(total, end + tailPad + 1);
  return { offset: start / sampleRate, duration: Math.max(0.01, (end - start) / sampleRate) };
}

/**
 * 这段文字之后该停多久。
 *
 * 句末 70ms（自然换气）；逗号/分号处切断只留 15ms，避免把一句话读成两截；
 * 换行或超长兜底切开（没有标点）留 45ms，比逗号更像一个停顿，但不像句末那么重。
 */
export function pauseAfterSegment(text: string): number {
  const t = text.trim();
  if (SENTENCE_END_RE.test(t)) return PAUSE_SENTENCE;
  if (/[，,、；;：:]$/.test(t)) return PAUSE_SOFT;
  return 0.045;
}

/**
 * 情绪 → 中文语气口令（火山「声音复刻 2.0」的 context_texts）。
 *
 * 为什么用自然语言而不是 emotion 枚举：官方的 `audio_params.emotion` 只对**部分音色**生效，
 * 而声音复刻的自定义音色基本不在那批里；`context_texts` 是对话式合成的语气指令，
 * 明确支持"声音复刻大模型 2.0 的表现力增强版"，而且这段文字不计费。
 */
const EMOTION_TONE: Record<string, string> = {
  happy: "用轻快、开心的语气说，尾音稍微往上扬一点",
  shy: "用有点害羞、声音小一点、略带撒娇的语气说",
  sad: "用低落、轻一点、稍微慢一点的语气说",
  angry: "带着不满和嫌弃的语气说，语速稍快一点",
  surprised: "带着惊讶的语气说，语气起伏大一点",
  neutral: "用日常聊天、轻松自然的语气说",
};

/**
 * 情绪 → 语速/音调偏移（AI 自己判断，不给用户调）。
 * 幅度都压得很小：语速 ±8 已经能听出情绪，再大就像在演话剧。
 */
const EMOTION_VOICE: Record<string, { rate: number; pitch: number }> = {
  happy: { rate: 6, pitch: 1 },
  shy: { rate: -4, pitch: 2 },
  sad: { rate: -8, pitch: -2 },
  angry: { rate: 8, pitch: 1 },
  surprised: { rate: 4, pitch: 3 },
  neutral: { rate: 0, pitch: 0 },
};

/** CoT 语音标签里用的短标签（太长会把单句撑过 64 字限制） */
const EMOTION_TAG_TEXT: Record<string, string> = {
  happy: "开心",
  shy: "害羞",
  sad: "低落",
  angry: "不满",
  surprised: "惊讶",
  neutral: "平静",
};

/**
 * 把一段话按情绪包成 CoT 语音标签（火山的行为标签，需配合 use_tag_parser）。
 * 导出成纯函数是为了能单测"太长就不包"这条规则。
 */
export function wrapCotTag(text: string, emotion: string, maxChars = 60): string | null {
  const tag = EMOTION_TAG_TEXT[emotion] ?? EMOTION_TAG_TEXT.neutral;
  const wrapped = `<cot text=${tag}>${text}</cot>`;
  return wrapped.length <= maxChars ? wrapped : null;
}

/** 情绪 → 中文语气口令（导出给单测与调试用） */
export function emotionToneInstruction(emotion: string): string {
  return EMOTION_TONE[emotion] ?? EMOTION_TONE.neutral;
}

/** 火山一次请求里的语气参数（与 Rust 侧 TtsTone 同构，camelCase） */
interface TtsTonePayload {
  model?: string;
  contextText?: string;
  useTagParser?: boolean;
  speechRate?: number;
  pitch?: number;
  sectionId?: string;
}

/** 单句文本 + 标签后最好别超过 64 字（官方建议，标签也计入） */
const COT_MAX_CHARS = 60;

class TTSPlayer {
  private enabled = false;
  private apiKey = "";
  private speakerId = "";
  private language = "";
  private queue: QueueItem[] = [];
  private speaking = false;
  private buffer = "";
  private stopped = false;
  private idleCallbacks: (() => void)[] = [];
  /** 唤醒词监听在 TTS 播放期间要暂停，避免把自己说的话当成唤醒词 */
  private wakeResumeTimer: number | null = null;
  /** 当前这段回复的情绪（由 AssistantPanel 在流式解析出情绪标签时喂进来） */
  private emotionTag = "neutral";
  /** 多轮上下文 id：同一段回复共用，让几句之间的语气连贯 */
  private sectionId = "";
  muted = false;

  /** 兜底播放时正在响的元素（Web Audio 路径用不到） */
  private current: HTMLAudioElement | null = null;

  /** Web Audio 上下文：懒创建；创建失败/不支持时永远走兜底 */
  private ctx: AudioContext | null = null;
  private ctxBroken = false;
  /** 主音量节点：静音开关直接改它，正在播的每一段立刻生效 */
  private masterGain: GainNode | null = null;
  /** 已经排进时间轴、还没播完的 source */
  private scheduled = new Set<AudioBufferSourceNode>();
  /** 下一段应该从 ctx 的哪个时间点开始 */
  private nextStartAt = 0;
  /** 只要有一段解码失败，就当这个端点给的格式 Web Audio 处理不了，后续全走兜底 */
  private decodeBroken = false;
  /** 播放代次：每次 stop() 自增，用来丢弃上一轮还在路上的合成/解码结果 */
  private generation = 0;

  /**
   * 注册「这段说完」回调。
   *
   * 如果注册的时候已经不在播、队列也空了（短回复在气泡挂回调之前就播完了），
   * 直接回调一次 —— 否则调用方只能等 120 秒兜底，气泡会一直赖在屏幕上。
   */
  onIdle(cb: () => void) {
    if (!this.isSpeaking() && this.queue.length === 0) { cb(); return; }
    this.idleCallbacks.push(cb);
  }

  /**
   * 播报期间暂停本地唤醒词监听（播完再等 300ms 恢复，躲开混响尾音）。
   * 只调 Rust 的开关，不碰音频链路；唤醒没开时这两个 invoke 也是空转，无副作用。
   */
  private setWakePaused(paused: boolean) {
    try {
      if (paused) {
        if (this.wakeResumeTimer) { window.clearTimeout(this.wakeResumeTimer); this.wakeResumeTimer = null; }
        void invoke("wake_set_paused", { paused: true }).catch(() => {});
      } else {
        if (this.wakeResumeTimer) window.clearTimeout(this.wakeResumeTimer);
        this.wakeResumeTimer = window.setTimeout(() => {
          this.wakeResumeTimer = null;
          void invoke("wake_set_paused", { paused: false }).catch(() => {});
        }, 300);
      }
    } catch { /* 忽略：唤醒功能没启用时不影响朗读 */ }
  }

  /**
   * 现在有没有声音正在播。
   *
   * 语音输入要用它做「抢话」判断：麦克风开着的同时 TTS 在响，识别会把桌宠
   * 自己的声音也听进去（回声），必须先停掉再开麦。
   */
  isSpeaking(): boolean { return this.speaking || this.scheduled.size > 0; }

  /**
   * 实时静音开关：立刻作用于**正在播的这一段**，不用等下一句。
   *
   * 用音量 0 而不是 pause()：静音期间队列要继续走完（气泡的消失时机、
   * onIdle 回调都挂在"播完"上），暂停会让整条链卡住。
   */
  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.masterGain) this.masterGain.gain.value = muted ? 0 : 1;
    if (this.current) this.current.volume = muted ? 0 : 1;
  }

  /**
   * 设置当前回复的情绪（happy / shy / sad / angry / surprised / neutral）。
   * 只影响**之后**合成的句子：情绪标签通常出现在回复开头，所以整段基本都能带上。
   */
  setEmotion(tag: string) {
    const t = (tag || "neutral").trim();
    if (t !== this.emotionTag) this.emotionTag = t;
  }

  setConfig(enabled: boolean, apiKey: string, speakerId: string, language = "") {
    this.enabled = enabled;
    this.apiKey = apiKey;
    this.speakerId = speakerId;
    this.language = language;
    if (!enabled) this.stop();
  }

  /**
   * 语音输出是否**真的**配置好了（开关 + Key + 音色都齐）。
   *
   * 气泡淡出时机要按这个判断：以前调用方读的是 `settings.tts.apiKey`，而那个字段
   * 从来没被赋值（Key 存在 Rust 里，前端只在 setConfig 时传一次），条件恒 false，
   * 于是「等播完再淡出」永远是死代码，长回复的气泡在朗读到一半时就消失了。
   */
  get configured(): boolean {
    return this.enabled && Boolean(this.apiKey) && Boolean(this.speakerId);
  }

  pushDelta(delta: string) {
    if (!this.enabled || !this.apiKey || !this.speakerId) return;
    if (this.stopped) return;
    this.buffer += delta;
    // 遇到翻译分隔符，只读前面的外文原文
    if (this.buffer.includes("\n---")) {
      this.buffer = this.buffer.split("\n---")[0];
      this.stopped = true;
    }
    // 攒够一句再送：短句会合并，不会出现"好。/对。"各自合成一次的碎片感
    let seg: { segment: string; rest: string } | null = null;
    while ((seg = takeSpeechSegment(this.buffer))) {
      this.buffer = seg.rest;
      this.enqueue(seg.segment);
    }
  }

  flush() {
    if (!this.enabled) return;
    if (!this.stopped) {
      const rest = flushSpeechSegment(this.buffer);
      if (rest) this.enqueue(rest);
    }
    this.buffer = "";
    this.stopped = false;
  }

  stop() {
    this.generation++;
    // 新一段回复 = 新的语气上下文，section_id 重新生成
    this.sectionId = "";
    this.emotionTag = "neutral";
    this.queue = [];
    this.buffer = "";
    this.speaking = false;
    this.stopped = false;
    // 每次新回复都重新试一次 Web Audio：上一段解码失败可能只是偶发的坏包，
    // 不该让整个进程以后都退化成有缝的兜底播放。
    this.decodeBroken = false;
    // 停掉所有已经排进时间轴的音频（Web Audio 不能靠 pause()，必须 stop()）
    for (const src of this.scheduled) {
      try { src.stop(); } catch { /* 已经结束的 source stop() 会抛，忽略 */ }
    }
    this.scheduled.clear();
    this.nextStartAt = 0;
    // 兜底路径：音频元素不在 DOM 里，只能停自己持有的引用
    this.current?.pause();
    this.current = null;
    // 播报途中被 stop（关语音/发新消息）时唤醒监听本来会一直保持暂停，
    // 这里恢复一次；真要继续播的话下一次开播会再pause，不会误唤醒。
    this.setWakePaused(false);
  }

  private enqueue(text: string) {
    const original = text.trim();
    const pause = pauseAfterSegment(original);
    let clean = text
      // 括号里的动作/旁白不读（"（笑）""(小声)"），否则会念出来很出戏
      .replace(/[（(][^）)]*[）)]/g, "")
      .replace(/[*_`#~|]/g, "")
      // 分隔线/引用符号不读：否则 TTS 会把 "---" 念成"减号减号减号"
      .replace(/^\s*[-=]{3,}\s*$/gm, "")
      .replace(/^\s*>+\s?/gm, "")
      // Markdown 列表符号/序号不读："- 第一点" → "第一点"
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+[.)、]\s*/gm, "")
      .replace(/\n---\n[\s\S]*$/, "")
      // 语音标签：正常情况由服务端解析掉；万一这次请求退回了标准参数，
      // 标签会被**原样念出来**（"cot text 开心"），所以这里再兜一层
      .replace(/<\/?cot[^>]*>/gi, "")
      // 代码块整段不读：念出来全是符号和变量名，气泡里看着是代码，耳朵里是乱码
      .replace(/```[\s\S]*?```/g, "（这段是代码）")
      .replace(/`([^`]+)`/g, "$1")
      // 链接只读文字，不念 URL
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "（链接）")
      // 表格竖线/分隔行不读
      .replace(/^\s*\|?[\s:|-]{4,}\|?\s*$/gm, "")
      .replace(/\|/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    // 补一个句末标点：没有收尾标点时 TTS 的语调会"悬着"，听起来就是断在半句上
    if (clean && !/[。！？!?…]$/.test(clean)) clean += "。";
    if (!clean || clean.length < 2) return;
    const item: QueueItem = {
      text: clean,
      bytes: null,
      audio: null,
      blobUrl: null,
      ready: false,
      decoded: null,
      gen: this.generation,
      pause,
    };
    this.queue.push(item);
    this.preload(item);
    this.pump();
  }

  /** 懒创建 Web Audio 上下文；返回 false 表示只能走 HTMLAudioElement 兜底 */
  private ensureContext(): boolean {
    if (this.ctx) return true;
    if (this.ctxBroken) return false;
    try {
      const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
      const Ctor = w.AudioContext ?? w.webkitAudioContext;
      if (!Ctor) { this.ctxBroken = true; return false; }
      const ctx = new Ctor();
      const gain = ctx.createGain();
      gain.gain.value = this.muted ? 0 : 1;
      gain.connect(ctx.destination);
      this.ctx = ctx;
      this.masterGain = gain;
      return true;
    } catch (e) {
      console.warn("[TTS] WebAudio unavailable, fallback:", e);
      this.ctxBroken = true;
      return false;
    }
  }

  /**
   * 拼出这次的语气参数，并按需把句子包成 `<cot text=…>` 标签。
   *
   * **语气全部由 AI 决定，用户只有一个「增强语气」开关**：
   * 用的是它这条回复的情绪标签（happy / shy / sad / angry / surprised / neutral），
   * 由情绪决定语气口令、语速音调偏移；句子够短就用逐句语音标签（更精确），
   * 太长就退回自然语言口令。用户不需要也不应该去调这些细节。
   */
  private buildTone(text: string): { text: string; tone?: TtsTonePayload } {
    const t = loadSettings().tts;
    if (!t.enhanced) return { text };
    const emo = EMOTION_TONE[this.emotionTag] ? this.emotionTag : "neutral";
    const voice = EMOTION_VOICE[emo] ?? EMOTION_VOICE.neutral;
    const base: TtsTonePayload = { model: "seed-tts-2.0-expressive" };
    if (voice.rate) base.speechRate = voice.rate;
    if (voice.pitch) base.pitch = voice.pitch;
    // 同一段回复共用一个 section_id：几句之间语气接得上，不用用户操心
    if (!this.sectionId) {
      this.sectionId = `petra-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }
    base.sectionId = this.sectionId;

    // 句子够短就逐句打标签（更贴合这一句的情绪），否则用整段口令
    const wrapped = wrapCotTag(text, emo, COT_MAX_CHARS);
    if (wrapped) return { text: wrapped, tone: { ...base, useTagParser: true } };
    return { text, tone: { ...base, contextText: emotionToneInstruction(emo) } };
  }

  private async preload(item: QueueItem) {
    const gen = item.gen;
    try {
      const { text: speakText, tone } = this.buildTone(item.text);
      // 排障用：把真正送进合成的文本打出来（下次"念出奇怪东西"能直接看到原文）
      if (typeof location !== "undefined" && (location.hostname === "127.0.0.1" || location.hostname === "localhost")) {
        console.debug("[TTS] 送合成：", speakText, tone ?? "(无语气参数)");
      }
      const base64 = await invoke<string>("tts_synthesize", {
        apiKey: this.apiKey,
        speaker: this.speakerId,
        text: speakText,
        language: this.language || undefined,
        tone,
      });
      // 这期间用户已经发了新消息/关了语音：这段音频已经没人要了，别往新一轮的队列里塞
      if (gen !== this.generation) return;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      item.bytes = bytes;
      const blob = new Blob([bytes], { type: "audio/mp3" });
      item.blobUrl = URL.createObjectURL(blob);

      if (!this.decodeBroken && this.ensureContext() && this.ctx) {
        try {
          // decodeAudioData 会接管传入的 ArrayBuffer，复制一份避免影响兜底用的 bytes
          const copy = bytes.slice().buffer;
          const buffer = await this.ctx.decodeAudioData(copy);
          if (gen !== this.generation) return;
          const channels: Float32Array[] = [];
          for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
          const bounds = findSpeechBounds(channels, buffer.sampleRate);
          item.decoded = { buffer, offset: bounds.offset, duration: bounds.duration };
        } catch (e) {
          if (gen !== this.generation) return;
          // 不懂这个格式/解码失败：这个端点后续都走兜底，别再每句都白试一次
          console.warn("[TTS] decode failed, fallback:", e);
          this.decodeBroken = true;
        }
      }
      if (!item.decoded) item.audio = new Audio(item.blobUrl);
      item.ready = true;
      // 即使当前已经在播，也要再 pump 一次：Web Audio 路径要把后面这句**提前排进时间轴**，
      // 等前一句播完才排的话，两段之间会多出一次 onended→start 的空隙（又变回一顿一顿）。
      this.pump();
    } catch (e) {
      if (gen !== this.generation) return;
      console.warn("[TTS] failed:", e);
      // 失败也要标记 ready 并推进队列：以前只置 ready 不 pump()，若失败的是**队首**
      // 那一句（长句最容易超时），整条队列会停在"ready 但 audio=null"的队首不动，
      // 后面已经合成好的句子永远不播，整段回复静音。
      item.ready = true;
      this.pump();
    }
  }

  private pump() {
    if (!this.enabled) return;
    if (this.ensureContext() && !this.decodeBroken) this.pumpWebAudio();
    else this.pumpLegacy();
  }

  /**
   * Web Audio 路径：把已经解码好的段按文字顺序排进时间轴。
   * 关键是**提前排队**——上一段还在播的时候就把下一段 `start()` 定好时间，
   * 不再等 `onended` 再起播，接缝处自然没有空隙。
   */
  private pumpWebAudio() {
    const ctx = this.ctx;
    const master = this.masterGain;
    if (!ctx || !master) { this.pumpLegacy(); return; }
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});

    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (!next.ready) break;
      this.queue.shift();
      if (!next.decoded) {
        // 解码失败且后面还有已排队的段：等它们播完，onended 会再回来走兜底
        if (this.scheduled.size > 0) { this.queue.unshift(next); return; }
        // 混用两条播放链路会叠音：先让兜底元素播完，它的 onended 会再回来排后面的
        this.playLegacyItem(next);
        return;
      }

      const src = ctx.createBufferSource();
      src.buffer = next.decoded.buffer;
      const gen = next.gen;
      const fadeIn = 0.006;
      const fadeOut = 0.012;
      const dur = next.decoded.duration;
      const local = ctx.createGain();
      const start = Math.max(ctx.currentTime + SCHEDULE_LEAD, this.nextStartAt);
      const end = start + dur;
      local.gain.setValueAtTime(0, start);
      local.gain.linearRampToValueAtTime(1, start + Math.min(fadeIn, dur / 4));
      local.gain.setValueAtTime(1, Math.max(start + fadeIn, end - fadeOut));
      local.gain.linearRampToValueAtTime(0, end);
      src.connect(local);
      local.connect(master);
      src.start(start, next.decoded.offset, dur);
      this.nextStartAt = end + next.pause;
      this.speaking = true;
      this.setWakePaused(true);
      this.scheduled.add(src);
      const done = () => {
        this.scheduled.delete(src);
        try { local.disconnect(); } catch { /* 忽略 */ }
        // stop() 之后旧 source 的 onended 迟到：不能让它触发新一轮的 idle/气泡淡出
        if (gen !== this.generation) return;
        if (this.scheduled.size > 0) return;
        this.speaking = false;
        this.nextStartAt = 0;
        if (this.queue.length > 0) this.pump();
        else this.fireIdle();
      };
      src.onended = done;
    }

    // 队列空、也没有任何已排队的音频：说明这次真的没东西可播
    if (this.queue.length === 0 && this.scheduled.size === 0 && !this.speaking) this.fireIdle();
  }

  /** 兜底路径：原来的 HTMLAudioElement 队列（Web Audio 不可用/解码失败时） */
  private pumpLegacy() {
    if (this.speaking) return;

    // 队列空了 → 通知"这一段说完了"（气泡的消失时机挂在这里）
    if (this.queue.length === 0) { this.fireIdle(); return; }

    // **只认队首**：合成是并发预取的（谁先返回不一定，第一句慢、第二句快很常见），
    // 但"播"必须按文字顺序；队首没好就等它，preload 完成时会再调 pump。
    const next = this.queue[0];
    if (!next.ready) return;

    this.queue.shift();
    this.playLegacyItem(next);
  }

  private playLegacyItem(next: QueueItem) {
    const audio = next.audio;
    // 合成失败/解码失败且没有兜底元素的那句：跳过，接着按顺序往下播
    if (!audio) { this.pump(); return; }

    this.setWakePaused(true);
    this.speaking = true;
    this.current = audio;
    audio.volume = this.muted ? 0 : 1;
    const gen = next.gen;
    // 收尾时清掉引用：只有"还是当前这段"时才清，避免把下一段的引用误清掉
    const done = () => {
      if (gen !== this.generation) return;
      if (this.current === audio) this.current = null;
      this.speaking = false;
      this.pump();
    };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
  }

  /** 队列空了才通知：气泡淡出、唤醒恢复都挂在这里 */
  private fireIdle() {
    if (this.queue.length > 0 || this.scheduled.size > 0) return;
    this.setWakePaused(false);
    if (this.idleCallbacks.length > 0) {
      const cbs = this.idleCallbacks;
      this.idleCallbacks = [];
      cbs.forEach((cb) => cb());
    }
  }
}

export const ttsPlayer = new TTSPlayer();
(window as any).ttsPlayer = ttsPlayer;
