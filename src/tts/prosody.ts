/**
 * 语气词的「拖音」处理（纯函数，可单测）。
 *
 * 为什么需要单独一层：拖音是**音素时长**问题，不是标点能解决的。
 * `嗯……` 在 TTS 里读成「嗯 + 停顿」，`嗯嗯` 是两个音节，`嗯！` 只是语调变重——
 * 想要「嗯——」那种把鼻音拉长的效果，只能在合成出来的**音频上做时域拉伸**。
 *
 * 分工：
 * - 模型侧（③）：用**标点**表达拖多长（`……` = 思考中的长拖音、`，` = 轻轻带过），
 *   不引入私有语法，气泡里看到的也是正常中文；
 * - 播放侧（②）：把段首语气词那段音频按标量拉伸，配一点音高下沉和尾部衰减。
 */

/** 会被拖长的语气词（都念单个音节，鼻音/元音为主，拉伸伪影最小） */
const FILLERS = ["嗯", "哦", "啊", "唉", "诶", "哎", "唔", "噢", "呀"];

const INTERJECTION_BOUNDARY = /^[，,、。.!！?？…—－；;：:\n\r]/;
const hasFollowingSpeech = (text: string) => /[^\s，,、。.!！?？…—－；;：:]/.test(text.trimStart().slice(1));

export interface FillerStretch {
  /** 命中的语气词 */
  token: string;
  /** 时长倍数（1 = 不处理） */
  factor: number;
  /** 为什么给这个倍数：思考中的犹豫 vs 随口应一声 */
  kind: "think" | "soft" | "none";
}

/**
 * 判断一段文本**开头**的语气词要不要拖、拖多长。
 *
 * 只看开头：句中语气词要定位到具体音频位置，成本高、错位风险大，
 * 而人在说话时拖音本来就集中在句首那一声「嗯——」。
 */
export function fillerStretchFor(text: string): FillerStretch | null {
  const t = (text || "").trimStart();
  if (!t) return null;
  const token = FILLERS.find((f) => t.startsWith(f));
  if (!token) return null;
  const rest = t.slice(token.length);
  // 「嗯嗯」「哦哦」是两个音节，本来就够长了，再拉就成了橡皮筋
  if (rest.startsWith(token)) return null;

  // 思考/犹豫：省略号或破折号 → 拉得最狠
  if (/^(…|\.{2,}|—{1,2}|－)/.test(rest)) return { token, factor: 1.5, kind: "think" };
  // 随口应一声：逗号 → 轻轻拖一点
  if (/^[，,]/.test(rest)) return { token, factor: 1.18, kind: "soft" };
  // 句号/问号/感叹号/直接结束：正常念，不拉
  return { token, factor: 1, kind: "none" };
}

/**
 * 找出从 `fromSample` 开始的第一段连续发声区间（用于定位那一声「嗯」）。
 *
 * 10ms 一帧算能量，判定阈值按整段峰值自适应；中间允许 60ms 以内的低谷
 * （鼻音收尾会有一小段能量很低，但不该被当成分界）。
 */
export function findFirstVoicedRun(
  channels: Float32Array[],
  sampleRate: number,
  fromSample = 0,
  maxSamples?: number,
  requirePause = false,
): { start: number; end: number } | null {
  const total = channels[0]?.length ?? 0;
  if (!total || !sampleRate) return null;
  const from = Math.max(0, Math.min(total, Math.floor(fromSample)));
  const limit = Math.min(total, from + (maxSamples ?? Math.round(sampleRate * 1.2)));
  const frame = Math.max(1, Math.round(sampleRate * 0.01));
  let peak = 0;
  for (const ch of channels) {
    for (let i = from; i < limit; i++) {
      const v = Math.abs(ch[i]);
      if (v > peak) peak = v;
    }
  }
  if (peak <= 0) return null;
  const threshold = Math.max(0.004, peak * 0.06);
  const rmsAt = (s: number) => {
    let sum = 0;
    const end = Math.min(limit, s + frame);
    if (end <= s) return 0;
    for (const ch of channels) {
      for (let i = s; i < end; i++) sum += ch[i] * ch[i];
    }
    return Math.sqrt(sum / ((end - s) * channels.length));
  };
  let start = -1;
  for (let s = from; s + frame <= limit; s += frame) {
    if (rmsAt(s) >= threshold) { start = s; break; }
  }
  if (start < 0) return null;
  // 往后走，遇到连续 60ms 的安静才算这一段结束
  const gapFrames = 6;
  let quiet = 0;
  let end = start;
  for (let s = start; s + frame <= limit; s += frame) {
    if (rmsAt(s) >= threshold) { quiet = 0; end = s + frame; }
    else if (++quiet >= gapFrames) break;
  }
  // 有后文但在扫描窗口内没找到清楚的停顿：可能是连读，不能把后续文字卷进去。
  if (requirePause && quiet < gapFrames) return null;
  return { start, end: Math.min(limit, end + frame) };
}

