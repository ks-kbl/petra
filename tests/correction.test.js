/** 纠正识别测试：宁可漏，不要误判（误判会频繁重跑提取 + 重算画像） */
const c = require("./build/assistant/correction.js");

let fail = 0;
const check = (name, cond) => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name);
};
const yes = [
  "你记错了，我不写小说了",
  "不是这样，我不喜欢猫",
  "我没说过我要考研",
  "你搞错了，那是去年的项目",
  "别记这个，已经结束了",
  "我说的是周三不是周四",
  "我不是学生而是老师",
];
const no = [
  "今天天气不错",
  "帮我把这个文件改一下",
  "我记得你说过要早点睡",
  "我在记录今天的开销",
  "这个 bug 记一下，明天修",
  "",
];
yes.forEach((t) => check("识别纠正：" + t, c.detectCorrection(t) === true));
no.forEach((t) => check("不误判：" + (t || "(空)"), c.detectCorrection(t) === false));
check("超长文本不判", c.detectCorrection("记错了" + "啊".repeat(300)) === false);

console.log("correction: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
