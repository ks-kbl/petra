//! 内置联网搜索（无需任何 API Key）。
//!
//! 走搜索引擎的 HTML 结果页，解析出「标题 / 链接 / 摘要」直接回给模型，
//! 模型拿到的是真实网页文本，而不是"帮你打开了一个浏览器"。
//! 走 Rust 侧发起请求：WebView 里 fetch 会被 CORS 挡住，也拿不到别的域的 HTML。
//!
//! **为什么要做多引擎兜底**：原来只走 DuckDuckGo 一个源，国内网络经常连不上，
//! 或者被 DDG 判成爬虫直接返回一个" anomaly"挑战页（HTTP 202、0 条结果），
//! 表现出来就是用户说的"联网搜索老是抽风，搜不到东西"。
//! 现在按 DuckDuckGo → Bing → 百度 依次尝试，任何一个拿到结果就返回；
//! 全挂了才报错，并且把每个引擎的失败原因一起带回去，让模型能换个说法再试或如实说查不到。

use std::collections::HashMap;
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

#[derive(serde::Serialize, Clone)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
    /// 这条结果来自哪个引擎（DuckDuckGo / Bing / 百度）。前端会显示给用户看，
    /// 也方便一眼判断"跑的是不是带多引擎兜底的新构建"。
    pub engine: String,
}

const UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// 单个引擎的超时
const ENGINE_TIMEOUT: Duration = Duration::from_secs(8);
/// 并发竞速的总预算：到点就用手上最好的结果（或报错），不让用户干等
const TOTAL_TIMEOUT: Duration = Duration::from_secs(9);
/// 成功结果的缓存时长：模型爱对同一个词连搜两三次，缓存一下能省掉一半请求。
const CACHE_TTL: Duration = Duration::from_secs(180);

struct Cached {
    at: Instant,
    hits: Vec<SearchHit>,
}

fn cache() -> &'static Mutex<HashMap<String, Cached>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Cached>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_key(query: &str, limit: usize) -> String {
    format!("{}|{}", query.trim().to_lowercase(), limit)
}

fn cache_get(key: &str) -> Option<Vec<SearchHit>> {
    let mut guard = cache().lock().ok()?;
    let hit = guard.get(key)?;
    if hit.at.elapsed() > CACHE_TTL {
        guard.remove(key);
        return None;
    }
    Some(hit.hits.clone())
}

fn cache_put(key: String, hits: &[SearchHit]) {
    if let Ok(mut guard) = cache().lock() {
        // 别让缓存无限长大：超过 40 条就清掉过期项
        if guard.len() > 40 {
            guard.retain(|_, v| v.at.elapsed() <= CACHE_TTL);
        }
        guard.insert(key, Cached { at: Instant::now(), hits: hits.to_vec() });
    }
}

/// 内置搜索：返回前 `limit` 条结果（默认 5，最多 10）。
/// 失败原因原样带回前端，由模型决定是换个说法再搜还是直接告诉用户。
#[tauri::command]
pub async fn web_search(query: String, limit: Option<usize>) -> Result<Vec<SearchHit>, String> {
    tauri::async_runtime::spawn_blocking(move || search_blocking(&query, limit))
        .await
        .map_err(|e| format!("搜索任务异常：{e}"))?
}