/**
 * WSOLA 时域拉伸（改变时长、不改音高）。
 *
 * 为什么不直接重采样：重采样会连音高一起改，听起来是"变调"，不是"拖长"。
 * WSOLA 用「在附近找最相似的片段再重叠相加」的方式拼接，保住原始基频——
 * 对「嗯」这种准周期的鼻音几乎听不出处理痕迹，这也是选它做拖音的原因。
 *
 * @param start,end 采样点区间（左闭右开），只处理这一段
 * @param factor 时长倍数（>1 变长）
 */
export function wsola(
  channels: Float32Array[],
  sampleRate: number,
  start: number,
  end: number,
  factor: number,
): Float32Array[] {
  const chCount = channels.length;
  const len = Math.max(0, Math.min(end, channels[0]?.length ?? 0) - start);
  // 0.5~2 都支持：压缩用来把 TTS 那声拖沓的 hēng 收短，音高由后面的弯音单独管
  const safeFactor = Math.max(0.5, Math.min(2, factor));
  if (!chCount || len <= 0 || Math.abs(safeFactor - 1) <= 0.001) {
    return channels.map((ch) => ch.slice(start, Math.max(start, end)));
  }
  const frame = Math.max(64, Math.round(sampleRate * 0.04));
  const half = Math.floor(frame / 2);
  const search = Math.max(2, Math.round(sampleRate * 0.012));
  const hopOut = half;
  const hopIn = hopOut / safeFactor;
  const outLen = Math.max(frame, Math.round(len * safeFactor));
  const result = Array.from({ length: chCount }, () => new Float32Array(outLen));
  // Hann 窗 + 归一化累加：重叠区用窗函数的平方和做除，避免忽大忽小
  const win = new Float32Array(frame);
  for (let i = 0; i < frame; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frame - 1));
  const norm = new Float32Array(outLen);

  let outPos = 0;
  let nominal = 0;
  while (outPos + frame <= outLen) {
    // 在当前名义位置附近找一个跟「上一帧尾巴」最像的位置，拼接才不破音
    let best = Math.round(nominal);
    if (outPos > 0) {
      const refStart = best - half;
      let bestScore = -Infinity;
      for (let d = -search; d <= search; d++) {
        const cand = Math.round(nominal) + d;
        if (cand < 0 || cand + frame > len) continue;
        let score = 0;
        for (let i = 0; i < half; i++) {
          const a = channels[0][start + cand + i];
          const b = channels[0][start + Math.max(0, Math.min(len - 1, refStart + i))];
          score += a * b;
        }
        if (score > bestScore) { bestScore = score; best = cand; }
      }
    }
    for (let c = 0; c < chCount; c++) {
      const src = channels[c];
      const dst = result[c];
      for (let i = 0; i < frame; i++) {
        const si = start + Math.min(len - 1, Math.max(0, best + i));
        dst[outPos + i] += src[si] * win[i];
      }
    }
    for (let i = 0; i < frame; i++) norm[outPos + i] += win[i];
    outPos += hopOut;
    nominal += hopIn;
  }
  for (let c = 0; c < chCount; c++) {
    const dst = result[c];
    for (let i = 0; i < outLen; i++) if (norm[i] > 1e-4) dst[i] /= norm[i];
  }
  return result;
}

/**
 * 把一段拉伸结果拼回原音频，并给拖音尾巴加一点"泄气"感。
 *
 * 只拉长会像卡带：真人拖音时音高会微微下沉、尾部能量会衰减，这两下才是像人的关键。
 */
