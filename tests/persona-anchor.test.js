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

const personaSource = { ...base, personaFree: "原始补充", provider: "custom", model: "chat-model", customBaseUrl: "https://example.invalid", activePresetId: "api-slot", image: { model: "image-model" } };
const preset = st.snapshotPersonaPreset(personaSource, "p1", "人设一");
check("人设预设只存人设字段", Object.keys(preset).sort().join(",") === "fields,free,id,name,nickname");
const target = { ...personaSource, model: "keep-chat", activePresetId: "keep-slot", personaFields: { name: "其他" }, nickname: "你" };
st.applyPersonaPreset(target, preset);
check("切换人设不改变模型、Key 槽或生图配置", target.model === "keep-chat" && target.activePresetId === "keep-slot" && target.image === personaSource.image && target.customBaseUrl === personaSource.customBaseUrl);
check("切换人设恢复角色、自由补充和称呼", target.persona.includes("原始补充") && target.nickname === "老大" && target.personaInitialized);
target.personaFields.name = "改过";
check("编辑当前人设不会改写预设快照", preset.fields.name === base.personaFields.name);

console.log("persona-anchor: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
