//! 唤醒词（KWS）：本地常驻监听，命中后 emit 事件给前端。
//!
//! 模型：sherpa-onnx-kws-zipformer-zh-en-3M（中英双语，Apache-2.0），
//! 放在 `src-tauri/resources/kws/`。模型只认关键词表里的词，不做通用识别。

use std::collections::HashMap;
use std::ffi::CStr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use sherpa_rs::sherpa_rs_sys;
use pinyin::ToPinyin;
use tauri::{AppHandle, Emitter, Manager};

pub const EVENT_WAKE: &str = "petra://wake";

/// 唤醒调试日志：dev 版不写 pet.log，排查只能自己落一份文件。
fn wlog(msg: &str) {
    use std::io::Write as _;
    let base = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("com.wumiu.petra")
        .join("logs");
    let _ = std::fs::create_dir_all(&base);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(base.join("wake.log"))
    {
        let _ = writeln!(f, "{msg}");
    }
}

const SR: i32 = 16000;

struct Engine {
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
}

static ENGINE: Mutex<Option<Engine>> = Mutex::new(None);
/// 正在启动中：防止超时后用户再点一次又spawn一个引擎（两个线程抢同一个麦克风）
static STARTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 模型目录：开发期用仓库里的 resources/kws，安装后用资源目录。
pub fn model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("kws-model");
    if dev.join("tokens.txt").is_file() {
        return Ok(dev);
    }
    if let Ok(dir) = app.path().resource_dir() {
        for cand in [
            dir.join("kws-model"),
            dir.join("resources/kws-model"),
            dir.join("resources/kws"),
        ] {
            if cand.join("tokens.txt").is_file() {
                return Ok(cand);
            }
        }
    }
    Err("找不到唤醒词模型（resources/kws）".into())
}

fn load_tokens(path: &PathBuf) -> Result<HashMap<String, i32>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("读 tokens.txt 失败: {e}"))?;
    let mut set = HashMap::new();
    for line in text.lines() {
        if let Some((tok, id)) = line.rsplit_once(' ') {
            if let Ok(n) = id.trim().parse::<i32>() {
                set.insert(tok.trim().to_string(), n);
            }
        }
    }
    Ok(set)
}

fn load_phones(path: &PathBuf) -> HashMap<String, Vec<String>> {
    let mut map = HashMap::new();
    if let Ok(text) = std::fs::read_to_string(path) {
        for line in text.lines() {
            let mut it = line.split_whitespace();
            let Some(word) = it.next() else { continue };
            let phones: Vec<String> = it.map(|s| s.to_string()).collect();
            if !phones.is_empty() {
                map.insert(word.to_uppercase(), phones);
            }
        }
    }
    map
}

/// 把一个音节（带声调的拼音）拆成 tokens 里存在的 initial + final。
fn split_syllable(syl: &str, tokens: &HashMap<String, i32>) -> Option<Vec<String>> {
    if tokens.contains_key(syl) {
        return Some(vec![syl.to_string()]);
    }
    let chars: Vec<char> = syl.chars().collect();
    // 从长到短找合法的声母前缀
    for cut in (1..chars.len()).rev() {
        let (head, tail): (String, String) = (chars[..cut].iter().collect(), chars[cut..].iter().collect());
        if tokens.contains_key(&head) && tokens.contains_key(&tail) {
            return Some(vec![head, tail]);
        }
    }
    None
}

/// 文本 → 关键词 tokens。中文走拼音（带声调），英文查 en.phone 的音素表。
pub fn encode_keyword(word: &str, tokens: &HashMap<String, i32>, phones: &HashMap<String, Vec<String>>) -> Option<String> {
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();

    let flush_en = |buf: &mut String, out: &mut Vec<String>| {
        if buf.is_empty() {
            return;
        }
        if let Some(ph) = phones.get(&buf.to_uppercase()) {
            out.extend(ph.iter().cloned());
        }
        buf.clear();
    };

    for c in word.chars() {
        if c.is_ascii_alphabetic() {
            buf.push(c);
            continue;
        }
        flush_en(&mut buf, &mut out);
        if let Some(py) = c.to_pinyin() {
            let syl = py.with_tone();
            if let Some(parts) = split_syllable(syl, tokens) {
                out.extend(parts);
            }
        }
    }
    flush_en(&mut buf, &mut out);

    if out.is_empty() { None } else { Some(out.join(" ")) }
}

