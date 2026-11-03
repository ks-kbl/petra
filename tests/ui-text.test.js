/** 用户可见提示必须中文：弹窗出口的英文错误兜底测试 */
const ui = require("./build/utils/uiText.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

check("Failed to fetch 转中文", ui.localizeUiText("Failed to fetch") === "网络连接失败，请检查网络或代理后重试");
check("混合中文前缀也替换英文错误", ui.localizeUiText("导入失败：TypeError: Failed to fetch").includes("导入失败") && ui.localizeUiText("导入失败：TypeError: Failed to fetch").includes("网络连接失败"));
check("401 转 API Key 提示", ui.localizeUiText("API 错误 401: Unauthorized").includes("API Key 无效"));
check("429 转限流提示", ui.localizeUiText("429 Too Many Requests").includes("请求太频繁"));
check("纯英文异常给中文兜底", ui.localizeUiText("TypeError: x is not a function").includes("操作失败"));
check("正常中文提示原样保留", ui.localizeUiText("已保存设置") === "已保存设置");
check("普通英文模型名不被误伤", ui.localizeUiText("gpt-4o-mini") === "gpt-4o-mini");
check("空串安全", ui.localizeUiText("") === "");

console.log("ui-text: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
