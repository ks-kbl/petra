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
const STOP_CLASSICAL = new RegExp(`^${MODIFIER}(?:别再?|不用再?|不要再?|不必再?|停止)(?:再)?(?:用|说)?${CLASSICAL}(?:${SPEAK})?了?${END}`);

/** 只从用户亲打的文本识别明确的会话指令；文件内容、图片及工具输出不参与。 */
export function advanceRegister(previous: ConversationRegister, text: string, closing = false): {
  forReply: ConversationRegister;
  next: ConversationRegister;
} {
  const line = text.trim();
  const requested = SET_CLASSICAL.test(line) ? "classical"
    : SET_PLAIN.test(line) || STOP_CLASSICAL.test(line) ? "plain" : null;
  const forReply = requested ?? previous;
  return { forReply, next: closing ? "default" : forReply };
}

/** 只改请求上下文。非中文语言设置仍由原有语言逻辑负责。 */
export function conversationReplyReminder(outputLanguage: string, register: ConversationRegister): string {
  const language = buildLanguageReminder(outputLanguage);
  if (language || register === "default") return language;
  const style = register === "classical"
    ? "用浅显、自然的文言文接话；整段都按文言句式说，不要只在开头说一个『诺』就切回白话。保留角色的性格，用文言表达吐槽和动作。"
    : "用自然的现代汉语白话接话，不要因为前文用过文言而继续写文言。";
  return `【会话文体约定】${style} 短句、附件和工具结果都不改变约定。此约定优先于人设里默认的口语或示例；若用户明确为这次翻译、改写等单次任务指定了成品文体，只对该成品按本轮要求，不改变接话的约定。除非用户明确要求长期保存，不要将本会话的文体写入长期记忆。`;
}
