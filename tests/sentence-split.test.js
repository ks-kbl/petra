/**
 * TTS 断句测试：
 * - 见到句末标点就切（不切在 ；，、）
 * - 太短的句子会跟后面合并（不再出现"好。/对。"这种碎片各合成一次）
 * - 不切进引号/括号里、不切坏 3.14
 * - 超长文本在逗号处断开
 */
const sp = require("./build/tts/sentenceSplit.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

// ---------- 正常整句 ----------
const a = sp.takeSpeechSegment("今天天气不错，我们出去走走吧。");
check("整句直接切出", !!a && a.segment === "今天天气不错，我们出去走走吧。");
check("剩下的为空", !!a && a.rest === "");

// ---------- 短句合并 ----------
check("「好。」太短不切", sp.takeSpeechSegment("好。") === null);
check("「好。谢谢。」仍然不切", sp.takeSpeechSegment("好。谢谢。") === null);
const merged = sp.takeSpeechSegment("好。谢谢。那我先走了，明天见。");
check("攒够长度后一起送出", !!merged && merged.segment.includes("好。谢谢。") && merged.segment.endsWith("明天见。"));

// ---------- 分号不切 ----------
const semi = sp.takeSpeechSegment("我上午写了代码；下午开了个会，然后就没时间了。");
check("分号不当句末", !!semi && semi.segment.endsWith("没时间了。"));

// ---------- 引号内不切 ----------
const quote = sp.takeSpeechSegment("他说「你好。再见。」然后就走了，这件事我一直记着。");
check("引号内的句号不切", !!quote && quote.segment.includes("再见。") && quote.segment.endsWith("记着。"));

// ---------- 小数点 ----------
const pi = sp.takeSpeechSegment("圆周率大约是3.14，这个数值很有名。");
check("小数点不被切开", !!pi && pi.segment.includes("3.14"));

// ---------- 超长兜底 ----------
const long = "这是一个没有句号的超长句子".repeat(10);
const cut = sp.takeSpeechSegment(long, { maxChars: 40 });
check("超长会兜底断开", !!cut && cut.segment.length <= 40);
check("兜底切断后 rest 接得上", !!cut && cut.segment + cut.rest === long);

// ---------- 换行当句末（列表/分行回复） ----------
const line = sp.takeSpeechSegment("第一行内容足够长了吧\n第二行也足够长了呀。");
check("换行处断开", !!line && line.segment === "第一行内容足够长了吧", JSON.stringify(line));
check("换行后的内容接得上", !!line && line.rest === "第二行也足够长了呀。", JSON.stringify(line?.rest));
check("太短的换行行不切", sp.takeSpeechSegment("好\n") === null);

// ---------- 增量流 ----------
let buf = "";
const out = [];
for (const ch of "你好呀。今天过得怎么样，有没有好好吃饭？") {
  buf += ch;
  let seg;
  while ((seg = sp.takeSpeechSegment(buf))) {
    out.push(seg.segment);
    buf = seg.rest;
  }
}
check("增量流能攒出句子", out.length >= 1, JSON.stringify(out));
check("最后一段包含问句", out.join("").includes("好好吃饭？"));

// ---------- 收尾 ----------
check("flush 去掉空白", sp.flushSpeechSegment("  剩下的话 ") === "剩下的话");
check("flush 空串", sp.flushSpeechSegment("   ") === "");

// ---------- 极端输入 ----------
check("空串不炸", sp.takeSpeechSegment("") === null);
check("只有换行不炸", sp.takeSpeechSegment("\n\n\n") === null);

console.log("sentence-split: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
