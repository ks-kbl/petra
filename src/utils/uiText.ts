/**
 * 用户可见提示文案的本地化兜底。
 *
 * 桌宠的 toast / 错误提示条可能直接接住底层异常（Rust、fetch、插件、第三方 API），
 * 这些字符串经常是纯英文。用户要求"所有弹出提示都用中文显示"，所以统一在
 * Toast / ErrorPopup 的出口做一次翻译兜底；原始错误仍由调用方写日志，便于排查。
 */

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

const ERROR_TRANSLATIONS: Array<[RegExp, string]> = [
  [/failed to fetch|networkerror|load failed|fetch failed|network request failed|network error/i, "网络连接失败，请检查网络或代理后重试"],
  [/\btimeout\b|timed out|etimedout|请求超时/i, "请求超时，请稍后重试"],
  [/401|unauthorized|invalid[_ ]?api[_ ]?key|incorrect api key|令牌无效/i, "API Key 无效或已过期，请重新填写"],
  [/402|insufficient balance|quota exceeded|exceeded your current quota|余额不足/i, "API 余额不足或额度已用完"],
  [/403|forbidden|permission denied|access is denied/i, "没有权限执行此操作"],
  [/404|not found|model_not_found/i, "请求的地址或模型不存在"],
  [/429|rate limit|too many requests/i, "请求太频繁，请稍后再试"],
  [/\b5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout/i, "服务端暂时不可用，请稍后重试"],
  [/cors|access-control-allow-origin/i, "跨域请求被拦截，请检查服务端设置"],
  [/econnrefused|connection refused/i, "连接被拒绝，请确认服务已启动"],
  [/enotfound|eai_again|getaddrinfo/i, "无法解析服务器地址，请检查网络或域名"],
  [/enoent|no such file or directory/i, "文件或目录不存在"],
  [/eacces|permission denied/i, "没有访问权限"],
  [/unexpected token|json parse|parse error/i, "数据格式解析失败"],
  [/\bssl\b|certificate|\btls\b/i, "安全连接失败，请检查证书或代理设置"],
];

/**
 * 把常见英文错误转成中文；已经包含中文的提示原样保留，只替换其中可识别的英文片段。
 * 非错误类英文（例如模型名）不会被强行改写。
 */
export function localizeUiText(raw: string): string {
  const text = String(raw ?? "").trim();
  if (!text) return text;
  for (const [re, zh] of ERROR_TRANSLATIONS) {
    if (!re.test(text)) continue;
    if (CJK_RE.test(text)) return text.replace(re, zh);
    return zh;
  }
  // 纯英文且明显是错误/异常：不再把英文原样甩给用户（详细内容留在日志里）
  if (!CJK_RE.test(text) && /\b(error|failed|failure|exception|invalid|denied|refused|unavailable|abort|socket|econn|enotfound|eai_again)\b|typeerror|referenceerror|syntaxerror|rangeerror|not a function/i.test(text)) {
    return "操作失败，请稍后重试（详细信息已写入日志）";
  }
  return text;
}
