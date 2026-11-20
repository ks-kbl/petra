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

check("这首歌怎么样：进入当前播放上下文", si.looksLikeScreenReference("你觉得这首歌怎么样"));
check("当前歌词要找证据", si.asksAboutCurrentMusic("那句歌词是什么意思？"));
check("泛问歌曲知识不截图", !si.looksLikeScreenReference("Coffee 是哪一年发行的？"));
check("不看屏幕仍尊重设置", !si.looksLikeScreenReference("不用截图，你觉得这首歌怎么样"));
check("曲目上下文包含明确来源和不冒充听见", /Coffee/.test(si.currentMusicNote("这首歌怎么样", { title: "Coffee", artist: "beabadoobee" })) && /不是音频/.test(si.currentMusicNote("这首歌怎么样", null)));

check("口语那一首也能取曲目", si.asksAboutCurrentMusic("你知道那一首吗"));
check("截图里的问法：这是什么歌", si.asksAboutCurrentMusic("这是什么歌？"));
const song = { title: "インドア系ならトラックメイカー", artist: "Yunomi / nicamoq / Fdby" };
check("歌词浮层关闭时仍可使用媒体元数据", si.combineMusicEvidence(song, null)?.title === song.title);
check("切歌后不混入上首歌词", !si.combineMusicEvidence(song, { title: "Coffee", artist: "beabadoobee", lyric: "previous line" })?.lyric);
check("只有同一曲目才可附上歌词", si.combineMusicEvidence(song, { ...song, lyric: "current line" })?.lyric === "current line");
check("没有系统媒体数据时不把旧前端快照当事实", si.combineMusicEvidence(null, song) === null);

console.log("screen-intent: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
