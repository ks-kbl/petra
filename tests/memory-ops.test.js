/**
 * 记忆增删改测试：
 * - 相似度保守：不同事实绝不能被并成一条（"喜欢猫" vs "喜欢狗"）
 * - add 近重复 → 覆盖；update 按 id 改；delete 按 id 或内容兜底
 * - 超上限按"最琐碎 + 最久没用"淘汰
 * - 提取器输出宽容解析（对象/数组/```json/老格式）
 */
const mo = require("./build/assistant/memoryOps.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

// ---------- 相似度 ----------
check("完全相同 = 1", mo.textSimilarity("用户喜欢猫", "用户喜欢猫") === 1);
check("空串 = 0", mo.textSimilarity("", "abc") === 0);
const catDog = mo.textSimilarity("用户喜欢猫", "用户喜欢狗");
check("不同事实相似度高但不到合并阈值", catDog > 0.5 && catDog < mo.NEAR_DUPLICATE, "sim=" + catDog.toFixed(2));
check("换说法相似度较高", mo.textSimilarity("用户养了一只猫叫豆豆", "用户养了只猫，名字叫豆豆") > 0.6);
check("无关文本相似度低", mo.textSimilarity("用户喜欢猫", "今天天气不错") < 0.2);

// ---------- 解析 ----------
const opsObj = mo.parseMemoryOps('{"ops":[{"op":"add","content":"用户叫小明","category":"identity","importance":1}]}');
check("解析 {\"ops\":[]}", opsObj.length === 1 && opsObj[0].op === "add" && opsObj[0].category === "identity");
const opsArr = mo.parseMemoryOps('```json\n[{"op":"delete","id":"m1"}]\n```');
check("解析 ```json 裸数组", opsArr.length === 1 && opsArr[0].op === "delete" && opsArr[0].id === "m1");
const legacy = mo.parseMemoryOps('[{"content":"用户喜欢爬山","category":"preference","importance":2}]');
check("老格式自动当 add", legacy.length === 1 && legacy[0].op === "add");
check("垃圾输出返回空", mo.parseMemoryOps("模型今天不想干活").length === 0);
check("空字符串返回空", mo.parseMemoryOps("").length === 0);
check("update 没 id 没 content 被丢弃", mo.parseMemoryOps('{"ops":[{"op":"update"}]}').length === 0);
check("importance 被夹到 1-3", mo.parseMemoryOps('{"ops":[{"op":"add","content":"x","importance":9}]}')[0].importance === 3);

// ---------- 应用：新增 ----------
const keywordsOf = (t) => t.split("");
let r = mo.applyMemoryOps([], [{ op: "add", content: "用户叫小明", category: "identity", importance: 1 }], {
  now: 1000, makeId: () => "id1", keywordsOf, source: "user_said",
});
check("新增一条", r.added === 1 && r.memory.length === 1);
check("新增字段齐全", r.memory[0].id === "id1" && r.memory[0].category === "identity" && r.memory[0].importance === 1);
check("新增带来源", r.memory[0].source === "user_said");
check("新增带时间", r.memory[0].createdAt === 1000 && r.memory[0].updatedAt === 1000);

// ---------- 应用：近重复合并 ----------
r = mo.applyMemoryOps(r.memory, [{ op: "add", content: "用户叫小明", importance: 1 }], { now: 2000, keywordsOf });
check("同内容再记不新增", r.added === 0 && r.updated === 1 && r.memory.length === 1);
check("同内容再记保留原 id", r.memory[0].id === "id1" && r.memory[0].createdAt === 1000);

// ---------- 关键回归：不同事实不能合并 ----------
let base = mo.applyMemoryOps([], [
  { op: "add", content: "用户喜欢猫", category: "preference", importance: 2 },
  { op: "add", content: "用户喜欢狗", category: "preference", importance: 2 },
], { now: 1000, keywordsOf });
check("喜欢猫 和 喜欢狗 是两条", base.memory.length === 2 && base.added === 2, "len=" + base.memory.length);

// ---------- 应用：update ----------
const id = base.memory[0].id;
r = mo.applyMemoryOps(base.memory, [{ op: "update", id, content: "用户把猫送人了，现在养狗", category: "preference", importance: 1 }], { now: 3000, keywordsOf });
check("update 生效", r.updated === 1 && r.memory.length === 2);
check("update 改了内容", r.memory[0].content.includes("送人"));
check("update 保留创建时间", r.memory[0].createdAt === 1000);
check("update 记录更新时间", r.memory[0].updatedAt === 3000);
check("update 取更重要的 importance", r.memory[0].importance === 1);

r = mo.applyMemoryOps(base.memory, [{ op: "update", id: "不存在", content: "随便" }], { now: 3000, keywordsOf });
check("update 找不到就跳过", r.changed === false && r.memory.length === 2);

// ---------- 应用：delete ----------
r = mo.applyMemoryOps(base.memory, [{ op: "delete", id }], { now: 4000 });
check("delete 按 id 删掉", r.removed === 1 && r.memory.length === 1);
const target = base.memory[1].id;
r = mo.applyMemoryOps(base.memory, [{ op: "delete", id: "模型抄错的id", content: base.memory[1].content }], { now: 4000 });
check("delete 按内容兜底", r.removed === 1 && r.memory.every((m) => m.id !== target));

// ---------- 超上限淘汰 ----------
const many = Array.from({ length: 5 }, (_, i) => ({
  id: "m" + i, content: "记忆" + i, category: "other",
  importance: i === 0 ? 1 : 3, createdAt: 100 + i, lastUsedAt: 100 + i,
}));
r = mo.applyMemoryOps(many, [], { maxCount: 3 });
check("超上限被裁到 3 条", r.memory.length === 3);
check("核心记忆不会先被裁", r.memory.some((m) => m.id === "m0"));

// ---------- 给提取器的清单 ----------
const listing = mo.formatMemoryForExtractor(base.memory);
check("清单带 id", listing.includes("id=" + base.memory[0].id));
check("清单带类别与重要度", listing.includes("[preference|重要度"));
check("空库有兜底文案", mo.formatMemoryForExtractor([]) === "（还没有任何记忆）");

console.log("memory-ops: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