/// sherpa-onnx 的 C++ 层用窄字符 ifstream 打开模型文件，Windows 上非 ASCII 路径
/// （比如仓库在 `D:\桌面\...`）会直接报 "does not exist"。所以路径里只要带中文，
/// 就把模型复制到一个纯 ASCII 的目录再用。
fn ascii_model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let src = model_dir(app)?;
    if src.to_string_lossy().is_ascii() {
        return Ok(src);
    }
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().app_local_data_dir() {
        if dir.to_string_lossy().is_ascii() {
            cands.push(dir.join("kws"));
        }
    }
    cands.push(PathBuf::from("C:\\ProgramData\\petra-kws"));
    cands.push(PathBuf::from("C:\\Users\\Public\\petra-kws"));
    for dir in cands {
        if copy_model(&src, &dir).is_ok() {
            return Ok(dir);
        }
    }
    Err("模型路径含中文，且无法复制到 ASCII 目录（ProgramData / Public 都写不了）".into())
}

fn copy_model(src: &PathBuf, dst: &PathBuf) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("建目录失败 {}: {e}", dst.display()))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("读模型目录失败: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        if !from.is_file() {
            continue;
        }
        let to = dst.join(entry.file_name());
        let same = match (std::fs::metadata(&from), std::fs::metadata(&to)) {
            (Ok(a), Ok(b)) => a.len() == b.len(),
            _ => false,
        };
        if !same {
            std::fs::copy(&from, &to).map_err(|e| format!("复制 {} 失败: {e}", from.display()))?;
        }
    }
    if !dst.join("tokens.txt").is_file() {
        return Err("复制后仍然找不到 tokens.txt".into());
    }
    Ok(())
}

fn write_keywords(model_dir: &PathBuf, words: &[String]) -> Result<PathBuf, String> {
    let tokens = load_tokens(&model_dir.join("tokens.txt"))?;
    let phones = load_phones(&model_dir.join("en.phone"));
    let mut lines = Vec::new();
    for w in words {
        if let Some(line) = encode_keyword(w, &tokens, &phones) {
            lines.push(line);
        }
    }
    if lines.is_empty() {
        return Err("唤醒词转换失败：这个模型不认这些词".into());
    }
    let path = model_dir.join("petra-kws-keywords.txt");
    std::fs::write(&path, lines.join("\n")).map_err(|e| format!("写关键词表失败: {e}"))?;
    Ok(path)
}

fn cstring(s: &str) -> std::ffi::CString {
    std::ffi::CString::new(s).unwrap_or_else(|_| std::ffi::CString::new("").unwrap())
}