export function spliceStretched(
  channels: Float32Array[],
  span: { start: number; end: number },
  stretched: Float32Array[],
  sampleRate: number,
  tailEnvelope = true,
): Float32Array[] {
  const total = channels[0].length;
  const insert = stretched[0]?.length ?? 0;
  const outLen = total - (span.end - span.start) + insert;
  const out: Float32Array[] = [];
  // 只有真·拖音（>0.3s）才需要尾巴衰减；短叹词「哼」本身已经带包络，
  // 再压一层会把它压成一声气音。
  const tail = tailEnvelope && insert > sampleRate * 0.3 ? Math.max(1, Math.round(sampleRate * 0.18)) : 0;
  for (let c = 0; c < channels.length; c++) {
    const src = channels[c];
    const dst = new Float32Array(outLen);
    dst.set(src.subarray(0, span.start), 0);
    const st = stretched[c] ?? new Float32Array(insert);
    // 尾部 180ms 做一点衰减：模拟「嗯——」收声时气息减弱
    for (let i = 0; i < insert; i++) {
      const left = insert - i;
      const gain = tail > 0 && left < tail ? 0.35 + 0.65 * (left / tail) : 1;
      dst[span.start + i] = st[i] * gain;
    }
    dst.set(src.subarray(span.end), span.start + insert);
    // 只淡化重制片段的头尾（各约 6ms），不削弱后一句原声的起音——
    // 那声咔哒叠在鼻音上，听起来就是典型的"电音"。
    const xf = Math.min(
      Math.round(sampleRate * 0.006),
      Math.floor(insert / 4),
      Math.floor((total - span.end) / 2),
    );
    if (xf > 1) {
      for (let i = 0; i < xf; i++) {
        const g = i / xf;
        dst[span.start + i] *= g;                                   // 进入拉伸段：淡入
        dst[span.start + insert - 1 - i] *= g;                       // 拉伸段收尾：淡出
      }
    }
    out.push(dst);
  }
  return out;
}

/**
 * 估基音周期（采样点数），失败返回 null。
 *
 * 归一化自相关：只取 60~500Hz 的范围，峰值不够高（清音/气声）就返回 null，
 * 播放链路保留原声，不拿猜测的周期拼接，避免电音。
 */
export function estimatePeriod(samples: Float32Array, sampleRate: number): number | null {
  const len = samples.length;
  if (len < Math.round(sampleRate * 0.03)) return null;
  const win = Math.min(len, Math.round(sampleRate * 0.04));
  const minLag = Math.max(2, Math.floor(sampleRate / 500));
  const maxLag = Math.min(win - 2, Math.ceil(sampleRate / 60));
  if (maxLag <= minLag) return null;
  let bestLag = 0;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let num = 0;
    let e1 = 0;
    let e2 = 0;
    for (let i = 0; i + lag < win; i++) {
      const a = samples[i];
      const b = samples[i + lag];
      num += a * b;
      e1 += a * a;
      e2 += b * b;
    }
    const den = Math.sqrt(e1 * e2) || 1;
    const score = num / den;
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  // 0.45 是经验阈值：鼻音「嗯」通常在 0.7 以上，清音基本 0.1~0.3
  if (bestScore < 0.45 || bestLag <= 0) return null;
  return bestLag;
}

/**
 * 按基音周期拼接来拉长（PSOLA 思路），专治鼻音「嗯」的电音。
 *
 * 为什么比 WSOLA 干净：神经元…不对，人声是准周期的。只要**整周期地重复**，
 * 波形在每个接缝处相位一致，叠出来还是同一个波形；而 WSOLA 是"找最像的位置"，
 * 对短促的鼻音经常找不到对齐点，接缝相位一跳，就出现了那种像机器人/水下的电音。
 *
 * 做法：以 2 个周期为颗粒、1 个周期为步长，输出步长固定、输入步长按倍数缩小，
 * 并把输入起点**吸附到周期网格**上（相位对齐），Hann 窗 50% 重叠相加。
 */
