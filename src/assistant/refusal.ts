/**
 * 生气时的"不干活"（纯函数，可单测）。
 *
 * 用户原话：「对于用户的命令也有一定概率不予执行（因为生气了嘛），不过要说为什么」。
 *
 * 但这东西一旦没有边界，用户只会觉得软件坏了。所以这里写死了四条硬约束：
 * 1. **只拒绝非必要请求**（撒娇、陪你玩、唱歌、讲笑话、闲聊）；
 *    关机/删除/发送/提醒/打开软件这类**永不拒绝**——拒绝一次就是事故。
 * 2. **同一条命令第二次必须执行**（嘴硬心软，也给用户明确出路）。
 * 3. **每天拒几次由人设决定**（傲娇嘴硬的多拒一次，温柔的几乎不拒），
 *    模型也能在运行时调（setRefusalCap）；上限硬顶 4 次，不可能无限甩脸色。
 * 4. 说了「认真的」「别闹了」「正经一点」这类**安全词**，立刻照做。
 * 另外拒绝时必须给理由 + 留台阶，不能只甩一个"不要"。
 */

export type RequestKind = "safety" | "task" | "social";

/** 绝对不能拒绝的：不可逆、对外发送、系统操作 */
const SAFETY_RE = /(关机|重启|注销|锁屏|删除|删掉|卸载|格式化|清空|发送|发给|发给谁|转账|支付|付款|下单|提醒|闹钟|定时|日程|安装|上传)/;
/** 明确的功能类请求：查、写、改、打开、翻译、算……都不拒 */
const TASK_RE = /(打开|启动|帮我|帮忙|查一?下|搜索|搜一?下|查查|写一?个|改成|修改|翻译|计算|算一下|整理|生成|画一?张|截图|看一?下屏幕)/;
/** 安全词：用户说这些就是要"现在就办" */
const SERIOUS_RE = /(认真的|正经一点|别闹了?|不玩了|必须|紧急|马上办|别玩了|我是说真的)/;

export function isSerious(text: string): boolean {
  return SERIOUS_RE.test(text || "");
}

export function classifyRequest(text: string): RequestKind {
  const t = (text || "").trim();
  if (!t) return "social";
  if (SAFETY_RE.test(t)) return "safety";
  if (TASK_RE.test(t)) return "task";
  // 「陪我聊会儿」「唱个歌」「夸夸我」这类都算社交请求
  return "social";
}

export interface RefusalInput {
  text: string;
  /** 当前心情 -1~1 */
  mood: number;
  /** 今天已经拒绝过几次 */
  refusedToday: number;
  /** 同一条请求之前拒绝过几次 */
  sameRequestRefused: number;
  /** 随机数 0~1（测试里注入固定值） */
  roll: number;
  /** 安全词命中（外面先算，便于测试） */
  serious?: boolean;
  /** 当天额度（由人设推导，或模型直接给）；不传按 2 算 */
  dailyCap?: number;
  /** 闹脾气倾向（表达型推导），默认 1 */
  tendency?: number;
}

export interface RefusalDecision {
  refuse: boolean;
  kind: RequestKind;
  /** 这次"想不想闹脾气"的概率，日志与测试用 */
  probability: number;
  /** 为什么拒绝（直接进话术） */
  reason?: string;
  /** 拒绝时留的台阶 */
  out?: string;
}

/**
 * 心情 → 闹脾气的概率，再乘一个"人设倾向"。
 *
 * 三种表达型的倾向不同：爱吐槽的（sarcastic）更容易甩脸色；
 * 高冷的（terse）懒得吵，只是不理；温柔的（pretend）基本不会拒绝，只会变冷。
 */
export function refusalProbability(mood: number, tendency = 1): number {
  const base = mood <= -0.55 ? 0.35 : mood < -0.2 ? 0.12 : 0;
  return Math.min(0.5, base * Math.max(0.3, Math.min(1.5, tendency)));
}

/** 表达型 → 闹脾气倾向（概率倍率） */
export function refusalTendency(style: "sarcastic" | "terse" | "pretend"): number {
  if (style === "sarcastic") return 1.2;
  if (style === "terse") return 0.8;
  return 0.5;
}

/**
 * 表达型 + 人设特征 → 每天拒绝额度（0~4）。
 *
 * 这个数不是"限制用户"，而是"这个角色今天能甩几次脸色"：
 * 爱吐槽又有底气的多一次，温柔的几乎不拒。AI 也可以在运行时覆盖（见 lifeRuntime.setRefusalCap）。
 */
export function refusalBudget(style: "sarcastic" | "terse" | "pretend", traits: string[] = []): number {
  let cap = style === "sarcastic" ? 3 : style === "terse" ? 2 : 1;
  if (traits.includes("lazy") || traits.includes("food")) cap += 1; // 懒散/爱吃的人更容易耍赖
  if (traits.includes("sport") || traits.includes("tech")) cap -= 1; // 正经/自律的少甩脸色
  return Math.max(0, Math.min(4, cap));
}

/** 硬顶：无论谁来调，一天也不会拒超过 4 次 */
export const REFUSAL_DAILY_MAX = 4;

export function shouldRefuse(i: RefusalInput): RefusalDecision {
  const kind = classifyRequest(i.text);
  const probability = refusalProbability(i.mood, i.tendency ?? 1);
  const cap = Math.max(0, Math.min(REFUSAL_DAILY_MAX, i.dailyCap ?? 2));
  const no = (reason?: string): RefusalDecision => ({ refuse: false, kind, probability, reason });

  if (i.serious || isSerious(i.text)) return no("安全词：立刻照做");
  if (kind === "safety") return no("安全/不可逆操作：永不拒绝");
  if (kind === "task") return no("功能性请求：不拒绝");
  if (i.sameRequestRefused > 0) return no("同一条请求已经拒绝过，第二次必须执行");
  if (i.refusedToday >= cap) return no(`今日拒绝额度已用完（${cap} 次）`);
  if (probability <= 0) return no("心情还没差到要闹脾气");
  if (i.roll >= probability) return no("这次没抽中");

  return {
    refuse: true,
    kind,
    probability,
    reason: "还在气头上，不想配合",
    out: "哄我一句我就干。",
  };
}

/** 拒绝时的说话模板：不同表达型给不同的台词 */
export function refusalLine(style: "sarcastic" | "terse" | "pretend", reason: string): string {
  if (style === "terse") return `不。${reason}。`.replace("。。", "。");
  if (style === "pretend") return `……现在不太想弄。${reason}。`;
  return `不干。${reason}，谁让你刚才那样的。哄我一句再说。`;
}