fn search_blocking(query: &str, limit: Option<usize>) -> Result<Vec<SearchHit>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("搜索词是空的".into());
    }
    let limit = limit.unwrap_or(5).clamp(1, 10);
    let key = cache_key(q, limit);
    if let Some(hits) = cache_get(&key) {
        return Ok(hits);
    }

    // 三个引擎**并发**跑，谁先拿到结果用谁。
    //
    // 为什么不串行：实测这台机器上 DuckDuckGo 是连不上的（8 秒超时），串行的话每次搜索
    // 都要先白等 8 秒再用 Bing，用户体感就是"点了没反应"。并发之后最慢也就等最慢的那个。
    // Bing 的 RSS 输出（?format=rss）是**干净的 XML**，比抓 HTML 稳得多：
    // 体积小、结构固定、不会被前端改版或"要不要改用新版界面"的实验打乱。
    let engines: [(&'static str, fn(&str) -> Result<String, String>, fn(&str, usize) -> Vec<SearchHit>); 4] = [
        ("Bing RSS", fetch_bing_rss, parse_rss),
        ("Bing", fetch_bing, parse_bing),
        ("百度", fetch_baidu, parse_baidu),
        ("DuckDuckGo", fetch_ddg, parse_ddg),
    ];

    let (tx, rx) = mpsc::channel::<(&'static str, Result<Vec<SearchHit>, String>)>();
    for (name, fetch, parse) in engines {
        let tx = tx.clone();
        let q = q.to_string();
        thread::spawn(move || {
            // 解析 HTML 的代码很容易在某个字符边界上 panic（上面 safe_slice 已经修了主要几处），
            // 但保险起见还是接住：一个引擎崩了只算它失败，不能让线程静默消失、也不影响其它引擎。
            let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_engine(fetch, parse, &q, limit)))
                .unwrap_or_else(|_| Err("解析时崩溃（已捕获）".to_string()));
            let _ = tx.send((name, res));
        });
    }
    drop(tx);

    let deadline = Instant::now() + TOTAL_TIMEOUT;
    let mut problems: Vec<String> = Vec::new();
    let mut first: Option<Vec<SearchHit>> = None;
    loop {
        let left = match deadline.checked_duration_since(Instant::now()) {
            Some(d) if !d.is_zero() => d,
            _ => break,
        };
        match rx.recv_timeout(left) {
            Ok((name, Ok(mut hits))) => {
                for h in hits.iter_mut() {
                    if h.engine.is_empty() {
                        h.engine = name.to_string();
                    }
                }
                first = Some(hits);
                break;
            }
            Ok((name, Err(e))) => problems.push(format!("{name}：{e}")),
            Err(_) => break,
        }
    }

    let Some(mut hits) = first else {
        if problems.is_empty() {
            problems.push("所有引擎都超时了".to_string());
        }
        return Err(format!(
            "所有搜索引擎都没拿到结果。{}。可以换个更短或更常见的关键词再试一次，或者直接告诉用户这次暂时查不到。",
            problems.join("；")
        ));
    };

    hits = dedupe(hits, limit);
    cache_put(key, &hits);
    Ok(hits)
}

fn build_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(ENGINE_TIMEOUT)
        .user_agent(UA)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))
}

fn run_engine(
    fetch: fn(&str) -> Result<String, String>,
    parse: fn(&str, usize) -> Vec<SearchHit>,
    q: &str,
    limit: usize,
) -> Result<Vec<SearchHit>, String> {
    let body = fetch(q)?;
    let hits = parse(&body, limit);
    if hits.is_empty() {
        Err(format!("返回了页面但没解析到结果（{} 字节，可能被限流或人机校验）", body.len()))
    } else {
        Ok(hits)
    }
}

fn fetch_ddg(q: &str) -> Result<String, String> {
    let client = build_client()?;
    let url = format!("https://html.duckduckgo.com/html/?q={}", percent_encode(q));
    let res = client
        .get(&url)
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .header("Accept", "text/html,application/xhtml+xml")
        .send()
        .map_err(|e| describe_req_error(&e))?;
    // DDG 被限流时会回 202 + 一个空的挑战页，这时先按"请求失败"处理，交给下一个引擎
    let status = res.status();
    if status.as_u16() == 202 {
        return Err("请求被限流（HTTP 202）".into());
    }
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    res.text().map_err(|e| format!("读取响应失败：{e}"))
}

fn fetch_bing(q: &str) -> Result<String, String> {
    let client = build_client()?;
    // cn.bing.com 在国内可直连；不带 cc 参数时会按 IP 落到对应区域
    let url = format!(
        "https://cn.bing.com/search?q={}&form=QBLH&setlang=zh-CN",
        percent_encode(q)
    );
    let res = client
        .get(&url)
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .header("Accept", "text/html,application/xhtml+xml")
        .send()
        .map_err(|e| describe_req_error(&e))?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    res.text().map_err(|e| format!("读取响应失败：{e}"))
}