export function stretchVoiced(
  channels: Float32Array[],
  sampleRate: number,
  start: number,
  end: number,
  factor: number,
  period: number,
): Float32Array[] {
  const len = Math.max(1, Math.min(end, channels[0]?.length ?? 0) - start);
  // 0.5~2：压缩（<1）也要支持，短叹词"哼"就是要把它压短
  const safe = Math.max(0.5, Math.min(2, factor));
  const outLen = Math.max(period * 2, Math.round(len * safe));
  const P = Math.max(2, Math.round(period));
  // 3 个周期（原来是 2 个）：重叠区更长，相位过渡更平顺，
  // 对鼻音这种准周期信号几乎没有代价，却能明显减少"金属味"。
  const grain = P * 3;
  const win = new Float32Array(grain);
  for (let i = 0; i < grain; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (grain - 1));
  const result = channels.map(() => new Float32Array(outLen));
  const norm = new Float32Array(outLen);
  const hopOut = P;
  const hopIn = P / safe;
  let outPos = 0;
  let nominal = 0;
  while (outPos < outLen) {
    // 相位对齐：把输入起点吸附到最近的周期整数倍上
    const snapped = Math.round(Math.round(nominal) / P) * P;
    const srcBase = start + Math.max(0, Math.min(len - grain, snapped));
    const grainLen = Math.min(grain, len);
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c];
      const dst = result[c];
      for (let i = 0; i < grainLen && outPos + i < outLen; i++) {
        dst[outPos + i] += src[srcBase + i] * win[i];
      }
    }
    for (let i = 0; i < grainLen && outPos + i < outLen; i++) norm[outPos + i] += win[i];
    outPos += hopOut;
    nominal += hopIn;
  }
  for (let c = 0; c < result.length; c++) {
    const dst = result[c];
    for (let i = 0; i < outLen; i++) if (norm[i] > 1e-4) dst[i] /= norm[i];
  }
  return result;
}

/**
 * 完整流程：识别语气词 → 定位 → 拉伸 → 拼回（纯函数，播放器只负责包成 AudioBuffer）。
 *
 * 返回 stretched=false 表示这段不需要/没法处理，调用方原样播。
 */
export interface ProsodyResult {
  channels: Float32Array[];
  stretched: boolean;
  factor: number;
  /** 走了哪条处理路径，诊断日志用 */
  mode: "none" | "psola" | "wsola" | "interjection";
}

/** 估不到可靠基音时，宁可用原声，不在短促气流上反复拼接。 */
function periodForSpan(channels: Float32Array[], sampleRate: number, span: { start: number; end: number }): number | null {
  const probe = channels[0].subarray(span.start, Math.min(span.end, span.start + Math.round(sampleRate * 0.04)));
  return estimatePeriod(probe, sampleRate);
}

export function stretchFillerInChannels(
  channels: Float32Array[],
  sampleRate: number,
  text: string,
  fromSample = 0,
): ProsodyResult {
  if (!channels.length) return { channels, stretched: false, factor: 1, mode: "none" };
  // 短叹词优先按配方分流：清辅音原样播放，确定能定位的浊音才整形。
  const inter = interjectionFor(text);
  if (inter?.spec.preserveOriginal) return { channels, stretched: false, factor: 1, mode: "none" };
  if (inter) {
    const spanI = findFirstVoicedRun(channels, sampleRate, fromSample, Math.round(sampleRate * 0.9), hasFollowingSpeech(text));
    if (spanI && spanI.end - spanI.start <= sampleRate * 0.65 && periodForSpan(channels, sampleRate, spanI)) {
      const shaped = shapeInterjection(channels, sampleRate, spanI, inter.spec);
      return { channels: spliceStretched(channels, spanI, shaped, sampleRate, false), stretched: true, factor: 1, mode: "interjection" };
    }
  }
  const mark = fillerStretchFor(text);
  if (!mark || mark.factor <= 1.05) {
    return { channels, stretched: false, factor: 1, mode: "none" };
  }
  const span = findFirstVoicedRun(channels, sampleRate, fromSample, Math.round(sampleRate * 0.9), hasFollowingSpeech(text));
  if (!span) return { channels, stretched: false, factor: 1, mode: "none" };
  // 框出来太长说明开头压根没有语气词停顿（可能整句连读），宁可不拉
  if (span.end - span.start > sampleRate * 0.7) return { channels, stretched: false, factor: 1, mode: "none" };
  // 有稳定基音才周期拼接；估不出来就保留原音。
  const period = periodForSpan(channels, sampleRate, span);
  if (!period) return { channels, stretched: false, factor: 1, mode: "none" };
  let stretched = stretchVoiced(channels, sampleRate, span.start, span.end, mark.factor, period);
  // 长拖音才压音高：随口应的那声「嗯，」压了反而怪
  if (mark.kind === "think") stretched = pitchDown(stretched, 0.97);
  // 拖音同样要过低通。之前只有短叹词过、拖音没过，所以"某些字还有电音"——
  // 拉伸留下的高频毛刺正好落在人耳最敏感的那一段。
  // 3600 太狠：这段可能连着"嗯这个"一起被拉伸，压到 3.6k 会把后面的字也闷掉。
  // 提到 6000 只去毛刺、不动清晰度。
  stretched = lowpass(stretched, sampleRate, 6000);
  return {
    channels: spliceStretched(channels, span, stretched, sampleRate),
    stretched: true,
    factor: mark.factor,
    mode: "psola",
  };
}

