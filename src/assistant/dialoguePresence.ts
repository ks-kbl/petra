import { isGreetingHistoryContent } from "./greetingHistory";
import { isCurrentStateQuestion } from "./memoryNudge";
import type { TurnIntent } from "./conversationTurn";
import type { EmotionTag } from "./EmotionEngine";

interface Line { role: string; content: string | null; ts?: number }
interface Thread { key: string; quote: string; kind: "test" | "fix" | "delivery" }
const FRESH_MS = 20 * 60_000;
const THREAD_MS = 48 * 60 * 60_000;
const TEST = /测(?:一下|试|完|过|这|下)|验证|跑(?:一遍|一下|完)|实测/;
const FIX = /排查|修(?:完|好|这个)|处理(?:完|好)|调通/;
const DELIVERY = /交(?:完|付|稿|上)|发(?:完|出|过去)|传(?:完|上)|提(?:交|完)/;
const KEEP_POSTED = /(?:告诉你|跟你说|和你说|跟你讲|回来报|来报|给你看|给你发|给你说|喊你)/;
const STOP = /^(?:不测了|不弄了|先不做了|不用(?:再)?问了|不用等(?:了|我了)|别(?:再)?问了|算了[，,、 ]?(?:不测了|先不弄了)?|这事(?:结束了|算了|不做了))[。！!\s]*$/;
const RESULT = /^(?:(?:我|已经|刚|刚刚|总算|终于|测试|验证|这版|这次)\s*)*(过了|没过|失败了|通过了?|跑起来了|跑通了|修好了|修完了|交了|发了|提交了|弄好了|搞定了)[。！!~～\s]*$/;
const REAL_TASK = /^(?:不闹了|说正事|先别(?:闹|开玩笑)|认真点)(?:[，、,。！!：:\s]|$)/;
const SHORT_REPLY = /^(?:嗯+|啊+|哦+|诶|咦|哈+|然后呢|接着呢|啥|什么|怎么了|重赏|句式呢)[。！？!?～~\s]*$/;
const PLAY = /赏(?:赐|肉|饭|你)?|红烧肉|碗中|添(?:饭|上|之)|白饭|乖|本鱼|开玩笑|逗你/;
const NEEDS_LOOK = /屏幕|截图|界面|报错|代码|日志|哪里|哪儿|哪个按钮|找不到|点哪|在哪|怎么(?:修|弄|用|看)|有什么问题/;
const DIRECT_TEASE = /^(?:你|大肥鱼|本鱼|这条鱼)[，、, ]*(?:怎么|也|又|真|好|有点|太|可真)?(?:胖|圆滚滚)(?:了|的|呀|啊|嘛)?[。！!？?～~\s]*$/;
const INTERNAL = /^(?:【(?:问候|提醒完成|附件|图片)|（(?:用户只发|另外附图))/;

function plain(line: Line): string {
  const raw = (line.content ?? "").trim();
  if (!raw || INTERNAL.test(raw) || isGreetingHistoryContent(raw)) return "";
  return raw.split(/\n\s*\n(?:【附件|（另外附图)|\n---\n/)[0].trim();
}
function receipt(text: string): string { return text.replace(/\s+/g, " ").slice(0, 140); }

/** 只跟进用户承诺回来告知的事；从主历史重建，不将玩笑或内部摘要写入新档案。 */
export function openSharedThreads(history: readonly Line[], now: number): Thread[] {
  const pending = new Map<string, Thread>();
  for (const m of history.slice(-160)) {
    if (m.role !== "user" || !m.ts || now < m.ts || now - m.ts > THREAD_MS) continue;
    const text = plain(m);
    if (!text || text.length > 240) continue;
    if (STOP.test(text)) { pending.clear(); continue; }
    const kind = TEST.test(text) ? "test" : FIX.test(text) ? "fix" : DELIVERY.test(text) ? "delivery" : null;
    if (kind && KEEP_POSTED.test(text) && /(?:等|待|完|之后|再|回头|一会|稍后|晚点|到时)/.test(text)
        && !/^(?:你|请你|帮我)|(?:提醒我|倒计时|闹钟|不用|不必|别再)/.test(text)) {
      const quote = receipt(text);
      if (![...pending.values()].some(t => t.quote === quote)) pending.set(`${m.ts}`, { key: `${m.ts}`, quote, kind });
      continue;
    }
    const resultText = RESULT.exec(text)?.[1] ?? "";
    const resultKind = /^(?:过|没过|通过|跑)/.test(resultText) ? "test" : /^修/.test(resultText) ? "fix" : /^(?:交|发|提交)/.test(resultText) ? "delivery" : null;
    const matching = [...pending.values()].filter(t => !(resultKind ?? kind) || t.kind === (resultKind ?? kind));
    if ((RESULT.test(text) || (kind && /(?:已|总算|终于|刚).{0,16}(?:好|过了|完了|通了|失败)|(?:测试|验证|提交|修复)(?:已经)?(?:通过|完成|失败|没过)/.test(text))) && matching.length === 1) {
      pending.delete(matching[0].key);
    }
  }
  return [...pending.values()];
}