fn fetch_baidu(q: &str) -> Result<String, String> {
    let client = build_client()?;
    let url = format!("https://www.baidu.com/s?wd={}&ie=utf-8", percent_encode(q));
    let res = client
        .get(&url)
        .header("Accept-Language", "zh-CN,zh;q=0.9")
        .header("Accept", "text/html,application/xhtml+xml")
        .header("Referer", "https://www.baidu.com/")
        .send()
        .map_err(|e| describe_req_error(&e))?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    res.text().map_err(|e| format!("读取响应失败：{e}"))
}

/// 把 reqwest 的错误翻成人能看懂的一句话（模型会把它转述给用户）
fn describe_req_error(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "请求超时".into()
    } else if e.is_connect() {
        "连不上（网络被墙或服务不可达）".into()
    } else if e.is_request() {
        format!("请求构造失败：{e}")
    } else {
        format!("网络错误：{e}")
    }
}

/// 不同引擎会返回同一条结果的镜像，按 URL 去重
fn dedupe(hits: Vec<SearchHit>, limit: usize) -> Vec<SearchHit> {
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<SearchHit> = Vec::new();
    for h in hits {
        let key = h.url.trim().to_lowercase();
        if key.is_empty() || seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(h);
        if out.len() >= limit {
            break;
        }
    }
    out
}

// ===================== DuckDuckGo =====================

fn parse_ddg(html: &str, limit: usize) -> Vec<SearchHit> {
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut cursor = 0usize;
    while hits.len() < limit && cursor < html.len() {
        let Some(rel) = html[cursor..].find("class=\"result__a\"") else {
            break;
        };
        let pos = cursor + rel;
        let Some(tag_start) = html[..pos].rfind('<') else {
            break;
        };
        let Some(gt) = html[pos..].find('>') else {
            break;
        };
        let tag_end = pos + gt;
        let tag = safe_slice(html, tag_start, tag_end + 1);
        let href = attr_value(tag, "href").unwrap_or_default();
        let title_end = html[tag_end + 1..]
            .find("</a>")
            .map(|i| tag_end + 1 + i)
            .unwrap_or(html.len());
        let title = clean_text(safe_slice(html, tag_end + 1, title_end));
        cursor = title_end.min(html.len());

        let mut snippet = String::new();
        if let Some(sp_rel) = html[cursor..].find("class=\"result__snippet\"") {
            let sp = cursor + sp_rel;
            let s_tag_end = html[sp..].find('>').map(|i| sp + i).unwrap_or(sp);
            let s_end = html[s_tag_end..]
                .find("</a>")
                .map(|i| s_tag_end + i)
                .or_else(|| html[s_tag_end..].find("</div>").map(|i| s_tag_end + i))
                .unwrap_or(html.len());
            snippet = clean_text(safe_slice(html, s_tag_end + 1, s_end));
            cursor = s_end.min(html.len());
        }

        let url = decode_ddg_href(&href);
        if !title.is_empty() && !url.is_empty() {
            hits.push(SearchHit { title, url, snippet, engine: String::new() });
        }
    }
    hits
}

/// DDG 的链接是跳转形式：//duckduckgo.com/l/?uddg=<百分号编码的真实地址>&rut=…
fn decode_ddg_href(href: &str) -> String {
    let h = href.trim();
    if let Some(idx) = h.find("uddg=") {
        let rest = &h[idx + 5..];
        let raw = rest.split('&').next().unwrap_or(rest);
        let decoded = percent_decode(raw);
        if decoded.starts_with("http") {
            return decoded;
        }
    }
    if let Some(stripped) = h.strip_prefix("//") {
        return format!("https://{stripped}");
    }
    h.to_string()
}

// ===================== Bing =====================