/**
 * 这一段是不是「光一个语气词」（`嗯……`、`哦，`）。
 *
 * 用来把单独被切出来的语气词并回后面那句话：单独送合成的话，
 * 「嗯」和后面的句子是两次独立起调，语气接不上；用户听到的是两声。
 */
export function isBareFiller(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  const mark = fillerStretchFor(t);
  if (!mark) return false;
  const rest = t.slice(mark.token.length).replace(/[…\.—－，,。！？!?、；;：:\s]/g, "");
  return rest.length === 0;
}

/**
 * 音高轻微下沉（线性插值重采样）。
 *
 * 只拉长不加这个，听起来像卡带：真人拖长一个音节时音高会往下掉一点。
 * 用线性插值就够了（0.97 这种幅度听不出失真），不值得为此上重采样内核。
 *
 * @param ratio <1 = 降低音高（同时变长 1/ratio 倍）
 */
export function pitchDown(channels: Float32Array[], ratio: number): Float32Array[] {
  const safe = Math.max(0.9, Math.min(1, ratio));
  if (safe >= 0.999) return channels;
  return channels.map((src) => {
    const outLen = Math.max(1, Math.round(src.length / safe));
    const dst = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * safe;
      const i0 = Math.floor(pos);
      const i1 = Math.min(src.length - 1, i0 + 1);
      const t = pos - i0;
      dst[i] = src[i0] * (1 - t) + src[i1] * t;
    }
    return dst;
  });
}

/**
 * 二阶低通（一极点跑两遍），专门收拾拉伸/弯音带出来的高频毛刺。
 *
 * "电音"听感里有一半来自这些能量不高但很扎耳的高频碎屑：基频还在，
 * 但一个周期内的波形被接缝搞出了锯齿。低通把它们按掉，音色立刻"肉"回来。
 */
export function lowpass(channels: Float32Array[], sampleRate: number, cutoff = 3600, passes = 2): Float32Array[] {
  const rc = 1 / (2 * Math.PI * cutoff);
  const dt = 1 / sampleRate;
  const alpha = dt / (rc + dt);
  return channels.map((src) => {
    let dst = new Float32Array(src.length);
    for (let pass = 0; pass < Math.max(1, passes); pass++) {
      const from = pass === 0 ? src : dst;
      const to = new Float32Array(src.length);
      let y = from[0] ?? 0;
      for (let i = 0; i < from.length; i++) {
        y += alpha * (from[i] - y);
        to[i] = y;
      }
      dst = to;
    }
    return dst;
  });
}

// ==================== 短叹词：哼 / 切 / 啧 ====================
//
// 和拖音正相反：这几种声音要的是**音高往下掉 + 收得干脆**。
// TTS 念「哼」时按字典音读成 hēng（一声、平调、拖了三四百毫秒），
// 而人生气时那声「哼」是从高往下砸、两百毫秒就收住——音高曲线和时长都得改。

