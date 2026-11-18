/**
 * 搜索查询改写 + 相关性自检（纯函数）。
 * 这两条决定"搜出来的东西对不对"：整句当搜索词、结果不相关还硬答，是最常见的两个坑。
 */
const q = require("./build/assistant/searchQuery.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

// ---------- 查询改写 ----------
{
  const v = q.buildQueryVariants("为什么我的电脑打不开网页啊？");
  check("★ 原句永远在第一个", v[0] === "为什么我的电脑打不开网页啊？", JSON.stringify(v));
  check("★ 会生成至少两个变体", v.length >= 2, JSON.stringify(v));
  check("★ 变体去掉了疑问词/语气词", v.slice(1).some((s) => !/为什么|啊|？/.test(s)), JSON.stringify(v));
  check("最多 3 个变体", v.length <= 3, String(v.length));

  const en = q.buildQueryVariants("deepseek api pricing");
  check("英文也能用", en[0].includes("deepseek"));

  check("空串不产生变体", q.buildQueryVariants("   ").length === 0);
  const short = q.buildQueryVariants("英伟达");
  check("短词不会硬拆出重复变体", new Set(short).size === short.length, JSON.stringify(short));
}

// ---------- 相关性自检 ----------
{
  const good = [
    { title: "英伟达股价大跌 8%", snippet: "受财报影响，英伟达股价创下年内最大跌幅" },
    { title: "英伟达发布新显卡", snippet: "英伟达今日发布 RTX 系列新品" },
  ];
  const bad = [
    { title: "如何注册账号", snippet: "点击右上角注册按钮即可完成注册" },
    { title: "网站导航", snippet: "首页 新闻 产品 关于我们" },
  ];
  check("★ 相关结果得分高", q.hitRelevance(good, "英伟达 股价") > 0.5, String(q.hitRelevance(good, "英伟达 股价")));
  check("★ 不相关结果得分低", q.hitRelevance(bad, "英伟达 股价") < q.RELEVANCE_FLOOR, String(q.hitRelevance(bad, "英伟达 股价")));
  check("空结果记为 0", q.hitRelevance([], "英伟达") === 0);
  check("空查询记为 0", q.hitRelevance(good, "") === 0);
  check("部分命中在两者之间", q.hitRelevance([{ title: "英伟达发布会", snippet: "新品介绍" }], "英伟达 股价") > 0
    && q.hitRelevance([{ title: "英伟达发布会", snippet: "新品介绍" }], "英伟达 股价") < 1);
}

console.log(`search: fail=${fail}`);
process.exit(fail ? 1 : 0);