/// Bing 结果块：<li class="b_algo"> … <h2><a href="…">标题</a></h2> … <p>摘要</p>
fn parse_bing(html: &str, limit: usize) -> Vec<SearchHit> {
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut cursor = 0usize;
    while hits.len() < limit && cursor < html.len() {
        let Some(rel) = html[cursor..].find("class=\"b_algo\"") else {
            break;
        };
        let block_start = cursor + rel;
        // 结果块到下一个 b_algo 为止（粗略切块，够用且不需要 HTML 解析器）
        let block_end = html[block_start + 1..]
            .find("class=\"b_algo\"")
            .map(|i| block_start + 1 + i)
            .unwrap_or(html.len());
        let block = safe_slice(html, block_start, block_end);
        cursor = block_end;

        let Some(a_pos) = block.find("<h2") else { continue };
        let Some(a_open) = block[a_pos..].find("<a ") else { continue };
        let a_start = a_pos + a_open;
        let Some(a_gt) = block[a_start..].find('>') else { continue };
        let tag_end = a_start + a_gt;
        let tag = safe_slice(block, a_start, tag_end + 1);
        let href = attr_value(tag, "href").unwrap_or_default();
        let title_end = block[tag_end + 1..]
            .find("</a>")
            .map(|i| tag_end + 1 + i)
            .unwrap_or(block.len());
        let title = clean_text(safe_slice(block, tag_end + 1, title_end));
        let mut snippet = String::new();
        if let Some(p) = block.find("<p") {
            if let Some(gt2) = block[p..].find('>') {
                let s = p + gt2 + 1;
                let e = block[s..].find("</p>").map(|i| s + i).unwrap_or(block.len());
                snippet = clean_text(safe_slice(block, s, e));
            }
        }
        if !title.is_empty() && href.starts_with("http") {
            hits.push(SearchHit { title, url: href, snippet, engine: String::new() });
        }
    }
    hits
}

fn fetch_bing_rss(q: &str) -> Result<String, String> {
    let url = format!("https://www.bing.com/search?q={}&format=rss", percent_encode(q));
    let client = build_client()?;
    let res = client
        .get(&url)
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .header("Accept", "application/rss+xml,application/xml,text/xml")
        .send()
        .map_err(|e| describe_req_error(&e))?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    res.text().map_err(|e| format!("读取响应失败：{e}"))
}

/// RSS：<item><title>…</title><link>…</link><description>…</description></item>
fn parse_rss(xml: &str, limit: usize) -> Vec<SearchHit> {
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut cursor = 0usize;
    while hits.len() < limit {
        let Some(rel) = xml[cursor..].find("<item>") else { break };
        let start = cursor + rel + "<item>".len();
        let end = xml[start..].find("</item>").map(|i| start + i).unwrap_or(xml.len());
        let block = safe_slice(xml, start, end);
        cursor = end;
        let title = tag_text(block, "title");
        let link = tag_text(block, "link");
        let desc = tag_text(block, "description");
        if !title.is_empty() && link.starts_with("http") {
            hits.push(SearchHit {
                title: clean_text(&title),
                url: link,
                snippet: clean_text(&desc),
                engine: String::new(),
            });
        }
    }
    hits
}

/// 取 <tag>…</tag> 之间的原文（不解码、不去标签，交给 clean_text）
fn tag_text(block: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let Some(a) = block.find(&open) else { return String::new() };
    let start = a + open.len();
    let Some(b) = block[start..].find(&close) else { return String::new() };
    safe_slice(block, start, start + b).trim().to_string()
}

// ===================== 百度 =====================