unsafe fn create_spotter(model_dir: &PathBuf, keywords: &PathBuf, threshold: f32) -> Result<(*const sherpa_rs_sys::SherpaOnnxKeywordSpotter, *const sherpa_rs_sys::SherpaOnnxOnlineStream), String> {
    use sherpa_rs_sys::*;
    let encoder = cstring(&model_dir.join("encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx").to_string_lossy());
    let decoder = cstring(&model_dir.join("decoder-epoch-13-avg-2-chunk-8-left-64.onnx").to_string_lossy());
    let joiner = cstring(&model_dir.join("joiner-epoch-13-avg-2-chunk-8-left-64.int8.onnx").to_string_lossy());
    let tokens = cstring(&model_dir.join("tokens.txt").to_string_lossy());
    let kw = cstring(&keywords.to_string_lossy());
    let provider = cstring("cpu");

    let cfg = SherpaOnnxKeywordSpotterConfig {
        feat_config: SherpaOnnxFeatureConfig { sample_rate: SR, feature_dim: 80 },
        keywords_buf: std::ptr::null(),
        keywords_buf_size: 0,
        keywords_file: kw.as_ptr(),
        max_active_paths: 4,
        keywords_score: 3.0,
        keywords_threshold: threshold,
        num_trailing_blanks: 1,
        model_config: SherpaOnnxOnlineModelConfig {
            transducer: SherpaOnnxOnlineTransducerModelConfig {
                encoder: encoder.as_ptr(),
                decoder: decoder.as_ptr(),
                joiner: joiner.as_ptr(),
            },
            paraformer: std::mem::zeroed(),
            zipformer2_ctc: std::mem::zeroed(),
            num_threads: 1,
            provider: provider.as_ptr(),
            debug: 0,
            tokens: tokens.as_ptr(),
            model_type: std::mem::zeroed(),
            modeling_unit: std::mem::zeroed(),
            bpe_vocab: std::mem::zeroed(),
            tokens_buf: std::ptr::null(),
            tokens_buf_size: 0,
            nemo_ctc: std::mem::zeroed(),
        },
    };

    let spotter = SherpaOnnxCreateKeywordSpotter(&cfg);
    if spotter.is_null() {
        return Err("创建唤醒词检测器失败".into());
    }
    let stream = SherpaOnnxCreateKeywordStream(spotter);
    if stream.is_null() {
        SherpaOnnxDestroyKeywordSpotter(spotter);
        return Err("创建唤醒词音频流失败".into());
    }
    Ok((spotter, stream))
}

/// 诊断：把唤醒词编码成关键词表并把内容返回，用来确认这个词到底能不能编。
#[tauri::command]
pub fn wake_encode(app: AppHandle, words: Vec<String>) -> Result<String, String> {
    let dir = ascii_model_dir(&app)?;
    let tokens = load_tokens(&dir.join("tokens.txt"))?;
    let phones = load_phones(&dir.join("en.phone"));
    let mut out = Vec::new();
    for w in &words {
        match encode_keyword(w, &tokens, &phones) {
            Some(line) => out.push(format!("{w} => {line}")),
            None => out.push(format!("{w} => (编码失败)")),
        }
    }
    Ok(out.join("\n"))
}

/// 自检：只建检测器、不碰麦克风，用来验证模型与关键词表是否可用。
#[tauri::command]
pub fn wake_selftest(app: AppHandle, words: Vec<String>) -> Result<String, String> {
    let dir = ascii_model_dir(&app)?;
    let kw = write_keywords(&dir, &words)?;
    unsafe {
        let (spotter, stream) = create_spotter(&dir, &kw, 0.25)?;
        sherpa_rs_sys::SherpaOnnxDestroyOnlineStream(stream);
        sherpa_rs_sys::SherpaOnnxDestroyKeywordSpotter(spotter);
    }
    Ok(format!("ok: {}", words.join(" / ")))
}

