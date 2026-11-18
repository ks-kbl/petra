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
 *   3. 停顿按「这一段为什么被切开」给：句末 ~0.3s、换行 ~0.35s、省略号 ~0.5s、
 *      逗号兜底切 ~0.08s（2026-11 调大过：70ms 听起来等于没停顿）；
 *   4. 每段进出各做几毫秒淡入淡出，接缝处没有咔哒声。
 * 浏览器不支持 Web Audio 或解码失败时，自动退回原来的 HTMLAudioElement 队列
 * （Node 单测也走这条兜底路径，逻辑和旧版一致）。
 */

import { invoke } from "@tauri-apps/api/core";
import { loadSettings } from "../utils/settings";
import { holdWake, releaseWake } from "../audio/wakeGate";
import { takeSpeechSegment, flushSpeechSegment, speechLimits, type SpeechBoundary } from "./sentenceSplit";
import { stretchFillerInChannels, fillerStretchFor, isBareFiller } from "./prosody";

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
  /**
   * 送合成时一起带上的前文（入队那一刻的快照）。
   *
   * 必须在入队时抓，不能等 preload 异步跑到一半再读 this.recentTexts —— 那会儿
   * 后面几段可能已经入队了，模型看到的"上一句"会是它自己。
   */
  context: string[];
}

/** 句末标点：只有这些结尾才值得留一个自然停顿 */
const SENTENCE_END_RE = /[。！？!?…]$/;
/** 省略号：欲言又止，比句号停得更久 */
const ELLIPSIS_RE = /(…|…{2,}|\.{2,})$/;
/**
 * 断句后的停顿（秒）。
 *
 * 两轮调整的历史，别再来回踩：
 * ① 旧 `new Audio()` 队列时代句末只留 70ms，但每段本身带着几百毫秒静音 padding，
 *    听起来"一顿一顿"，于是调到 300ms/350ms/500ms；
 * ② 2026-11 改成**整段合成**（speechLimits：首段 8~48 字、之后 26~140 字）之后，
 *    切成几段的次数大幅减少，段内的换气由模型自己给：此时 300ms 反而变成新的机械感，
 *    所以整体收窄到 句末 220ms / 换行 260ms / 段落 450ms / 省略号 400ms / 逗号 50ms。
 * 判据只有一条：段与段之间听起来像"一口气说完中间换了个气"，而不是"停顿了"。
 */
const PAUSE_SENTENCE = 0.22;
const PAUSE_ELLIPSIS = 0.4;
const PAUSE_NEWLINE = 0.26;
const PAUSE_PARAGRAPH = 0.45;
const PAUSE_SOFT = 0.05;
const PAUSE_HARD = 0.12;
/** 调度时留一点提前量，避免 `currentTime` 已经越过开始时间 */
const SCHEDULE_LEAD = 0.035;
/**
 * 裁剪静音时首尾各保留的余量（秒）。
 *
 * 2026-11 加大过：原来头 15ms / 尾 25ms 太狠，把模型的起音换气和句尾余韵一起削掉了，
 * 每段听起来都从「干净的原点」开始——这也是朗读感的来源之一。现在留够气口。
 */
const TRIM_HEAD_PAD = 0.025;
const TRIM_TAIL_PAD = 0.06;

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
  // 阈值放低（0.015 → 0.008）：换气/气声的能量常常只有峰值的 1%，按 1.5% 判会整段裁掉
  const threshold = Math.max(0.002, Math.min(0.01, peak * 0.008));
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
  if (ELLIPSIS_RE.test(t)) return PAUSE_ELLIPSIS;
  if (SENTENCE_END_RE.test(t)) return PAUSE_SENTENCE;
  if (/[，,、；;：:]$/.test(t)) return PAUSE_SOFT;
  return PAUSE_HARD;
}

/**
 * 按「被切开的理由」给停顿。
 *
 * 用切分时记录的原因、而不是回头猜文本结尾：换行切出来的段结尾根本没有标点
 * （`slice(0, i).trim()` 会把换行剥掉），只看文本永远是"兜底长度"——这就是
 * "换行不会停顿"的直接原因。
 */
