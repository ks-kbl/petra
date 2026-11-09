/**
 * TTS 播放队列 - 调用豆包声音复刻 API
 * 断句 → 预加载 → 顺序播放
 */

import { invoke } from "@tauri-apps/api/core";
import { takeSpeechSegment, flushSpeechSegment } from "./sentenceSplit";

class TTSPlayer {
  private enabled = false;
  private apiKey = "";
  private speakerId = "";
  private language = "";
  private queue: { text: string; audio: HTMLAudioElement | null; ready: boolean; blobUrl: string | null }[] = [];
  private speaking = false;
  private buffer = "";
  private stopped = false;
  private skipSource = false;
  private idleCallbacks: (() => void)[] = [];
  /** 唤醒词监听在 TTS 播放期间要暂停，避免把自己说的话当成唤醒词 */
  private wakeResumeTimer: number | null = null;
  muted = false;
  /**
   * 正在播的那一段。
   *
   * 必须自己留引用：`new Audio()` 出来的元素**不在 DOM 里**（没 append 到任何节点），
   * 所以 `document.querySelectorAll("audio")` 根本找不到它 —— 以前静音按钮就是靠查
   * DOM 去改 volume 的，结果按下去对正在播的那一段毫无作用，只能等下一句。
   */
  private current: HTMLAudioElement | null = null;

  onIdle(cb: () => void) { this.idleCallbacks.push(cb); }

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
  isSpeaking(): boolean { return this.speaking; }

  /**
   * 实时静音开关：立刻作用于**正在播的这一段**，不用等下一句。
   *
   * 用 volume=0 而不是 pause()：静音期间队列要继续走完（气泡的消失时机、
   * onIdle 回调都挂在"播完"上），暂停会让整条链卡住。
   */
  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.current) this.current.volume = muted ? 0 : 1;
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
    this.skipSource = false;
  }

  stop() {
    this.queue = [];
    this.buffer = "";
    this.speaking = false;
    this.stopped = false;
    // 同样因为音频元素不在 DOM 里，以前这里 querySelector("audio.tts-current")
    // 永远查不到东西 → 关掉语音输出时当前这句其实还在响。改成停自己持有的引用。
    this.current?.pause();
    this.current = null;
  }

  private enqueue(text: string) {
    let clean = text
      .replace(/[（(][^）)]*[）)]/g, "")
      .replace(/[*_`#~|]/g, "")
      .replace(/\n---\n[\s\S]*$/, "")
      .replace(/\s+/g, " ")
      .trim();
    // 补一个句末标点：没有收尾标点时 TTS 的语调会"悬着"，听起来就是断在半句上
    if (clean && !/[。！？!?…]$/.test(clean)) clean += "。";
    if (!clean || clean.length < 2) return;
    const item = { text: clean, audio: null as HTMLAudioElement | null, ready: false, blobUrl: null as string | null };
    this.queue.push(item);
    this.preload(item);
    this.pump();
  }

  private async preload(item: { text: string; audio: HTMLAudioElement | null; ready: boolean; blobUrl: string | null }) {
    try {
      const base64 = await invoke<string>("tts_synthesize", {
        apiKey: this.apiKey,
        speaker: this.speakerId,
        text: item.text,
        language: this.language || undefined,
      });
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: "audio/mp3" });
      item.blobUrl = URL.createObjectURL(blob);
      item.audio = new Audio(item.blobUrl);
      item.ready = true;
      if (!this.speaking) this.pump();
    } catch (e) {
      console.warn("[TTS] failed:", e);
      // 失败也要标记 ready 并推进队列：以前只置 ready 不 pump()，若失败的是**队首**
      // 那一句（长句最容易超时），整条队列会停在"ready 但 audio=null"的队首不动，
      // 后面已经合成好的句子永远不播，整段回复静音。
      item.ready = true;
      this.pump();
    }
  }

  private pump() {
    if (this.speaking || !this.enabled) return;

    // 队列空了 → 通知"这一段说完了"（气泡的消失时机挂在这里）
    if (this.queue.length === 0) {
      this.setWakePaused(false);
      if (this.idleCallbacks.length > 0) {
        const cbs = this.idleCallbacks;
        this.idleCallbacks = [];
        cbs.forEach(cb => cb());
      }
      return;
    }

    // **只认队首**：合成是并发预取的（谁先返回不一定，第一句慢、第二句快很常见），
    // 但"播"必须按文字顺序。以前这里取的是"第一个已经合成好的"（findIndex(i => i.ready)），
    // 于是第二句先合成完就先播 —— 听起来就是"先说下面的，再说上面的"。
    // 队首还没好就等着：它 preload 完成时会再调一次 pump。
    const next = this.queue[0];
    if (!next.ready) return;

    this.queue.shift();
    const audio = next.audio;
    // 合成失败的那句（catch 里也标了 ready）：跳过它，接着按顺序往下播
    if (!audio) { this.pump(); return; }

    this.setWakePaused(true);
    this.speaking = true;
    this.current = audio;
    audio.volume = this.muted ? 0 : 1;
    // 收尾时清掉引用：只有"还是当前这段"时才清，避免把下一段的引用误清掉
    const done = () => {
      if (this.current === audio) this.current = null;
      this.speaking = false;
      this.pump();
    };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
  }
}

export const ttsPlayer = new TTSPlayer();
(window as any).ttsPlayer = ttsPlayer;
