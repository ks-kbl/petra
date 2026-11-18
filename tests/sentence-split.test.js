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

// ---------- 切分原因（TTS 按它决定停顿长短） ----------
{
  const s1 = sp.takeSpeechSegment("今天天气不错，我们出去走走吧。");
  check("句号 → sentence", s1 && s1.boundary === "sentence", JSON.stringify(s1?.boundary));
  const s2 = sp.takeSpeechSegment("我在想要不要现在告诉你……然后就忘了。");
  check("★ 省略号 → ellipsis 且整对切出", !!s2 && s2.boundary === "ellipsis" && s2.segment.endsWith("……"), JSON.stringify(s2?.segment));
  const s3 = sp.takeSpeechSegment("第一行内容足够长了吧\n第二行也足够长了呀。");
  check("★ 换行 → newline", s3 && s3.boundary === "newline", JSON.stringify(s3?.boundary));
  const s4 = sp.takeSpeechSegment("这是一个没有句号的超长句子啊".repeat(5), { maxChars: 40 });
  check("超长兜底 → soft/hard", s4 && (s4.boundary === "soft" || s4.boundary === "hard"), JSON.stringify(s4?.boundary));
  check("太短的省略号也要断（嗯……）", (() => {
    const r = sp.takeSpeechSegment("嗯……然后呢，我就走了呀。");
    return !!r && r.boundary === "ellipsis";
  })());
  check("流到一半的省略号先不切（等第二个 …）", sp.takeSpeechSegment("我在想要不要现在说这件事…") === null);
}

// ---------- 合成粒度：首段短、之后长（A 层「整段合成」） ----------
{
  const first = sp.speechLimits(0);
  check("★ 首段门槛小（先出声）", first.minChars === 8 && first.maxChars === 48, JSON.stringify(first));
  check("★ 首段也走单换行不断句", first.softNewline === true);
  const steady = sp.speechLimits(1);
  check("★ 之后的段要攒够 26 字才切", steady.minChars === 26, JSON.stringify(steady));
  check("★ 之后的段上限 140 字", steady.maxChars === 140);

  // 短句在「整段」模式下会被合并成一次合成，而不是各自起调
  const multi = "好呀。那我先去看看怎么回事。要不要一起走，路上说也行，反正也不赶时间。";
  const merged2 = sp.takeSpeechSegment(multi, sp.speechLimits(1));
  check("★ 两三句合并成一段送合成", !!merged2 && merged2.segment.includes("好呀。") && merged2.segment.includes("一起走"),
    JSON.stringify(merged2?.segment));

  // 单换行（模型一行一句的回复）不再断句，空行才断
  // 单换行在整段模式下被当作「句中停顿」，两行会一起送进同一次合成
  // （切点在句末的「。」上，而不是切在换行处）
  const nl = "第一行内容足够长了吧\n第二行也足够长了呀，再补一点凑够长度。";
  const nlSeg = sp.takeSpeechSegment(nl, sp.speechLimits(1));
  check("★ 单换行不在换行处切", !!nlSeg && nlSeg.boundary !== "newline", JSON.stringify(nlSeg?.boundary));
  check("★ 两行合并进同一段", !!nlSeg && nlSeg.segment.includes("第一行") && nlSeg.segment.includes("第二行"),
    JSON.stringify(nlSeg?.segment));
  const para = sp.takeSpeechSegment("第一段说完了。\n\n第二段接着说，这里应该是一个新的段落。", sp.speechLimits(1));
  check("★ 空行按段落切开", !!para && para.boundary === "paragraph", JSON.stringify(para));
  check("段落切分去掉多余换行", !!para && !para.rest.startsWith("\n"), JSON.stringify(para?.rest));
}

// ---------- 英文/日文句号 ----------
{
  const en = sp.takeSpeechSegment("This sentence is long enough. And here is another one.");
  check("★ 英文句号能断句", !!en && en.segment === "This sentence is long enough.", JSON.stringify(en?.segment));
  const pi = sp.takeSpeechSegment("Pi is about 3.14159 and that is fine.");
  check("★ 小数点 3.14159 不被切", !!pi && pi.segment.endsWith("fine."), JSON.stringify(pi?.segment));
  const url = sp.takeSpeechSegment("Go to example.com and look around there.");
  check("★ 域名 example.com 不被切", !!url && url.segment.endsWith("there."), JSON.stringify(url?.segment));
  const ja = sp.takeSpeechSegment("これは十分に長い日本語の文です。次の文も続きます。");
  check("日文句号也能断", !!ja && ja.segment.endsWith("。"));
}

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
