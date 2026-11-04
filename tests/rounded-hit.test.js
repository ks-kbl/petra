/**
 * 圆角命中判定测试（src/input/regions.ts）
 * 用户要求：可点区域的四个角要圆掉，角上的透明处不能再点到桌宠。
 */
const r = require("./build/input/regions.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

const rect = { x: 0, y: 0, width: 200, height: 100 };

// 半径为 0 时就是普通矩形
check("半径 0：中心命中", r.pointInRoundedRect(50, 50, rect, 0) === true);
check("半径 0：左下角命中", r.pointInRoundedRect(1, 99, rect, 0) === true);
check("半径 0：外面不命中", r.pointInRoundedRect(-1, 50, rect, 0) === false);

// 半径 40：四角被切掉
check("圆角：左上角(2,2) 不命中", r.pointInRoundedRect(2, 2, rect, 40) === false);
check("圆角：右上角(198,2) 不命中", r.pointInRoundedRect(198, 2, rect, 40) === false);
check("圆角：左下角(2,98) 不命中", r.pointInRoundedRect(2, 98, rect, 40) === false);
check("圆角：右下角(198,98) 不命中", r.pointInRoundedRect(198, 98, rect, 40) === false);
check("圆角：中心仍命中", r.pointInRoundedRect(100, 50, rect, 40) === true);
check("圆角：上边中点命中", r.pointInRoundedRect(100, 1, rect, 40) === true);
check("圆角：左边中点命中", r.pointInRoundedRect(1, 50, rect, 40) === true);
// 圆心在 (40,40)、半径 40：距圆心 39.6 的点在弧内，45.3 的在弧外
check("圆角：弧内侧命中", r.pointInRoundedRect(12, 12, rect, 40) === true);
check("圆角：弧外侧不命中", r.pointInRoundedRect(8, 8, rect, 40) === false);
// 内缩矩形之外、但仍在圆弧覆盖范围内（贴着下沿）应该命中
check("圆角：拐角区域按弧判定", r.pointInRoundedRect(70, 70, rect, 40) === true);

// 半径超过一半时被夹到短边的一半
check("半径超限被夹住", r.pointInRoundedRect(1, 1, { x: 0, y: 0, width: 100, height: 60 }, 999) === false);

// 退化矩形
check("宽度 0 不命中", r.pointInRoundedRect(0, 0, { x: 0, y: 0, width: 0, height: 10 }, 0) === false);

// 区域上报：圆角会跟着 scale/padding 一起算进去
const region = r.logicalRectToPhysicalRegion("pet", { left: 100, top: 100, right: 200, bottom: 180 }, 1, 700, 700, 18, 40);
check("区域带圆角字段", !!region && region.cornerRadius === 40);
check("区域尺寸含 padding", !!region && region.width === 100 + 36 && region.height === 80 + 36);
const edge = r.logicalRectToPhysicalRegion("pet", { left: 10, top: 10, right: 110, bottom: 90 }, 1, 700, 700, 18, 40);
check("贴边区域被夹进视口", !!edge && edge.x === 0 && edge.y === 0);
const fp1 = r.regionFingerprint([region]);
const region2 = { ...region, cornerRadius: 60 };
check("圆角变化会改变指纹", r.regionFingerprint([region2]) !== fp1);

console.log("rounded-hit: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