#[tauri::command]
pub fn wake_start(app: AppHandle, words: Vec<String>, threshold: Option<f32>) -> Result<(), String> {
    let mut guard = ENGINE.lock().map_err(|_| "引擎锁失败")?;
    if guard.is_some() {
        return Ok(());
    }
    if STARTING.swap(true, Ordering::SeqCst) {
        return Err("唤醒引擎正在启动中，请稍等两秒".into());
    }
    let dir = ascii_model_dir(&app)?;
    let kw = write_keywords(&dir, &words)?;
    let threshold = threshold.unwrap_or(0.15);
    wlog(&format!("[wake] start words={words:?} threshold={threshold} dir={}", dir.display()));
    if let Ok(kw_text) = std::fs::read_to_string(&kw) {
        wlog(&format!("[wake] keywords=\n{kw_text}"));
    }

    let stop = Arc::new(AtomicBool::new(false));
    let paused = Arc::new(AtomicBool::new(false));
    let (s, p) = (stop.clone(), paused.clone());

    // 启动结果同步回传：线程里建检测器/开麦克风失败，前端必须能看到原因，
    // 否则用户只会看到「喊了没反应」。最多等 8 秒。
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    thread::spawn(move || {
        match build_engine(&app, dir, kw, threshold) {
            Ok((spotter, stream, audio, buffer, name)) => {
                let _ = tx.send(Ok(()));
                if let Err(e) = run_loop(app, spotter, stream, audio, buffer, name, s, p) {
                    eprintln!("[wake] 监听线程退出: {e}");
                }
            }
            Err(e) => {
                let _ = tx.send(Err(e));
            }
        }
    });

    // 首次启动要加载 ONNX 模型 + 枚举音频设备，冷启动可能几秒；
    // 蓝牙设备枚举偶尔更慢，所以给到 25 秒，别让用户以为坏了。
    let result = rx.recv_timeout(Duration::from_secs(25));
    STARTING.store(false, Ordering::SeqCst);
    match result {
        Ok(Ok(())) => {
            *guard = Some(Engine { stop, paused });
            Ok(())
        }
        Ok(Err(e)) => Err(e),
        Err(_) => {
            // 超时不代表后台线程失败了——但它可能稍后成功，留着会变成第二个引擎抢麦克风
            stop.store(true, Ordering::SeqCst);
            Err("唤醒引擎启动超时（25 秒）。模型首次加载或蓝牙设备枚举可能较慢，请再试一次".into())
        }
    }
}

#[tauri::command]
pub fn wake_stop() {
    if let Ok(mut guard) = ENGINE.lock() {
        if let Some(eng) = guard.take() {
            eng.stop.store(true, Ordering::SeqCst);
        }
    }
}

#[tauri::command]
pub fn wake_set_paused(paused: bool) {
    if let Ok(guard) = ENGINE.lock() {
        if let Some(eng) = guard.as_ref() {
            eng.paused.store(paused, Ordering::SeqCst);
        }
    }
}

type Spotter = *const sherpa_rs_sys::SherpaOnnxKeywordSpotter;
type KwStream = *const sherpa_rs_sys::SherpaOnnxOnlineStream;

struct AudioHandle(cpal::Stream);
unsafe impl Send for AudioHandle {}

/// 名字像「蓝牙耳机/免提」的设备优先：用户戴上耳机后希望自动切过去。
fn is_bluetooth_like(name: &str) -> bool {
    let n = name.to_lowercase();
    ["蓝牙", "bluetooth", "airpods", "buds", "hands-free", "免提", "headset", "耳机", "wh-1000", "freebuds"]
        .iter()
        .any(|k| n.contains(k))
}

fn pick_input_device(host: &cpal::Host) -> Option<(String, cpal::Device)> {
    let list: Vec<(String, cpal::Device)> = host
        .input_devices()
        .map(|it| {
            it.filter_map(|d| d.description().ok().map(|x| (x.to_string(), d)))
                .collect()
        })
        .unwrap_or_default();
    if let Some((name, dev)) = list.iter().find(|(n, _)| is_bluetooth_like(n)) {
        return Some((name.clone(), dev.clone()));
    }
    if let Some(d) = host.default_input_device() {
        let name = d
            .description()
            .map(|x| x.to_string())
            .unwrap_or_else(|_| "默认设备".into());
        return Some((name, d));
    }
    None
}

