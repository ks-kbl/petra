/**
 * 内置人设测试：
 * - 数据完整（字段不为空、id 唯一、默认 id 存在）
 * - 取字段返回深拷贝（改它不能污染内置数据）
 * - isPersonaBlank 能正确判断"人设为空"，用于首次启动默认套用
 */
const bp = require("./build/assistant/builtinPersonas.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

check("至少有一个内置人设", bp.BUILTIN_PERSONAS.length >= 1);
const ids = bp.BUILTIN_PERSONAS.map((p) => p.id);
check("id 不重复", new Set(ids).size === ids.length);
check("默认人设存在", !!bp.findBuiltinPersona(bp.DEFAULT_BUILTIN_PERSONA_ID));
check("未知 id 返回 undefined", bp.findBuiltinPersona("不存在") === undefined);

const fish = bp.findBuiltinPersona("dafeiyu");
check("大肥鱼存在", !!fish);
const fieldNames = ["name", "age", "identity", "world", "desire", "traits", "speech", "catchphrase", "emoji"];
check("九个字段都有内容", fieldNames.every((k) => (fish.fields[k] || "").trim().length > 0),
  fieldNames.filter((k) => !(fish.fields[k] || "").trim()).join(","));
check("自由人设不为空", (fish.free || "").length > 50);
check("有建议称呼", fish.suggestedNickname === "老大");
check("名字里带大肥鱼", fish.fields.name.includes("大肥鱼"));
check("性格里提到摸鱼", fish.fields.traits.includes("摸鱼"));

const copy = bp.builtinPersonaFields("dafeiyu");
copy.name = "被改掉了";
check("取字段是深拷贝", fish.fields.name !== "被改掉了" && fish.fields.name.includes("大肥鱼"));

check("空白人设存在", !!bp.findBuiltinPersona("blank"));
check("空白人设字段全空", Object.values(bp.findBuiltinPersona("blank").fields).every((v) => !v.trim()));

// ---------- isPersonaBlank ----------
check("全空判定为空", bp.isPersonaBlank({}) === true);
check("全空字段判定为空", bp.isPersonaBlank({ persona: "", personaFree: "", personaFields: { name: "", age: "" } }) === true);
check("有字段就不算空", bp.isPersonaBlank({ personaFields: { name: "小满" } }) === false);
check("有自由人设不算空", bp.isPersonaBlank({ personaFree: "她是猫" }) === false);
check("有成品 persona 不算空", bp.isPersonaBlank({ persona: "你的名字是……" }) === false);
check("null 字段不炸", bp.isPersonaBlank({ personaFields: null }) === true);

console.log("builtin-persona: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
