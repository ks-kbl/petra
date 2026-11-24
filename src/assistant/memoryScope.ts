/** 文本只匹配明确的作用域词，不把提到软件名或文件名当作切换项目。 */
export type MemoryScope = string;
export const SESSION_ONLY = "@session";
const NAMED = /(?:项目\s*[「『“"《【]?([\p{L}\p{N}][\p{L}\p{N}_.-]{0,31})[」』”"》】]?(?=[\s，,、：:。！？!?]|$)|[「『“"《【]([\p{L}\p{N}][\p{L}\p{N}_. -]{0,31})[」』”"》】]\s*项目|\b([A-Za-z][A-Za-z0-9_.-]{0,31})\s*项目)/u;
const CURRENT = /(?:这个|当前|本|该)项目/;
const SESSION = /(?:只(?:在|限)|仅(?:在|限)|就)(?:这[次轮]|当前(?:这段)?(?:会话|对话))|这(?:一)?次(?:就|用)|这段(?:对话|会话)(?:里|中)/;
const GLOBAL = /(?:所有项目|不分项目|全局(?:都|适用)|不管(?:哪个|什么)项目)/;

export function namedMemoryScope(text: string): MemoryScope | undefined {
  const normalized = text.normalize("NFKC");
  const m = NAMED.exec(normalized);
  const name = (m?.[1] ?? m?.[2] ?? m?.[3])?.toLowerCase().trim();
  // 「项目规则」「项目进度」不是项目名。中文名称优先使用引号。
  if (!name || (m?.[1] && !/^[a-z0-9]/i.test(name) && !/项目\s*[「『“"《【]/.test(normalized))) return undefined;
  return `project:${name}`;
}
export function evidenceScope(text: string, context?: MemoryScope): MemoryScope | undefined {
  if (SESSION.test(text)) return SESSION_ONLY;
  if (GLOBAL.test(text)) return undefined;
  const named = namedMemoryScope(text);
  if (named) return named;
  if (context) return context;
  return CURRENT.test(text) ? SESSION_ONLY : undefined;
}
export const isGlobalScope = (text: string): boolean => GLOBAL.test(text);
export const inMemoryScope = (row: { scope?: MemoryScope }, scope?: MemoryScope): boolean => !row.scope || row.scope === scope;