export interface InterjectionSpec {
  /** 目标时长（秒） */
  duration: number;
  /**
   * 音高曲线：按输出进度 u（0~1）给相对音高倍数，至少两个点。
   * 两个点是直线（升或降）；三个点就是「先升后降」（惊讶的那种"诶↗↘"）。
   */
  contour: { u: number; pitch: number }[];
  /** 起音时间（秒）：越短越"冲" */
  attack: number;
  /**
   * 处理后的低通截止频率（Hz）。默认 6000。
   *
   * 鼻音（哼/嗯）高频本来就少，压低一点只会更圆润；
   * 但**塞擦音**（切 q/嘁/啧 z）的辨识度全在那段高频气流上，
   * 用 3600 去压会直接变成一团闷响——「听不清」就是这么来的。
   */
  cutoff?: number;
  /** 保留原始发音，不压时长、不变调、不做包络衰减或整段情绪低通。 */
  preserveOriginal?: boolean;
  /** 这是什么情绪的声音，日志和测试用 */
  kind: "angry" | "scoff" | "sneer" | "curious" | "surprised" | "realize";
}

/** 跟在语气词后面的标点决定它是哪种语气 */
type Punct = "question" | "exclaim" | "trail" | "soft" | "plain";

function punctAfter(rest: string): Punct {
  if (/^[？?]/.test(rest)) return "question";
  if (/^[！!]/.test(rest)) return "exclaim";
  if (/^(…|\.{2,}|—{1,2}|－)/.test(rest)) return "trail";
  if (/^[，,、]/.test(rest)) return "soft";
  return "plain";
}

/**
 * 声音配方表：**同一个字，标点不同就是不同的声音**。
 *
 * 这就是「诶」和「诶？」不是一回事的原因——「诶？」是好奇心往上挑，
 * 「诶……」是想起来了慢慢拖，「诶！」是被吓到先升后降。人在说话时，
 * 语气词的意思几乎全靠这条音高曲线承载，字面本身是不变的。
 */
function originalInterjections(kinds: Record<string, InterjectionSpec["kind"]>): Record<string, { plain: InterjectionSpec }> {
  return Object.fromEntries(Object.entries(kinds).map(([token, kind]) => [token, {
    plain: { duration: 0.26, contour: [{ u: 0, pitch: 1 }, { u: 1, pitch: 1 }], attack: 0, kind, cutoff: 12000, preserveOriginal: true },
  }]));
}

const RECIPES: Record<string, Partial<Record<Punct, InterjectionSpec>>> = {
  // 生气、不服气：从上往下砸
  "哼": {
    plain: { duration: 0.24, contour: [{ u: 0, pitch: 1.18 }, { u: 1, pitch: 0.82 }], attack: 0.004, kind: "angry", cutoff: 5000 },
  },
  // 送气、塞擦、爆破和擦音：保留合成原声，避免起音被重采样和衰减。
  ...originalInterjections({ 切: "scoff", 嘁: "scoff", 啧: "scoff", 呸: "scoff", 啐: "scoff", 噗: "scoff", 嘶: "scoff", 嘘: "scoff", 呵: "sneer" }),
  // 诶：好奇往上挑 / 想起什么慢慢拖 / 惊讶先升后降
  "诶": {
    question: { duration: 0.3, contour: [{ u: 0, pitch: 0.96 }, { u: 1, pitch: 1.24 }], attack: 0.008, kind: "curious" },
    exclaim: { duration: 0.32, contour: [{ u: 0, pitch: 0.98 }, { u: 0.55, pitch: 1.22 }, { u: 1, pitch: 1.02 }], attack: 0.006, kind: "surprised" },
  },
  "欸": {
    question: { duration: 0.3, contour: [{ u: 0, pitch: 0.96 }, { u: 1, pitch: 1.22 }], attack: 0.008, kind: "curious" },
    exclaim: { duration: 0.32, contour: [{ u: 0, pitch: 0.98 }, { u: 0.55, pitch: 1.2 }, { u: 1, pitch: 1.0 }], attack: 0.006, kind: "surprised" },
  },
  // 哦：恍然大悟是「先升后落」，追问是「往上挑」
  // 咦（yí）是纯元音起头，跟"诶"同类，不需要特殊低通
  "咦": {
    question: { duration: 0.3, contour: [{ u: 0, pitch: 0.96 }, { u: 1, pitch: 1.22 }], attack: 0.008, kind: "curious", cutoff: 7000 },
    exclaim: { duration: 0.32, contour: [{ u: 0, pitch: 0.98 }, { u: 0.55, pitch: 1.2 }, { u: 1, pitch: 1.0 }], attack: 0.006, kind: "surprised", cutoff: 7000 },
  },
  "哟": {
    plain: { duration: 0.28, contour: [{ u: 0, pitch: 1.0 }, { u: 1, pitch: 1.15 }], attack: 0.006, kind: "curious", cutoff: 7000 },
  },
  "哦": {
    exclaim: { duration: 0.3, contour: [{ u: 0, pitch: 0.94 }, { u: 0.5, pitch: 1.2 }, { u: 1, pitch: 0.98 }], attack: 0.006, kind: "realize" },
    question: { duration: 0.28, contour: [{ u: 0, pitch: 0.96 }, { u: 1, pitch: 1.2 }], attack: 0.008, kind: "curious" },
  },
  // 啊：没听清是上挑，被吓到是升后落
  "啊": {
    question: { duration: 0.28, contour: [{ u: 0, pitch: 0.94 }, { u: 1, pitch: 1.2 }], attack: 0.008, kind: "curious" },
    exclaim: { duration: 0.3, contour: [{ u: 0, pitch: 0.98 }, { u: 0.5, pitch: 1.22 }, { u: 1, pitch: 1.05 }], attack: 0.005, kind: "surprised" },
  },
  // 哈：不要重制 h 的起音，问号和感叹号的语气都交给合成器。
  ...originalInterjections({ 哈: "curious" }),
  // 嗯：追问「嗯？」要上挑；其余标点交给拖音那条线（不在这里抢）
  "嗯": {
    question: { duration: 0.26, contour: [{ u: 0, pitch: 0.98 }, { u: 1, pitch: 1.18 }], attack: 0.008, kind: "curious" },
    exclaim: { duration: 0.2, contour: [{ u: 0, pitch: 1.1 }, { u: 1, pitch: 0.92 }], attack: 0.006, kind: "angry" },
  },
};