/// 按设备建一条采集流；换设备时重建它即可，不用重启整个引擎。
fn start_capture(
    device: &cpal::Device,
    buffer: Arc<Mutex<Vec<f32>>>,
) -> Result<cpal::Stream, String> {
    let supported = device
        .default_input_config()
        .map_err(|e| format!("读麦克风配置失败: {e}"))?;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let channels = config.channels as usize;
    let dev_rate = config.sample_rate as f64;
    let ratio = dev_rate / SR as f64;
    wlog(&format!(
        "[wake] capture format={sample_format:?} rate={} channels={}",
        config.sample_rate, channels
    ));

    let buf_cb = buffer.clone();
    let acc = Arc::new(Mutex::new(0.0f64));
    let acc_cb = acc.clone();
    let err_fn = |e| eprintln!("[wake] 音频流错误: {e}");

    let audio = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            config,
            move |data: &[f32], _| push_f32(data, channels, ratio, &buf_cb, &acc_cb),
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            config,
            move |data: &[i16], _| {
                let v: Vec<f32> = data.iter().map(|s| *s as f32 / 32768.0).collect();
                push_f32(&v, channels, ratio, &buf_cb, &acc_cb)
            },
            err_fn,
            None,
        ),
        other => return Err(format!("不支持的麦克风采样格式: {other:?}")),
    }
    .map_err(|e| format!("打开麦克风失败: {e}"))?;

    audio.play().map_err(|e| format!("启动麦克风失败: {e}"))?;
    Ok(audio)
}

fn build_engine(
    _app: &AppHandle,
    dir: PathBuf,
    kw: PathBuf,
    threshold: f32,
) -> Result<(Spotter, KwStream, AudioHandle, Arc<Mutex<Vec<f32>>>, String), String> {
    let t0 = std::time::Instant::now();
    let (spotter, stream) = unsafe { create_spotter(&dir, &kw, threshold)? };
    wlog(&format!("[wake] spotter ready in {}ms", t0.elapsed().as_millis()));

    let buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let host = cpal::default_host();
    let t1 = std::time::Instant::now();
    let (name, device) = pick_input_device(&host).ok_or("没有可用的麦克风")?;
    wlog(&format!("[wake] device picked in {}ms: {name}", t1.elapsed().as_millis()));
    let t2 = std::time::Instant::now();
    let audio = start_capture(&device, buffer.clone())?;
    wlog(&format!("[wake] capture ready in {}ms", t2.elapsed().as_millis()));
    Ok((spotter, stream, AudioHandle(audio), buffer, name))
}

fn run_loop(
    app: AppHandle,
    spotter: Spotter,
    stream: KwStream,
    audio: AudioHandle,
    buffer: Arc<Mutex<Vec<f32>>>,
    mut device_name: String,
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
) -> Result<(), String> {
    let host = cpal::default_host();
    let mut audio: Option<AudioHandle> = Some(audio);
    let mut last_check = std::time::Instant::now();

    let mut chunk: Vec<f32> = Vec::with_capacity(4096);
    let mut last_reset = std::time::Instant::now();
    while !stop.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(100));

        // 每 2 秒看一次「该用哪个麦克风」：插上蓝牙耳机就自动切过去
        if last_check.elapsed() >= Duration::from_secs(2) {
            last_check = std::time::Instant::now();
            if let Some((want, dev)) = pick_input_device(&host) {
                if want != device_name {
                    wlog(&format!("[wake] switch device {device_name} -> {want}"));
                    audio = None; // 先放掉旧流
                    match start_capture(&dev, buffer.clone()) {
                        Ok(a) => {
                            audio = Some(AudioHandle(a));
                            device_name = want;
                        }
                        Err(e) => {
                            wlog(&format!("[wake] switch failed: {e}"));
                        }
                    }
                }
            }
        }
        if paused.load(Ordering::SeqCst) {
            if let Ok(mut b) = buffer.lock() { b.clear(); }
            continue;
        }
        chunk.clear();
        if let Ok(mut b) = buffer.lock() {
            chunk.extend_from_slice(&b);
            b.clear();
        }
        if chunk.is_empty() { continue; }

        unsafe {
            sherpa_rs_sys::SherpaOnnxOnlineStreamAcceptWaveform(stream, SR, chunk.as_ptr(), chunk.len() as i32);
            while sherpa_rs_sys::SherpaOnnxIsKeywordStreamReady(spotter, stream) == 1 {
                sherpa_rs_sys::SherpaOnnxDecodeKeywordStream(spotter, stream);
            }
            let r = sherpa_rs_sys::SherpaOnnxGetKeywordResult(spotter, stream);
            if !r.is_null() {
                let kw_text = {
                    let p = (*r).keyword;
                    if p.is_null() { String::new() } else { CStr::from_ptr(p).to_string_lossy().to_string() }
                };
                sherpa_rs_sys::SherpaOnnxDestroyKeywordResult(r);
                if !kw_text.is_empty() {
                    wlog(&format!("[wake] HIT keyword={kw_text}"));
                    last_reset = std::time::Instant::now();
                    let _ = app.emit(EVENT_WAKE, kw_text);
                    sherpa_rs_sys::SherpaOnnxResetKeywordStream(spotter, stream);
                }
            }
        }

        // 连续 8 秒没有命中就重置一次流：长时间运行解码状态会漂移，
        // 表现为「前面喊得应、放一会儿就喊不动了」。
        if last_reset.elapsed() >= Duration::from_secs(8) {
            unsafe { sherpa_rs_sys::SherpaOnnxResetKeywordStream(spotter, stream) };
            last_reset = std::time::Instant::now();
        }
    }

    drop(audio);
    unsafe {
        sherpa_rs_sys::SherpaOnnxDestroyOnlineStream(stream);
        sherpa_rs_sys::SherpaOnnxDestroyKeywordSpotter(spotter);
    }
    Ok(())
}

