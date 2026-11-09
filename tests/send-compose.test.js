/**
 * 「只发图片也能发送」的规则测试。
 *
 * 用户反馈：发图片必须先打一句话，否则点发送没反应。
 * 根因是发送入口只判断 `input.value.trim()`，以及无文字时正文里没有可读内容。
 * 这里锁住两条规则：
 *   1. 图片/文本附件本身就算「有内容可发」；
 *   2. 只有图片、没有文字时，要明确告诉模型「用户没配文字，直接看图回应」。
 */
const c = require("./build/assistant/sendCompose.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

const img = { name: "shot.png", dataUrl: "data:image/png;base64,AAA" };

// ---------- 能不能发 ----------
check("纯文字可发", c.hasSendableContent("你好", 0, 0) === true);
check("只有图片也可发", c.hasSendableContent("", 1, 0) === true);
check("只有文本附件也可发", c.hasSendableContent("  ", 0, 1) === true);
check("什么都没有不可发", c.hasSendableContent("   ", 0, 0) === false);

// ---------- 只有图片时的正文 ----------
const onlyImage = c.composeUserMessage("", "", [img]);
check("只发图片时正文不为空", onlyImage.length > 0);
check("正文里能看到图片文件名", onlyImage.includes("shot.png"));
check("明确告诉模型用户没配文字", onlyImage.includes("没有配文字"));
check("要求模型直接看图回应", onlyImage.includes("直接"));

// ---------- 图文一起 ----------
const withText = c.composeUserMessage("看看这张图", "", [img]);
check("图文一起时保留用户文字", withText.startsWith("看看这张图"));
check("图文一起时也带图片占位", withText.includes("另外附图 1 张"));
check("有文字时不再用「只发了图片」的说法", !withText.includes("没有配文字"));

// ---------- 文本附件 + 图片 ----------
const withFile = c.composeUserMessage("", "【附件：a.txt】\n内容", [img]);
check("有文本附件时图片是补充说明", withFile.includes("另外附图 1 张"));

// ---------- 没有图片 ----------
check("没图片时不产生占位", c.composeUserMessage("你好", "", []).trim() === "你好");

console.log(`send-compose: fail=${fail}`);
process.exit(fail ? 1 : 0);
