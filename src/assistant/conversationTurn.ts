import { isGreetingHistoryContent, GREETING_MARKER } from "./greetingHistory";

/** 本地只给高置信的对话线索；含混的话由本轮模型结合原始历史判断。 */
export type TurnIntent = "close" | "help" | "repair" | "banter" | "vent" | "progress" | "open";
interface RecentMessage { role: string; content: string | null; ts?: number }
export interface TurnContext { intent: TurnIntent; repairReason?: string; replyToGreeting?: string }

const CLOSE = /^(?:(?:好(?:的|吧|啦|了)?|行(?:吧|了)?|嗯+|那行|那好)[，、,。！!\s]*(?:就)?(?:那)?先这样(?:吧|了)?|(?:那就|那|就)?先这样(?:吧|了)?|到这儿?(?:吧|了)?|回头再聊|下次再聊|谢谢[，, ]*(?:先这样|就到这儿?)|晚安|拜拜|再见)[。！!~～\s]*$/;
const REPAIR = /^(?:(?:不(?:是|对)[，,、\s]+)?(?:你(?:刚才)?(?:理解错了|误会了|听错了|弄反了|说反了)|(?:我刚才|我前面)?说错了|我的意思是|我(?:的意思)?不是(?:说|嫌|怪|骂|在说|在骂|这个意思)|不是(?:说|嫌|怪|骂|在说|在怪|在骂|那个意思|这个意思)|我说的是)|(?:对不起|抱歉|我错了|别生气|不气了)(?:[，。！!、,\s]|$))/;
const HELP = /(?:帮我|请你|能不能|可不可以|能帮|给我|为什么|为啥|怎么(?:办|做|弄|解决|修|排查|看|搞|改|还)|如何|看(?:一下|下|看)(?:日志|报错|代码)|分析一下)/;
const TECH_TROUBLE = /接口|报错|异常|失败|又炸|崩了|挂了|卡住|坏了|不工作|不生效/;
const TECH_CONTEXT = /(?:排查|堆栈|日志|复现|报错|错误码|curl|traceback|exception|error[:\s]|console\.|```)/i;
const VENT = /(?:烦死|气死|累死|无语|离谱|服了|头疼|崩溃|不想(?:修|管|动)|只是(?:在)?吐槽|就(?:是)?想吐槽)/;
const JUST_VENT = /^(?:我)?(?:只是(?:在)?吐槽|就(?:是)?想吐槽|先听我说|不用(?:帮我)?(?:出主意|给建议))/;
const BANTER = /^(?:[哈嘿嘻]{2,}|笑死|逗你(?:玩|的)?|开个玩笑|接着编|你猜)[呀啊啦哈嘿，,。！!？?~～\s]*$/;
// 只在接上一条问候时识别省略主语的进度回应；不把普通的「正在」都当成开发进度。
const PROGRESS_REPLY = /^(?:这不(?:就|是)?|我(?:这就|这不就|这不|已经|还|刚|在)|刚才|已经|正在|还在|就差|快改完|改完了|搞定了).{0,28}(?:正在|在(?:给你)?(?:改|做|修|弄|写|动|测试)|改完|做完|修完|动手|动刀|开工|搞定|在测)/;
const PROGRESS_TOPIC = /(?:什么时候|啥时候|几时|进度|动真格|动手|开工|开始|做完|搁置|改完)/;
const NOT_AT_PET = /^(?:我)?(?:不是(?:在)?(?:说|嫌|怪|骂)你|不是嫌你[^，。！？,!?]{1,12}|没(?:有)?(?:在)?(?:怪|骂|嫌)你)/;

export function readTurn(text: string, recent: readonly RecentMessage[] = [], hasAttachment = false, now = Date.now()): TurnContext {
  const t = text.trim();
  const dialogue = recent.slice(-14).filter(m => (m.role === "user" || m.role === "assistant") && m.content?.trim());
  const last = dialogue[dialogue.length - 1];
  const priorUser = [...dialogue].reverse().find(m => m.role === "user");
  // 只考虑紧接着的上一段对话，不把昨天的排查或道歉当作这轮的语境。
  const isRecent = !last?.ts || (now - last.ts >= 0 && now - last.ts <= 20 * 60_000);
  const priorEvidence = isRecent && dialogue.slice(-4).some(m => TECH_CONTEXT.test((m.content ?? "").slice(0, 500)));
  if (!hasAttachment && CLOSE.test(t)) return { intent: "close" };
  if (REPAIR.test(t)) {
    const repairReason = !hasAttachment && isRecent && last?.role === "assistant" && (!priorUser?.ts || (now >= priorUser.ts && now - priorUser.ts <= 20 * 60_000)) && NOT_AT_PET.test(t) && priorUser?.content ? priorUser.content.slice(0, 40) : undefined;
    return repairReason ? { intent: "repair", repairReason } : { intent: "repair" };
  }
  if (isRecent && last?.role === "assistant" && isGreetingHistoryContent(last.content)
      && PROGRESS_TOPIC.test(last.content ?? "") && PROGRESS_REPLY.test(t)) {
    return { intent: "progress", replyToGreeting: last.content!.trimStart().slice(GREETING_MARKER.length).trim().slice(0, 240) };
  }
  if (!hasAttachment && JUST_VENT.test(t)) return { intent: "vent" };
  if (HELP.test(t) || (hasAttachment && TECH_TROUBLE.test(t)) || TECH_CONTEXT.test(t) || (priorEvidence && TECH_TROUBLE.test(t))) return { intent: "help" };
  if (!hasAttachment && BANTER.test(t)) return { intent: "banter" };
  if (!hasAttachment && VENT.test(t)) return { intent: "vent" };
  return { intent: "open" };
}

export function keepTurnLocal(intent: TurnIntent): boolean {
  return intent === "close" || intent === "repair" || intent === "banter" || intent === "vent" || intent === "progress";
}

export function turnReplyGuide(intent: TurnIntent, replyToGreeting?: string): string {
  const guide: Record<TurnIntent, string> = {
    close: "对方在收尾：回一句短确认或道别就停。不追问、不总结、不翻旧话题，也不能沉默。",
    help: "对方可能在推进一件事。先回应问题或现有证据，别先开玩笑；需要解释就讲透，拿不准再问最关键的一点。",
    repair: "先接住这句更正或道歉。若上一轮确实是你理解错了，简短说清误会了哪一点，再按新的意思接着聊；没误会就别认一个不存在的错。拌嘴后自然松一点，不突然撒娇、不翻旧账；本句另有实际请求，接完照常处理。",
    banter: "看最近一句在接什么梗；有梗就顺手接一下，不复读台词，也别硬找新话题。",
    vent: "先接住他正在吐槽的具体事，不默认他要教程；最近几轮如果已经在求助就继续帮忙。",
    progress: "对方在回答你上一条追问，汇报的是用户自己正在做的事（没写主语也不要反过来替他做主）。先接住这条新进展；没有证据不能说是你动的手、编造敲代码或删改记录，也别再问何时开始或替他改到明天。照原话区分进行中和已完成。",
    open: "结合最近几轮判断对方是在闲聊、接梗、求助还是收尾；拿不准先自然接一句，不硬猜情绪或另起话题。",
  };
  const anchor = replyToGreeting ? `上一条主动问候（仅作对话引用）：${JSON.stringify(replyToGreeting)}。` : "";
  return `【这轮怎么接】${anchor}${guide[intent]} 当下对话优先于旧背景；人设靠措辞自然体现，不必每句加自称、昵称、口头禅或收尾问句。`;
}
