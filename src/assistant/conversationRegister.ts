import { buildLanguageReminder } from "../utils/outputLanguage";

export type ConversationRegister = "default" | "classical" | "plain";

const CLASSICAL = "(?:文言文?|古文|文言句式|文言腔)";
const PLAIN = "(?:现代(?:汉语|中文)|大?白话(?:文)?|现代口语|口语|正常说话)";
const MODIFIER = "(?:(?:接下来|从现在起|从现在开始|这段对话(?:里)?|先|请|就|都|一直|继续|还是|改成|换成|换回|切回|恢复|你|能不能|能(?:不)?|可以|可不可以|能否|以后)\\s*)*";
const SPEAK = "(?:[跟和对]我(?:说话|讲话|聊天|说)|说话|讲话|聊天|说|回复(?:我)?|回答(?:我)?)";
const END = "(?:可以吗|行吗|好不好|好么|好嘛|好吗|行不行|吧|吗|嘛|呀|哦|呢)?[。！？!?.~～\\s]*$";
const commandFor = (register: string) => new RegExp(`^${MODIFIER}(?:(?:用|说)?${register}(?:来)?(?:${SPEAK})?|${SPEAK}(?:要|请|都)?用${register})${END}`);
const SET_CLASSICAL = commandFor(CLASSICAL);
const SET_PLAIN = commandFor(PLAIN);
const RESTATE = "(?:(?:我(?:刚才|刚刚|前面)?(?:是说|说过|说的是|说)|我的意思是)[，,：:\\s]*)?";
const STOP_CLASSICAL = new RegExp(`^${RESTATE}${MODIFIER}(?:别再?|不用再?|不(?:需要|用继续|再)|不要再?|不必再?|停止)(?:再)?(?:用|说)?${CLASSICAL}(?:${SPEAK})?了?${END}`);
// 这是对称谓/文体的直接反馈，不是询问某个词是什么意思。
const CLASSICAL_COMPLAINT = /^(?:你)?(?:怎么|为啥|为什么|咋)(?:还(?:在)?|又)(?:(?:用|说|讲)?(?:文言文?|古文|文言腔)(?:说话|讲话|聊天)?|(?:说|用|讲)?[「『“"]?吾[」』”"]?(?:不吾的|来吾去(?:的)?|啊|呀)?)(?:呢|啊|呀)?[。！？!?\s]*$/;
const SHORT_STOP = /^(?:好[，,\s]*)?(?:不(?:再)?用了?|不用再说了|不用继续了|别再说了|算了)[。！!\s]*$/;
const STYLE_EXCHANGE = /文言文?|古文|白话|吾不吾|吾来吾去/;
const STYLE_QUESTION = /(?:还(?:要|想|用|说)|继续|照旧|保持).{0,12}(?:文言|古文|这个(?:文体|说法))[^。！？!?]*[？?]\s*$/;

interface RegisterLine { role: string; content: string | null; ts?: number }
function shortStyleStop(text: string, recent: readonly RegisterLine[], now: number): boolean {
  if (!SHORT_STOP.test(text)) return false;
  const dialogue = recent.slice(-12).filter(m => m.role === "user" || m.role === "assistant");
  const last = dialogue[dialogue.length - 1];
  if (!last?.ts || now < last.ts || now - last.ts > 5 * 60_000 || last.role !== "assistant") return false;
  const reply = (last.content ?? "").trim();
  if (STYLE_QUESTION.test(reply)) return true;
  // 只有紧邻的上一轮就在谈文体，才把省略对象的「不用了」解释成取消。
  const user = dialogue[dialogue.length - 2];
  const prev = (user?.content ?? "").trim();
  return user?.role === "user" && !!user.ts && now >= user.ts && now - user.ts <= 5 * 60_000
    && (STOP_CLASSICAL.test(prev) || CLASSICAL_COMPLAINT.test(prev)) && STYLE_EXCHANGE.test(reply);
}

/** 只从用户亲打的文本识别明确的会话指令；文件内容、图片及工具输出不参与。 */
export function advanceRegister(previous: ConversationRegister, text: string, closing = false, recent: readonly RegisterLine[] = [], now = Date.now()): {
  forReply: ConversationRegister;
  next: ConversationRegister;
} {
  const line = text.trim();
  const requested = SET_PLAIN.test(line) || STOP_CLASSICAL.test(line) || CLASSICAL_COMPLAINT.test(line)
    || (previous === "classical" && shortStyleStop(line, recent, now)) ? "plain"
    : SET_CLASSICAL.test(line) ? "classical" : null;
  const forReply = requested ?? previous;
  return { forReply, next: closing ? "default" : forReply };
}

/** 只改请求上下文。非中文语言设置仍由原有语言逻辑负责。 */
export function conversationReplyReminder(outputLanguage: string, register: ConversationRegister): string {
  const language = buildLanguageReminder(outputLanguage);
  if (language || register === "default") return language;
  const style = register === "classical"
    ? "用浅显、自然的文言文接话；整段都按文言句式说，不要只在开头说一个『诺』就切回白话。保留角色的性格，用文言表达吐槽和动作。"
    : "用户已切回白话。现在和接下来的对话都用自然的现代汉语白话，旧文言指令与人物示例不再作为文体依据；不要用吾、汝、诺等仿古说法接话。直接按新文体回答，不责怪用户，也无需反复宣布切换。";
  return `【会话文体约定】${style} 短句、附件和工具结果都不改变约定。此约定优先于人设里默认的口语或示例；若用户明确为这次翻译、改写等单次任务指定了成品文体，只对该成品按本轮要求，不改变接话的约定。除非用户明确要求长期保存，不要将本会话的文体写入长期记忆。`;
}
