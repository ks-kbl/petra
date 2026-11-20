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

(async () => {
  const assert = require("node:assert/strict");
  assert.equal(q.searchPlan("英伟达 CEO 卸任", ["英伟达 CEO 人事公告", "RTX 5090 价格"])[0], "英伟达 CEO 卸任");
  assert.ok(!q.searchPlan("英伟达 CEO 卸任", ["RTX 5090 价格"]).includes("RTX 5090 价格"));
  assert.ok(q.searchPlan("英伟达 显卡 价格", [], "黄老板是不是下岗了？")[0].includes("下岗"));
  assert.deepEqual(q.searchPlan("NVIDIA CEO", [], "目前我的 token 是 sk-test"), ["NVIDIA CEO"]);
  assert.ok(q.needsWebEvidence("Petra 最新版是多少"));
  assert.ok(!q.needsWebEvidence("连接报错怎么排查"));
  const make = (host, snippet = "") => ({ url: `https://${host}/detail`, title: "英伟达 CEO 卸任", snippet });
  const good = "英伟达公告：公司董事会将在下一次会议中讨论新的任命安排，现任 CEO 的任期和卸任时间以正式公开文件为准。";
  const read = [];
  const pages = await q.collectWebEvidence([make("bad.example"), make("home.example"), make("news.example"), make("mirror.example")], "英伟达 CEO 卸任", async url => {
    read.push(url);
    if (url.includes("bad.")) throw new Error("打不开");
    const text = url.includes("home.") ? "主页菜单导航全部商品查看积分联系我们支付方式最新优惠帮助中心网站地图用户协议" : good;
    return { url, title: "英伟达 CEO 卸任", text, truncated: false };
  });
  assert.equal(read.length, 4, "证据不足时换候选");
  assert.deepEqual(pages.map(p => p.url), ["https://news.example/detail"], "拒绝正文不相关和同文转载");
  assert.ok(q.evidenceExcerpt("无关说明。".repeat(500) + good, "英伟达 CEO 卸任", 240).includes("英伟达公告"));
  console.log(`search: fail=${fail}`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
