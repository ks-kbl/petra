use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    // 面板 HTML / JS 是 include_str! 进来的：改了要让 cargo 重新编译
    println!("cargo:rerun-if-changed=panel/index.html");
    println!("cargo:rerun-if-changed=panel/chatlog-core.cjs");

    // 把"这次编译的时间"钉进二进制：控制面板页脚会显示它。
    // 用处只有一个 —— 用户说"重新跑了还是老样子"时，一眼就能看出跑的是不是新构建。
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    println!("cargo:rustc-env=PANEL_BUILD_STAMP={}", fmt_cst(secs));

    tauri_build::build()
}

/// 秒 → "YYYY-MM-DD HH:MM"（按 UTC+8，够用了；不做时区库依赖）
fn fmt_cst(unix: i64) -> String {
    let secs = unix + 8 * 3600;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}", rem / 3600, (rem % 3600) / 60)
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