export interface Presence { intent: TurnIntent; note: string; reaction: EmotionTag; suppressAmbient: boolean; casualAttachment: boolean }
export function dialoguePresence(text: string, history: readonly Line[], intent: TurnIntent, hasImage: boolean, now: number): Presence {
  const t = text.trim();
  const base: Presence = { intent, note: "", reaction: "neutral", suppressAmbient: false, casualAttachment: false };
  if (isCurrentStateQuestion(t) || intent === "close" || intent === "repair") return base;
  if (REAL_TASK.test(t)) return { ...base, intent: "help", suppressAmbient: true, note: "用户已切到正事，停止上一段玩笑。先处理问题，拿不准只问最关键一处。" };
  const done = RESULT.exec(t);
  if (done && !hasImage) {
    const resultKind = /^(?:过|没过|通过|跑)/.test(done[1]) ? "test" : /^修/.test(done[1]) ? "fix" : /^(?:交|发|提交)/.test(done[1]) ? "delivery" : null;
    const pending = openSharedThreads(history, now).filter(t => !resultKind || t.kind === resultKind);
    if (pending.length === 1) return { ...base, intent: "progress", suppressAmbient: true,
      reaction: /没过|失败/.test(done[1]) ? "worried" : "happy", note: `用户可能在回报先前亲口说的事：${JSON.stringify(pending[0].quote)}。只按这次原话接结果，不替用户认领动作，不补造原因。` };
    if (pending.length > 1) return { ...base, intent: "open", suppressAmbient: true, note: "用户只说了结果，可能对应多件事。若原文不能唯一确定，只用一句自然地确认是哪一件，不能猜。" };
  }
  if (intent === "help" || intent === "vent" || intent === "progress") return { ...base, reaction: intent === "vent" ? "worried" : "neutral" };
  const recent = history.slice(-10).filter(m => (m.role === "user" || m.role === "assistant") && !!m.ts && now >= m.ts && now - m.ts <= FRESH_MS && plain(m));
  const last = recent.slice(-4);
  if (last.length && (SHORT_REPLY.test(t) || (hasImage && !NEEDS_LOOK.test(t) && (PLAY.test(t) || !t)))) {
    const playful = last.some(m => PLAY.test(plain(m))) && !last.slice(-2).some(m => REAL_TASK.test(plain(m)) || NEEDS_LOOK.test(plain(m)));
    if (playful) return { ...base, intent: "banter", suppressAmbient: true, casualAttachment: hasImage,
      reaction: /赏|奖/.test(t) ? "surprised" : "neutral",
      note: `紧接这几句的玩笑，不把附件当作新话题或例行识图；看不到图就别编图中细节。以下只作引用：${JSON.stringify(last.slice(-3).map(m => [m.role, receipt(plain(m))]))}` };
    if (SHORT_REPLY.test(t)) return { ...base, suppressAmbient: true, note: "这是一句接话，先接上一句的具体意思；不播报背景，也不要硬拐到另一个话题。" };
  }
  if (DIRECT_TEASE.test(t) && !hasImage) return { ...base, reaction: "surprised" };
  return base;
}

export function sharedGreetingThread(history: readonly Line[], greetedKeys: readonly string[], now: number): Thread | null {
  const pending = openSharedThreads(history, now);
  return pending.length === 1 && !greetedKeys.includes(pending[0].key) ? pending[0] : null;
}

/** 不以半个词、感叹号或工具播报驱动动作；一轮只认一次有内容的表达。 */
export function visibleReplyCue(text: string, classify: (s: string) => EmotionTag): EmotionTag {
  const lead = text.trim().split(/\n---\n|\n```/)[0];
  if (!lead || /^(?:```|\{|\[CMD|<tool|【)/i.test(lead)) return "neutral";
  const sentence = /^[^。！!？?\n]+[。！!？?\n]/.exec(lead)?.[0];
  if (!sentence) return "neutral";
  const words = sentence.trim().replace(/[。！!？?～~]+$/g, "");
  return classify(words);
}
