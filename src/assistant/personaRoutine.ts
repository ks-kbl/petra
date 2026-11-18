/**
 * 由人设推出的「生活片段池」（纯函数，可单测）。
 *
 * 为什么必须由人设驱动：同一个机制套在"大肥鱼"身上和套在"健身教练"身上，
 * 出来的必须是两种日子——前者躺床上吃零食摸鱼，后者去跑步。
 * 硬编码一套"看书/散步/听歌"的通用池，换个人设就露馅。
 *
 * 这里用关键词识别人设特征，不调模型：零成本、可测、不会因为模型抽风而变形。
 */

export type RoutineTrait = "lazy" | "food" | "tech" | "sport" | "bookish" | "game" | "social" | "pet";

const TRAIT_RULES: { trait: RoutineTrait; re: RegExp }[] = [
  { trait: "lazy", re: /(懒|摸鱼|躺|睡|赖床|咸鱼|摆烂|不想动|困)/ },
  { trait: "food", re: /(吃|饭|零食|奶茶|厨|饿|吃货|宵夜|外卖)/ },
  { trait: "tech", re: /(程序|代码|开发|工程|bug|debug|终端|写码|黑客|电脑)/ },
  { trait: "sport", re: /(运动|健身|跑步|锻炼|游泳|瑜伽|篮球|羽毛球)/ },
  { trait: "bookish", re: /(看书|读书|学习|书|诗|写作)/ },
  { trait: "game", re: /(游戏|开黑|打牌|麻将|主机|手游)/ },
  { trait: "social", re: /(朋友|聊天|聚会|群|社交|热闹)/ },
  { trait: "pet", re: /(猫|狗|宠物|毛孩子)/ },
];

/** 从人设文本识别特征（可能一个都没有） */
export function detectTraits(persona: string): RoutineTrait[] {
  const t = (persona || "").trim();
  if (!t) return [];
  return TRAIT_RULES.filter((r) => r.re.test(t)).map((r) => r.trait);
}

/** 每个特征贡献的"生活片段"，会被并进对应时段的候选池 */
export const TRAIT_FRAGMENTS: Record<RoutineTrait, { title: string; line: string }[]> = {
  lazy: [
    { title: "赖在床上不想起", line: "被子太舒服了，动一下都费劲" },
    { title: "摊在椅子上发呆", line: "什么都不想干，就这么耗着" },
    { title: "躺着刷手机", line: "说好只看五分钟，已经过去一小时" },
  ],
  food: [
    { title: "在厨房翻吃的", line: "刚吃完又有点饿" },
    { title: "点了杯奶茶", line: "罪恶但快乐" },
    { title: "在认真想晚上吃什么", line: "这件事能想很久" },
  ],
  tech: [
    { title: "在电脑前敲东西", line: "写了删删了写，卡在一个小问题上" },
    { title: "在翻一堆报错", line: "越看越困" },
    { title: "在整理自己那点代码", line: "顺手改了两个名字" },
  ],
  sport: [
    { title: "出去跑了一圈", line: "回来一身汗，挺痛快" },
    { title: "在拉伸", line: "昨天动得太狠，今天有点酸" },
    { title: "刚做完一组训练", line: "手都在抖" },
  ],
  bookish: [
    { title: "把昨天没看完的书接着看", line: "看到一半，正想找人说说" },
    { title: "在抄一段喜欢的句子", line: "抄着抄着走神了" },
    { title: "在翻一本旧书", line: "纸都黄了" },
  ],
  game: [
    { title: "开了一局游戏", line: "输了，不太服气" },
    { title: "在看别人打游戏", line: "比自己打还紧张" },
    { title: "约了人开黑", line: "结果对方放鸽子了" },
  ],
  social: [
    { title: "在群里跟人聊得正欢", line: "话题已经从正事跑偏了" },
    { title: "刚跟朋友通完话", line: "说了半小时废话" },
    { title: "在看别人发的消息", line: "不太想回" },
  ],
  pet: [
    { title: "在逗楼下的猫", line: "它理都不理我" },
    { title: "给毛孩子梳毛", line: "掉了一地" },
    { title: "在拍宠物睡觉", line: "拍了二十张" },
  ],
};

/** 没有识别出任何特征时，用这套中性的日子 */
export const NEUTRAL_FRAGMENTS: { title: string; line: string }[] = [
  { title: "煮了杯咖啡，坐在窗边发呆", line: "刚醒透，脑子还在慢慢转" },
  { title: "在收拾屋子", line: "桌上堆了几天没整理" },
  { title: "趴在桌上小憩了一会儿", line: "刚醒，还有点没回神" },
  { title: "听着歌发呆", line: "循环同一首，懒得换" },
  { title: "在准备晚饭", line: "今天想吃点热的" },
  { title: "在洗漱准备睡了", line: "有点困，眼睛快睁不开" },
];
