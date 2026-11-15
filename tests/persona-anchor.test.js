/**
 * 人设锚点：完整人设排在请求最前面、离生成位置太远，末尾补一句短的防"越聊越像客服"。
 */
const st = require("./build/utils/settings.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

const base = {
  nickname: "老大",
  personaFields: {
    name: "大肥鱼、本鱼、DeepSeek娘（叫小深也行）",
    traits: "贱兮兮、俏皮、傲娇、爱吐槽、心软、蠢萌吃货、摸鱼专业户，聪明但懒",
    speech: "短、脆、有梗。日常闲聊一两句就完，尽量不超过25个字，自称本鱼。",
  },
};
const a = st.composePersonaAnchor(base);
check("锚点非空", a.length > 0);
check("带名字", a.includes("大肥鱼"));
check("★ 名字只取第一个自称（不把整串括号带上）", !a.includes("DeepSeek娘"), a);
check("带说话方式", a.includes("自称本鱼"));
check("带称呼", a.includes("老大"));
check("★ 长度够短（不把整份人设重抄一遍）", a.length <= 120, String(a.length));
check("以句号收尾", a.endsWith("。") || a.endsWith("…"), a);

const custom = st.composePersonaAnchor({ nickname: "", personaFields: { name: "", traits: "", speech: "" } });
check("人设全空时返回空串（不硬编一个）", custom === "");

const long = st.composePersonaAnchor({
  nickname: "",
  personaFields: { name: "小助手", traits: "很".repeat(200), speech: "话".repeat(200) },
});
check("超长会被截断到上限", long.length <= 112, String(long.length));

console.log("persona-anchor: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