export function pauseForBoundary(boundary: string): number {
  switch (boundary) {
    case "sentence": return PAUSE_SENTENCE;
    case "ellipsis": return PAUSE_ELLIPSIS;
    case "newline": return PAUSE_NEWLINE;
    case "paragraph": return PAUSE_PARAGRAPH;
    case "soft": return PAUSE_SOFT;
    default: return PAUSE_HARD;
  }
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

/**
 * 清理要送去合成的文本（纯函数，可单测）。
 *
 * 括号旁白、Markdown 符号、代码块、URL 这些念出来都是噪音；换行在"整段合成"里
 * 会变成逗号（段落内部的一次换气），但不能因此拼出「。，」这种双标点。
 */
export function sanitizeSpeechText(text: string): string {
  return text
    // 代码块整段不读：念出来全是符号和变量名，气泡里看着是代码，耳朵里是乱码。
    // **必须排在剥 Markdown 符号之前**：` 会先被当符号删掉，围栏就再也匹配不上了
    // （这就是"代码被逐字念出来"的根因）。占位词不用括号，否则下面那步会把它删掉。
    .replace(/```[\s\S]*?```/g, "这段是代码")
    .replace(/`([^`]+)`/g, "$1")
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
    // 链接只读文字，不念 URL
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "（链接）")
    // 表格竖线/分隔行不读
    .replace(/^\s*\|?[\s:|-]{4,}\|?\s*$/gm, "")
    .replace(/\|/g, " ")
    // 段内残留的换行换成逗号：合成引擎按标点换气，直接压成空格就没有停顿了
    // （短行会被"攒够长度再送"合并成一段，合并后行与行之间的换行就落在这里）
    .replace(/\s*[\r\n]+\s*/g, "，")
    // 换行紧跟在上一个标点后面时会拼出「。，」「？，」这种双标点：
    // 合成引擎会当成两个停顿，读出来是一声多余的空拍，所以把它抹平。
    .replace(/([。！？…，、；：,;:])\s*[，,]\s*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 拼 context_texts（纯函数，可单测）。
 *
 * 官方把这个字段当「对话上下文」用：给前一段原文，模型才能接住上一句的语速、
 * 音高和情绪，不至于每段都从零起调——这正是"像朗读"的另一半原因。
 * 前文**取尾部**而不是开头：真正决定接续的是紧挨着的那几句。
 */
export function composeContextTexts(previous: string, instruction: string, maxPrev = 80): string[] {
  const out: string[] = [];
  const prev = (previous || "").replace(/\s+/g, " ").trim();
  if (prev) out.push(prev.length > maxPrev ? prev.slice(-maxPrev) : prev);
  const ins = (instruction || "").trim();
  if (ins) out.push(ins);
  return out.slice(0, 4);
}

/** 情绪 → 中文语气口令（导出给单测与调试用） */
export function emotionToneInstruction(emotion: string): string {
  return EMOTION_TONE[emotion] ?? EMOTION_TONE.neutral;
}

/** 火山一次请求里的语气参数（与 Rust 侧 TtsTone 同构，camelCase） */
interface TtsTonePayload {
  model?: string;
  /** 兼容旧字段：单条语气口令 */
  contextText?: string;
  /**
   * 对话上下文（官方 context_texts）：按顺序塞「上一段原文 + 语气口令」。
   * 上一段原文让模型接得住前一句的语速和情绪，不用每段重新起调。
   */
  contextTexts?: string[];
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
  /**
   * 情绪决定的语音参数（语速/音调偏移 + 音量倍率）。
   * 由 lifeRuntime 按当前心情算出来推进来；和"这句回复的情绪标签"是两回事：
   * 前者是"她今天的状态"，后者是"这句话的语气"。
   */
  private moodTone = { rate: 0, pitch: 0, volume: 1 };
  /**
   * 语气处理（拖音/短叹词/低通）总开关。
   *
   * 只给"对照试听"用：用户听到电音时，可以一键关掉它再听一遍，
   * 立刻判断电音是处理带来的还是端点给的音频本身就脏。正式流程永远开着。
   */
  private prosodyEnabled = true;
  /** 多轮上下文 id：同一段回复共用，让几句之间的语气连贯 */
  private sectionId = "";
  /** 这条回复已经送出去几段：决定下一段攒多长（见 speechLimits） */
  private spokenSegments = 0;
  /** 最近送合成的原文（最多两条）：作为 context_texts 喂给下一段，保住跨句语调 */
  private recentTexts: string[] = [];
  /** 被单独切出来、但还没找到"下一句"可拼的语气词（如「嗯……」） */
  private pendingPrefix = "";
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
      // 走统一的闸门：录音识别也在用同一个闸门，谁都不该把对方的暂停顶掉
      if (paused) {
        if (this.wakeResumeTimer) { window.clearTimeout(this.wakeResumeTimer); this.wakeResumeTimer = null; }
        holdWake("tts");
      } else {
        if (this.wakeResumeTimer) window.clearTimeout(this.wakeResumeTimer);
        this.wakeResumeTimer = window.setTimeout(() => {
          this.wakeResumeTimer = null;
          releaseWake("tts", 0);
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
    if (this.masterGain) this.masterGain.gain.value = muted ? 0 : this.moodTone.volume;
    if (this.current) this.current.volume = muted ? 0 : this.moodTone.volume;
  }

  /**
   * 设置当前回复的情绪（happy / shy / sad / angry / surprised / neutral）。
   * 只影响**之后**合成的句子：情绪标签通常出现在回复开头，所以整段基本都能带上。
   */
  /** 情绪状态 → 语音参数（生气快而压、低落慢而轻）；音量立刻作用在正在播的声音上 */
  setMoodTone(t: { rate: number; pitch: number; volume: number }) {
    this.moodTone = {
      rate: Math.max(-8, Math.min(8, t.rate || 0)),
      pitch: Math.max(-3, Math.min(3, t.pitch || 0)),
      volume: Math.max(0.5, Math.min(1, t.volume ?? 1)),
    };
    if (this.masterGain) this.masterGain.gain.value = this.muted ? 0 : this.moodTone.volume;
    if (this.current) this.current.volume = this.muted ? 0 : this.moodTone.volume;
  }

  /** 对照试听用：临时关掉/打开语气处理 */
  setProsodyEnabled(on: boolean) {
    this.prosodyEnabled = on;
    this.prosodyLog(`prosody ${on ? "on" : "off"}`);
  }

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
    // 攒够一段再送。门槛是**前紧后松**的：
    //   第一段小（8~48 字，先出声再说），之后每段 26~140 字（把两三句合成一次）。
    // 为什么必须变长：每句单独合成 = 每句重新起调、句间没有连读，这正是"像朗读"的根因。
    // 单换行也不再断句（softNewline），只有空行（段落）才真的切。
    let seg: { segment: string; rest: string; boundary: SpeechBoundary } | null = null;
    while ((seg = takeSpeechSegment(this.buffer, speechLimits(this.spokenSegments)))) {
      this.buffer = seg.rest;
      // 单独一声「嗯……」先收着，等后面那句一起送：两次独立起调会变成两声"嗯"。
      // 注意是"收着继续等"，不是"原地不动"——原地不动会让整条回复等到流结束才开口。
      if (isBareFiller(seg.segment) && seg.rest.trim()) {
        this.pendingPrefix += seg.segment;
        break;
      }
      const text = this.pendingPrefix ? this.pendingPrefix + seg.segment : seg.segment;
      this.pendingPrefix = "";
      this.enqueue(text, seg.boundary);
    }
  }

  flush() {
    if (!this.enabled) return;
    if (!this.stopped) {
      const rest = flushSpeechSegment(this.buffer);
      const tail = this.pendingPrefix ? this.pendingPrefix + rest : rest;
      if (tail) this.enqueue(tail);
    }
    this.pendingPrefix = "";
    this.buffer = "";
    this.stopped = false;
  }

  stop() {
    this.generation++;
    // 新一段回复 = 新的语气上下文，section_id 重新生成
    this.sectionId = "";
    this.emotionTag = "neutral";
    this.spokenSegments = 0;
    this.recentTexts = [];
    this.pendingPrefix = "";
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

  private enqueue(text: string, boundary?: SpeechBoundary) {
    const original = text.trim();
    // 有切分理由就按理由给停顿，没有（收尾的最后一小段）才回头按标点猜
    let pause = boundary ? pauseForBoundary(boundary) : pauseAfterSegment(original);
    let clean = sanitizeSpeechText(text);
    // 补一个句末标点：没有收尾标点时 TTS 的语调会"悬着"，听起来就是断在半句上
    if (clean && !/[。！？!?…]$/.test(clean)) clean += "。";
    if (!clean || clean.length < 2) return;
    // 「嗯……」被单独拆成一段时，拖音本身已经把时间占住了，再按省略号给 0.4 秒停顿
    // 就成了"嗯——……"，所以这里把停顿收掉，只留一点点换气。
    if (clean.length <= 6 && fillerStretchFor(clean)?.kind === "think") {
      pause = Math.min(pause, 0.12);
    }
    const item: QueueItem = {
      text: clean,
      bytes: null,
      audio: null,
      blobUrl: null,
      ready: false,
      decoded: null,
      gen: this.generation,
      pause,
      // 前两段的原文作为语气上下文（不含自己）
      context: this.recentTexts.slice(-2),
    };
    this.spokenSegments++;
    this.recentTexts.push(clean);
    if (this.recentTexts.length > 4) this.recentTexts.shift();
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
      gain.gain.value = this.muted ? 0 : this.moodTone.volume;
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
  private buildTone(text: string, context: string[] = []): { text: string; tone?: TtsTonePayload } {
    const t = loadSettings().tts;
    const emo = EMOTION_TONE[this.emotionTag] ? this.emotionTag : "neutral";
    const voice = EMOTION_VOICE[emo] ?? EMOTION_VOICE.neutral;
    // 语速/音调这两项**和"增强语气"开关无关**：它们是 audio_params 里的标准字段，
    // 标准模型也吃。以前整段被 enhanced 开关挡住，于是"没开增强语气"的人永远听不出
    // 情绪变化——这正是"切语气听不出来"的直接原因。
    const rate = Math.max(-10, Math.min(10, voice.rate + this.moodTone.rate));
    const pitch = Math.max(-4, Math.min(4, voice.pitch + this.moodTone.pitch));
    if (!t.enhanced) {
      // 不开增强语气：只给语速/音调，不碰表现力模型、context_texts、语音标签
      if (!rate && !pitch) return { text };
      const plain: TtsTonePayload = {};
      if (rate) plain.speechRate = rate;
      if (pitch) plain.pitch = pitch;
      return { text, tone: plain };
    }
    const base: TtsTonePayload = { model: "seed-tts-2.0-expressive" };
    if (rate) base.speechRate = rate;
    if (pitch) base.pitch = pitch;
    // 同一段回复共用一个 section_id：几句之间语气接得上，不用用户操心
    if (!this.sectionId) {
      this.sectionId = `petra-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }
    base.sectionId = this.sectionId;

    // 语气上下文按官方 context_texts 的用法给：先放前一段原文（让模型接住上文语速与情绪），
    // 再放这一段的语气口令。最多三条，太长反而稀释指令。
    base.contextTexts = composeContextTexts(context.join(""), emotionToneInstruction(emo));

    // 句子够短就逐句打标签（更贴合这一句的情绪），否则用整段口令
    const wrapped = wrapCotTag(text, emo, COT_MAX_CHARS);
    if (wrapped) return { text: wrapped, tone: { ...base, useTagParser: true } };
    return { text, tone: base };
  }

  private async preload(item: QueueItem) {
    const gen = item.gen;
    try {
      const { text: speakText, tone } = this.buildTone(item.text, item.context);
      this.prosodyLog(`tone=${tone ? `rate:${tone.speechRate ?? 0},pitch:${tone.pitch ?? 0}` : "none"} text=${String(speakText).slice(0, 10)}`);
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
          // 段首是「嗯……/哦，」这种语气词时，把那一小段音频拉长（不改音高）
          this.applyFillerStretch(item);
        } catch (e) {
          if (gen !== this.generation) return;
          // 不懂这个格式/解码失败：这个端点后续都走兜底，别再每句都白试一次
          console.warn("[TTS] decode failed, fallback:", e);
          this.decodeBroken = true;
        }
      }
      if (!item.decoded) {
        // 走到这里说明这条走 HTMLAudioElement 兜底：那条路没有解码后的样本，
        // 也就没有任何语气处理（拖音/哼都听不到）——"改了没感觉"的常见原因。
        this.prosodyLog(`fallback(legacy) text=${item.text.slice(0, 12)}`);
        item.audio = new Audio(item.blobUrl);
      }
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

  /**
   * 语气处理的诊断日志。
   *
   * 默认只在 localhost（dev）打，正式包里不吵；排查"改了没感觉"时打开控制台
   * 就能看到每一段到底走了哪条路：解码成功没有、有没有命中语气词、拉长了多少。
   */
  private prosodyLog(msg: string) {
    try {
      if (typeof location !== "undefined" && (location.hostname === "127.0.0.1" || location.hostname === "localhost")) {
        console.debug("[TTS][prosody]", msg);
      }
      // 桌宠窗口是透明无边框的小窗，devtools 没有快捷键可开，所以同时写进 pet.log：
      // 用户只要打开 <仓库>/logs/pet.log 搜 [prosody] 就能看到每段到底走了哪条路。
      // 该命令只在 debug 构建存在，发布版会直接 reject，忽略即可。
      void invoke("debug_log_warn", { msg: `[prosody] ${msg}` }).catch(() => {});
    } catch { /* 忽略 */ }
  }

  /**
   * 手动试音（dev 用）：`ttsPlayer.speakTest("嗯……我想想。")`。
   *
   * 不经过模型，直接把这句话走完整条链路（合成 → 解码 → 语气处理 → 播放），
   * 用来把"模型没说语气词"和"处理没生效"这两种情况区分开。
   */
  speakTest(text: string) {
    this.stop();
    this.pushDelta(text);
    this.flush();
  }

  /**
   * 语气词拖音：只在段首命中，且只动那一小段音频。
   *
   * 定位靠能量 VAD 而不是强制对齐：语气词永远在段首、后面必然跟一个停顿，
   * 用「第一段连续发声」就能框住，成本低、不会错到别的字上去。
   * 框出来的区间过长（>0.7s）说明这一句开头压根没有语气词停顿，宁可不拉。
   */
  private applyFillerStretch(item: QueueItem) {
    const d = item.decoded;
    const ctx = this.ctx;
    const head = item.text.slice(0, 12);
    if (!this.prosodyEnabled) { this.prosodyLog(`skip(disabled) text=${head}`); return; }
    if (!d || !ctx) { this.prosodyLog(`skip(no-audio) text=${head}`); return; }
    const sr = d.buffer.sampleRate;
    const chans: Float32Array[] = [];
    for (let c = 0; c < d.buffer.numberOfChannels; c++) chans.push(d.buffer.getChannelData(c));
    if (!chans.length) { this.prosodyLog(`skip(no-channel) text=${head}`); return; }
    try {
      const before = chans[0].length / sr;
      const res = stretchFillerInChannels(chans, sr, item.text, Math.round(d.offset * sr));
      if (!res.stretched) {
        this.prosodyLog(`skip(no-match) text=${head}`);
        return;
      }
      const after = res.channels[0].length / sr;
      this.prosodyLog(`applied mode=${res.mode} factor=${res.factor} ${before.toFixed(2)}s→${after.toFixed(2)}s text=${head}`);
      const buf = ctx.createBuffer(res.channels.length, res.channels[0].length, sr);
      res.channels.forEach((ch, i) => buf.getChannelData(i).set(ch));
      item.decoded = { buffer: buf, offset: 0, duration: buf.length / sr };
    } catch (e) {
      // 拉伸失败就当没这回事：正常念出来也比整句没声音强
      console.warn("[TTS] prosody stretch failed:", e);
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
      const fadeIn = 0.005;
      const fadeOut = 0.008;
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
    audio.volume = this.muted ? 0 : this.moodTone.volume;
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