/**
 * 段首是这类语气词就返回它的声音配方。
 *
 * 同一个字按后面的标点选不同配方；表里没有的组合返回 null，
 * 交给拖音那条线处理（例如「哦……」是慢慢想起来，不是一声短叹）。
 */
export function interjectionFor(text: string): { token: string; spec: InterjectionSpec } | null {
  const t = (text || "").trimStart();
  if (!t) return null;
  const token = Object.keys(RECIPES).find((k) => t.startsWith(k));
  if (!token) return null;
  const rest = t.slice(token.length);
  // 「哼哼」「哈哈」是两声，交给模型自己念，不去压它
  if (rest.startsWith(token)) return null;
  const table = RECIPES[token];
  const punct = punctAfter(rest);
  // 先按标点找，再退到 plain（"哼"这种不管什么标点都是那一声）
  const spec = table[punct] ?? table.plain ?? null;
  if (!spec) return null;
  // 所有配方都只命中独立叹词，不能把「切换」「哼唱」「呵护」当作情绪。
  if (rest.trim() && !INTERJECTION_BOUNDARY.test(rest.trimStart())) return null;
  return { token, spec };
}

/**
 * 时间轴重采样 + 包络：把模型念的那声「哼」压成"往下砸、收得快"。
 *
 * 原理：以 R(u) 的速率读原始采样，音高会乘上 R、时长会除以 R。
 * 所以让 R(u) 从高到低走，音高就往下掉；再乘一个整体速率把总时长拉到 target。
 * 最后叠一层「快起音 + 快速衰减」的包络，那口气才像"从鼻子里冲出来"。
 */