/// 每 5 秒记一次输入电平，用来确认「到底有没有收到声音」。
pub fn wlog_rms(rms: f32) {
    use std::sync::atomic::{AtomicU64, Ordering as O};
    static LAST: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let last = LAST.load(O::Relaxed);
    if now.saturating_sub(last) >= 5 && LAST.compare_exchange(last, now, O::Relaxed, O::Relaxed).is_ok() {
        wlog(&format!("[wake] mic rms={rms:.4}"));
    }
}

fn push_f32(data: &[f32], channels: usize, ratio: f64, buf: &Arc<Mutex<Vec<f32>>>, acc: &Arc<Mutex<f64>>) {
    if data.is_empty() || channels == 0 {
        return;
    }
    let mut a = match acc.lock() { Ok(v) => v, Err(_) => return };
    let mut out = match buf.lock() { Ok(v) => v, Err(_) => return };

    // 取「最响的那个声道」而不是把 4 个声道平均：
    // Intel 这类阵列常常只有一个声道有真实信号，平均会把音量削弱到 1/4，
    // 模型听到的声音就忽大忽小 —— 用户感受就是「同样音量，有时认得出有时认不出」。
    {
        let sum: f32 = data.iter().map(|v| v * v).sum();
        crate::wake::wlog_rms((sum / data.len().max(1) as f32).sqrt());
    }
    let mut best_ch = 0usize;
    let mut best_energy = -1.0f32;
    for ch in 0..channels {
        let mut e = 0.0f32;
        for frame in data.chunks(channels) {
            if let Some(v) = frame.get(ch) {
                e += v * v;
            }
        }
        if e > best_energy {
            best_energy = e;
            best_ch = ch;
        }
    }

    // 自动增益：太轻就放大（最多 6 倍），已经够响就原样通过
    let peak = data
        .chunks(channels)
        .filter_map(|f| f.get(best_ch))
        .fold(0.0f32, |m, v| m.max(v.abs()));
    let gain = if peak > 0.0005 && peak < 0.08 {
        (0.25 / peak).clamp(1.0, 6.0)
    } else {
        1.0
    };

    for frame in data.chunks(channels) {
        let Some(v) = frame.get(best_ch) else { continue };
        let mono = (v * gain).clamp(-1.0, 1.0);
        *a += 1.0;
        if *a >= ratio {
            *a -= ratio;
            out.push(mono);
        }
    }

    // 防止长时间没人取走导致内存增长
    if out.len() > SR as usize * 10 {
        let drop_n = out.len() - SR as usize * 2;
        out.drain(..drop_n);
    }
}