/// 百度结果块：<h3 class="t"><a href="http://www.baidu.com/link?url=…">标题</a></h3>
/// 百度给的是自己的跳转链接，点开也能到目标页，所以原样返回，不做还原。
fn parse_baidu(html: &str, limit: usize) -> Vec<SearchHit> {
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut cursor = 0usize;
    while hits.len() < limit && cursor < html.len() {
        let Some(rel) = html[cursor..].find("<h3") else { break };
        let h3 = cursor + rel;
        let Some(a_open) = html[h3..].find("<a ") else { break };
        let a_start = h3 + a_open;
        let Some(a_gt) = html[a_start..].find('>') else { break };
        let tag_end = a_start + a_gt;
        let tag = &html[a_start..=tag_end];
        let href = attr_value(tag, "href").unwrap_or_default();
        let title_end = html[tag_end + 1..]
            .find("</a>")
            .map(|i| tag_end + 1 + i)
            .unwrap_or(html.len());
        let title = clean_text(safe_slice(html, tag_end + 1, title_end));
        cursor = title_end.min(html.len());

        // 摘要：跟在标题后面的第一个带 content-right / c-abstract 的块
        let mut snippet = String::new();
        // 同样是字节偏移，必须回退到字符边界
        let window = safe_slice(html, cursor, cursor + 2000);
        let sp = window
            .find("c-abstract")
            .or_else(|| window.find("content-right"));
        if let Some(sp) = sp {
            let s = cursor + sp;
            if let Some(gt2) = html[s..].find('>') {
                let text_start = s + gt2 + 1;
                let text_end = html[text_start..]
                    .find("</div>")
                    .map(|i| text_start + i)
                    .unwrap_or(text_start);
                snippet = clean_text(safe_slice(html, text_start, text_end));
            }
        }
        if !title.is_empty() && href.starts_with("http") {
            hits.push(SearchHit { title, url: href, snippet, engine: String::new() });
        }
    }
    hits
}

// ===================== 工具函数 =====================

/// 按字节下标切片，但**回退到字符边界**。
///
/// 这是这一版最重要的修复：原来直接 `&html[a..b]`，而 b 常常是"找到的某个字节位置 + 一个固定偏移"，
/// 一旦落进 UTF-8 多字节字符中间（中文页面到处都是），Rust 会 panic —— 线程静默死掉、
/// 引擎没有任何回音，用户看到的就是"搜不到"。所有切片统一走这里。
fn safe_slice(s: &str, start: usize, end: usize) -> &str {
    let mut a = start.min(s.len());
    while a > 0 && !s.is_char_boundary(a) {
        a -= 1;
    }
    let mut b = end.min(s.len());
    while b > 0 && !s.is_char_boundary(b) {
        b -= 1;
    }
    if b < a {
        b = a;
    }
    &s[a..b]
}

/// 取属性值，单双引号都认
fn attr_value(tag: &str, name: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let pat = format!("{name}={quote}");
        if let Some(start) = tag.find(&pat) {
            let rest = &tag[start + pat.len()..];
            if let Some(end) = rest.find(quote) {
                return Some(rest[..end].to_string());
            }
        }
    }
    None
}

fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for b in input.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = &input[i + 1..i + 3];
                match u8::from_str_radix(hex, 16) {
                    Ok(v) => {
                        out.push(v);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// 去标签 + 解实体 + 压空白：搜索结果里的摘要常带 <b> 高亮和 &amp;
fn clean_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    let unescaped = unescape_entities(&out);
    unescaped.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 解 HTML 实体：搜索结果里全是 `&amp;`、`&#0183;`、`&ensp;` 这种，
/// 不解的话模型读到的摘要会夹着一堆怪字符（还占 token）。
fn unescape_entities(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        let tail = &rest[pos..];
        // 实体最长也就 `&#x1F600;` 这种；超过 12 个**字节**还没 ';' 就当普通字符。
        // 这里必须 safe_slice：12 很可能落在中文字符中间（原来就是这样 panic 的）。
        let semi = safe_slice(tail, 0, 12).find(';');
        match semi {
            Some(end) => {
                let ent = &tail[1..end];
                let decoded = decode_entity(ent);
                match decoded {
                    Some(ch) => {
                        out.push(ch);
                        rest = &tail[end + 1..];
                    }
                    None => {
                        out.push('&');
                        rest = &tail[1..];
                    }
                }
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn decode_entity(ent: &str) -> Option<char> {
    if let Some(hex) = ent.strip_prefix("#x").or_else(|| ent.strip_prefix("#X")) {
        return u32::from_str_radix(hex, 16).ok().and_then(char::from_u32);
    }
    if let Some(dec) = ent.strip_prefix('#') {
        return dec.parse::<u32>().ok().and_then(char::from_u32);
    }
    let ch = match ent {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => ' ',
        "ensp" => ' ',
        "emsp" => ' ',
        "thinsp" => ' ',
        "mdash" => '—',
        "ndash" => '–',
        "hellip" => '…',
        "middot" => '·',
        "ldquo" => '“',
        "rdquo" => '”',
        "lsquo" => '‘',
        "rsquo" => '’',
        "times" => '×',
        "copy" => '©',
        "laquo" => '«',
        "raquo" => '»',
        _ => return None,
    };
    Some(ch)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DDG_FIXTURE: &str = r#"
<div class="links_main links_deep result__body">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&amp;rut=abc">标题 &amp; 实体</a>
  </h2>
  <a class="result__snippet" href="//x">摘要 <b>高亮</b> 文本</a>
</div>
<div class="links_main links_deep result__body">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="https://plain.example.org/p">第二条</a>
  </h2>
  <a class="result__snippet" href="//y">第二条摘要</a>
</div>
"#;

    const BING_FIXTURE: &str = r#"
<li class="b_algo" data-id="x">
  <h2><a href="https://www.example.com/news?id=1" h="ID=SERP">必应结果&nbsp;标题</a></h2>
  <div class="b_caption"><p class="b_lineclamp">这是<b>必应</b>摘要。</p></div>
</li>
<li class="b_algo" data-id="y">
  <h2><a href="https://www.example.com/second">第二条</a></h2>
  <p>第二条摘要</p>
</li>
"#;

    const BAIDU_FIXTURE: &str = r#"
<div class="result c-container">
  <h3 class="t"><a href="http://www.baidu.com/link?url=abc">百度结果标题</a></h3>
  <div class="c-abstract">百度<em>摘要</em>内容</div>
</div>
<div class="result c-container">
  <h3 class="t"><a href="https://www.example.org/x">第二条</a></h3>
  <div class="content-right">第二条摘要</div>
</div>
"#;

    #[test]
    fn parses_ddg_two_results() {
        let hits = parse_ddg(DDG_FIXTURE, 5);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].url, "https://example.com/a?b=1");
        assert!(hits[0].title.contains("标题 & 实体"));
        assert!(hits[0].snippet.contains("摘要"));
    }

    #[test]
    fn parses_bing_results() {
        let hits = parse_bing(BING_FIXTURE, 5);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].url, "https://www.example.com/news?id=1");
        assert!(hits[0].title.contains("必应结果"));
        assert!(hits[0].snippet.contains("必应"));
        assert_eq!(hits[1].snippet, "第二条摘要");
    }

    #[test]
    fn parses_baidu_results() {
        let hits = parse_baidu(BAIDU_FIXTURE, 5);
        assert_eq!(hits.len(), 2);
        assert!(hits[0].url.starts_with("http"));
        assert_eq!(hits[0].title, "百度结果标题");
        assert!(hits[0].snippet.contains("摘要"));
        assert_eq!(hits[1].snippet, "第二条摘要");
    }

    #[test]
    fn respects_limit_and_dedupes() {
        let dup = r#"
<li class="b_algo"><h2><a href="https://a.com/x">A</a></h2><p>1</p></li>
<li class="b_algo"><h2><a href="https://a.com/x">A 重复</a></h2><p>2</p></li>
<li class="b_algo"><h2><a href="https://b.com/y">B</a></h2><p>3</p></li>
"#;
        let hits = dedupe(parse_bing(dup, 10), 10);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].url, "https://a.com/x");
        assert_eq!(hits[1].url, "https://b.com/y");
        assert_eq!(parse_bing(dup, 1).len(), 1);
    }

    #[test]
    fn empty_html_yields_nothing() {
        assert!(parse_ddg("", 5).is_empty());
        assert!(parse_bing("<html>没有结果</html>", 5).is_empty());
        assert!(parse_baidu("<html>没有结果</html>", 5).is_empty());
    }

    #[test]
    fn cache_roundtrip() {
        let hits = vec![SearchHit {
            title: "t".into(),
            url: "https://x".into(),
            snippet: "s".into(),
            engine: "Bing".into(),
        }];
        let key = cache_key(" 测试 ", 5);
        cache_put(key.clone(), &hits);
        let got = cache_get(&key).expect("命中缓存");
        assert_eq!(got[0].url, "https://x");
        assert!(cache_get("不存在的词|5").is_none());
    }
}
