/**
 * 「这句话是不是在说眼前屏幕上的东西」——前端兜底截图用的判定。
 * 判定要窄：截一张图约 1~2k token，宁可漏也不要每条消息都截。
 */
const si = require("./build/assistant/screenIntent.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

// 真实触发过的说法（2026-11-15 聊天记录）
check("★「这个老师的衣服怎么怪怪的」要截", si.looksLikeScreenReference("这个老师的衣服怎么怪怪的"));
check("「看这个」要截", si.looksLikeScreenReference("看这个"));
check("「我让你看屏幕」要截", si.looksLikeScreenReference("我让你看屏幕"));
check("「这题怎么做」要截", si.looksLikeScreenReference("这题怎么做"));
check("「帮我看看这个报错」要截", si.looksLikeScreenReference("帮我看看这个报错"));

// 不该截的
check("纯概念提问不截", !si.looksLikeScreenReference("怎么判断物质是否稳定"));
check("算数不截", !si.looksLikeScreenReference("4526除50取整数是多少"));
check("「这个」但没有指向动作不截", !si.looksLikeScreenReference("这个"));
check("明确说不看时不截", !si.looksLikeScreenReference("不用看屏幕，直接说"));
check("空串不截", !si.looksLikeScreenReference(""));
check("超长粘贴不截（多半是代码/文章）", !si.looksLikeScreenReference("看".repeat(50) + "这个".repeat(100)));

check("提示语告诉模型别再演一遍", si.AUTO_SCREEN_NOTE.includes("capture_screen") && si.AUTO_SCREEN_NOTE.includes("不要再说"));

console.log("screen-intent: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
