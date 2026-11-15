/**
 * 更新公告：每次发版后第一次打开要弹出来。
 *
 * 真实事故（2026-11-15）：发完 0.3.9 用户更新后什么都没看到——
 * ANNOUNCEMENTS 的表头还停在 0.3.6，而 getUnreadAnnouncement() 只看第一条，
 * 于是"没有未读公告"。0.3.8 也这么漏过一次。
 * 这个测试把"发版必须写公告"钉死：包版本号和最新公告版本号不一致就失败。
 */
const fs = require("node:fs");
const path = require("node:path");
// localStorage 桩要在 require 之前就位（模块里直接引用全局）
global.localStorage = {
  _v: null,
  getItem() { return this._v; },
  setItem(_k, v) { this._v = v; },
};
const ann = require("./build/features/Announcement.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
const latest = ann.latestAnnouncementVersion();

check("有公告", !!latest);
check("★ 最新公告版本号 == package.json 版本号（发版别忘了写公告）", latest === pkg.version, `${latest} vs ${pkg.version}`);

const one = ann.getUnreadAnnouncement();
check("★ 没读过就该弹出来", !!one && one.version === "0.3.9", JSON.stringify(one && one.version));
check("公告有标题和正文行", !!one && one.title.includes("0.3.9") && one.lines.length >= 3, one && one.title);
check("正文里没有空字符串", !!one && one.lines.every((l) => typeof l === "string" && l.trim().length > 0));

// 读过之后就不再弹
check("已读后返回 null", (() => {
  ann.markAnnounced(one.version, one.lines);
  return ann.getUnreadAnnouncement();
})() === null);
check("公告内容改了会重新弹（防同一版本补内容不生效）", (() => {
  ann.markAnnounced(one.version, ["旧内容"]);
  return ann.getUnreadAnnouncement() !== null;
})());

console.log("announcement: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