export function shapeInterjection(
  channels: Float32Array[],
  sampleRate: number,
  span: { start: number; end: number },
  spec: InterjectionSpec,
): Float32Array[] {
  if (spec.preserveOriginal) return channels.map(c => c.slice(span.start, span.end));
  const spanLen = Math.max(1, span.end - span.start);
  const targetLen = Math.max(
    Math.round(sampleRate * 0.08),
    Math.min(Math.round(sampleRate * spec.duration), Math.round(spanLen * 1.2)),
  );
  // 第一步：**先压时长**（WSOLA 压缩，音高不动）。
  // 不能一边压时长一边调音高——那样这两个量会互相拉扯，压得越狠音越高，
  // 结果就是一声又尖又短的怪叫（第一版就踩了这个坑）。
  const factor = targetLen / spanLen;
  // 压缩同样按基音周期做（psola）：WSOLA 在这么短的音上找不到对齐点，
  // 正是短音"电音"的第一大来源。
  const probe = channels[0].subarray(span.start, Math.min(span.end, span.start + Math.round(sampleRate * 0.04)));
  const period = estimatePeriod(probe, sampleRate);
  const compressed =
    Math.abs(factor - 1) <= 0.001
      ? channels.map((c) => c.slice(span.start, span.end))
      : period
        ? stretchVoiced(channels, sampleRate, span.start, span.end, factor, period)
        : wsola(channels, sampleRate, span.start, span.end, Math.max(0.6, factor));
  // 第二步：**再弯音高**（时间轴重采样，均值归一到 1，长度保持不变）
  const bent = bendPitchCurve(compressed, spec.contour);
  // 第三步：包络——极短起音（冲出来）+ 二次衰减（收得干净）
  const outLen = bent[0]?.length ?? 0;
  const attackSamples = Math.max(1, Math.round(sampleRate * spec.attack));
  const shaped = bent.map((src) => {
    const dst = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const u = i / Math.max(1, outLen - 1);
      const attack = i < attackSamples ? i / attackSamples : 1;
      const decay = Math.pow(1 - u, 1.6) * 0.75 + 0.25;
      dst[i] = src[i] * attack * decay;
    }
    return dst;
  });
  // 最后过一道低通：弯音留下的高频毛刺就是"电音"的另一半来源。
  // 截止频率按音素类型给——鼻音可以压狠一点，塞擦音必须放过高频。
  const cutoff = spec.cutoff ?? 6000;
  return cutoff >= 12000 ? shaped : lowpass(shaped, sampleRate, cutoff);
}

/**
 * 沿一条音高曲线重采样：**长度不变，只改音高形状**。
 *
 * 原理：读得比原速快 → 音高高、时长短；慢 → 反之。曲线先按进度求值，
 * 再除以自己的均值做归一，让"往上挑"和"往下落"在时长上互相抵消，
 * 最后只留下音高形状本身。这正是「诶？」往上挑、「哼」往下砸的实现方式。
 *
 * @param points 至少两个点，按 u（0~1）升序；中间线性插值
 */
export function bendPitchCurve(
  channels: Float32Array[],
  points: { u: number; pitch: number }[],
): Float32Array[] {
  const len = channels[0]?.length ?? 0;
  if (!len || channels.length === 0) return channels;
  const pts = (points.length >= 2 ? points : [{ u: 0, pitch: 1 }, { u: 1, pitch: 1 }])
    .slice()
    .sort((a, b) => a.u - b.u);
  const curveAt = (u: number) => {
    if (u <= pts[0].u) return pts[0].pitch;
    for (let i = 1; i < pts.length; i++) {
      if (u <= pts[i].u) {
        const a = pts[i - 1];
        const b = pts[i];
        const span = b.u - a.u || 1;
        return a.pitch + ((u - a.u) / span) * (b.pitch - a.pitch);
      }
    }
    return pts[pts.length - 1].pitch;
  };
  // 数值积分求曲线均值，用来把速率归一（纯比例，和采样率无关）
  const STEPS = 128;
  let sum = 0;
  for (let i = 0; i < STEPS; i++) sum += curveAt(i / (STEPS - 1));
  const mean = sum / STEPS || 1;
  return channels.map((src) => {
    const dst = new Float32Array(len);
    let pos = 0;
    for (let i = 0; i < len; i++) {
      const u = i / Math.max(1, len - 1);
      const i0 = Math.floor(pos);
      const i1 = Math.min(len - 1, i0 + 1);
      const t = pos - i0;
      dst[i] = src[i0] * (1 - t) + src[i1] * t;
      pos += curveAt(u) / mean;
    }
    return dst;
  });
}

/** 两点直线弯音的便捷写法（保留给单测和简单场景用） */
export function bendPitch(
  channels: Float32Array[],
  sampleRate: number,
  from: number,
  to: number,
): Float32Array[] {
  void sampleRate;
  return bendPitchCurve(channels, [{ u: 0, pitch: from }, { u: 1, pitch: to }]);
}
