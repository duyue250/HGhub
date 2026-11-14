//! 媒体层：封面解密 + HLS 代理。
//!
//! 站点封面是 AES-128-CBC 密文，m3u8 内部分片/key 又可能被 WebView 的 CORS 拦住，
//! 所以图片与视频统一走本地自定义协议（Windows/Android 为 `http://hg.localhost`，
//! macOS 为 `hg://localhost`，见 [`LOCAL_ORIGIN`]）。

use crate::net::fetch_bytes;
use aes::cipher::{BlockDecrypt, KeyInit};
use aes::Aes128;
use once_cell::sync::Lazy;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::http::{Response, StatusCode};

/// 本平台自定义协议的完整基址。
///
/// Tauri 的自定义协议地址随平台不同：Windows / Android 是 `http://<scheme>.localhost`，
/// macOS / iOS / Linux 是 `<scheme>://localhost`。m3u8 里的分片与 key 地址按它改写。
/// 前端 `src/api.ts` 的 `LOCAL` 必须与此一致，否则封面与视频全部加载失败。
#[cfg(any(target_os = "windows", target_os = "android"))]
pub const LOCAL_ORIGIN: &str = "http://hg.localhost";
#[cfg(not(any(target_os = "windows", target_os = "android")))]
pub const LOCAL_ORIGIN: &str = "hg://localhost";

const IMG_KEY: &[u8] = b"f5d965df75336270";
const IMG_IV: &[u8] = b"97b60394abc2fbe1";

static IMG_CACHE: Lazy<Mutex<LruCache<Arc<Vec<u8>>>>> =
    Lazy::new(|| Mutex::new(LruCache::new(IMG_CACHE_MAX, 0)));
static PL_CACHE: Lazy<Mutex<LruCache<Arc<String>>>> =
    Lazy::new(|| Mutex::new(LruCache::new(PL_CACHE_MAX, 0)));
static KEY_CACHE: Lazy<Mutex<LruCache<(String, Arc<Vec<u8>>>>> =
    Lazy::new(|| Mutex::new(LruCache::new(KEY_CACHE_MAX, 0)));
static SEG_CACHE: Lazy<Mutex<LruCache<(String, Arc<Vec<u8>>>>> =
    Lazy::new(|| Mutex::new(LruCache::new(SEG_CACHE_MAX, SEG_CACHE_TOTAL_BYTES)));

const IMG_CACHE_MAX: usize = 240;
const PL_CACHE_MAX: usize = 60;
const KEY_CACHE_MAX: usize = 120;
const SEG_CACHE_MAX: usize = 36;
/// 单条分片入缓上限。
const SEG_CACHE_MAX_BYTES: usize = 4 * 1024 * 1024;
/// 分片缓存总字节硬预算：此前「36 条 × 4MiB」理论上限可达 144MiB，且按任意键淘汰，
/// 回拖进度条会误删刚缓存的分片；升级为 LRU + 64MiB 预算。
const SEG_CACHE_TOTAL_BYTES: usize = 64 * 1024 * 1024;

/// 极简 LRU：HashMap + 访问序队列，get/put 摊还 O(1)。
/// `total_budget > 0` 时同时受总字节预算约束（按 put 传入的 size 计费）。
struct LruCache<V: Clone> {
    max_entries: usize,
    total_budget: usize,
    map: HashMap<String, (V, u64, usize)>,
    order: std::collections::VecDeque<String>,
    tick: u64,
    bytes_used: usize,
}

impl<V: Clone> LruCache<V> {
    fn new(max_entries: usize, total_budget: usize) -> Self {
        Self {
            max_entries,
            total_budget,
            map: HashMap::with_capacity(max_entries),
            order: std::collections::VecDeque::with_capacity(max_entries),
            tick: 0,
            bytes_used: 0,
        }
    }

    fn touch(&mut self, key: &str) {
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            self.order.remove(pos);
        }
        self.order.push_back(key.to_string());
    }

    fn get(&mut self, key: &str) -> Option<V> {
        let hit = self.map.get(key).map(|(v, _, _)| v.clone());
        if hit.is_some() {
            self.touch(key);
        }
        hit
    }

    /// 写入并按 LRU 淘汰。`size` 为该条目的计费字节（非预算缓存传 0）。
    fn put(&mut self, key: String, val: V, size: usize) {
        let stamp = self.tick;
        self.tick += 1;
        if let Some((_, _, old_size)) = self.map.remove(&key) {
            self.bytes_used -= old_size;
            self.touch(&key); // 把 key 移到队尾，避免淘汰循环误删
        }
        if self.total_budget > 0 {
            while self.bytes_used + size > self.total_budget {
                let Some(victim) = self.order.pop_front() else { break };
                if let Some((_, _, sz)) = self.map.remove(&victim) {
                    self.bytes_used -= sz;
                }
            }
        }
        while self.map.len() >= self.max_entries {
            let Some(victim) = self.order.pop_front() else { break };
            if victim == key {
                break;
            }
            if let Some((_, _, sz)) = self.map.remove(&victim) {
                self.bytes_used -= sz;
            }
        }
        self.bytes_used += size;
        self.order.push_back(key.clone());
        self.map.insert(key, (val, stamp, size));
    }

    fn clear(&mut self) {
        self.map.clear();
        self.order.clear();
        self.bytes_used = 0;
    }
}

/// 锁被 poison 时取回内部数据，避免一个线程 panic 后所有媒体请求连锁 panic。
fn cache_guard<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/* ───────────────────────── AES ───────────────────────── */

fn aes_cbc_decrypt(data: &[u8]) -> Option<Vec<u8>> {
    if data.is_empty() || data.len() % 16 != 0 {
        return None;
    }
    let cipher = Aes128::new_from_slice(IMG_KEY).ok()?;
    let mut prev = [0u8; 16];
    prev.copy_from_slice(IMG_IV);
    let mut out = Vec::with_capacity(data.len());
    for chunk in data.chunks(16) {
        let mut ct = [0u8; 16];
        ct.copy_from_slice(chunk);
        let mut block = ct;
        cipher.decrypt_block((&mut block).into());
        for i in 0..16 {
            out.push(block[i] ^ prev[i]);
        }
        prev = ct;
    }
    Some(out)
}

fn strip_padding(mut buf: Vec<u8>) -> Vec<u8> {
    let pad = *buf.last().unwrap_or(&0) as usize;
    if pad > 0 && pad <= 16 && buf.len() >= pad {
        if buf[buf.len() - pad..].iter().all(|b| *b as usize == pad) {
            buf.truncate(buf.len() - pad);
        }
    }
    buf
}

fn image_kind(buf: &[u8]) -> Option<&'static str> {
    if buf.len() < 12 {
        return None;
    }
    if buf[0] == 0xFF && buf[1] == 0xD8 {
        return Some("image/jpeg");
    }
    if buf.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return Some("image/png");
    }
    if buf.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    if buf.starts_with(b"RIFF") && &buf[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// 取封面：命中缓存直接返回，否则下载并按需解密；同一 URL 并发只下载一次。
pub async fn load_image(url: &str) -> Result<(String, Arc<Vec<u8>>), String> {
    if let Some(hit) = cache_guard(&IMG_CACHE).get(url) {
        let kind = image_kind(&hit).unwrap_or("image/jpeg");
        return Ok((kind.to_string(), hit));
    }
    let (leader, notify) = enter_in_flight(url).await;
    if leader {
        let result = download_image(url).await;
        leave_in_flight(url, &notify);
        if let Ok((_, arc)) = &result {
            cache_guard(&IMG_CACHE).put(url.to_string(), arc.clone(), 0);
        }
        result
    } else {
        // 等待者：等领导者唤醒后重查缓存；连续两次落空说明下载失败，放弃本次
        for _ in 0..2 {
            notify.notified().await;
            if let Some(hit) = cache_guard(&IMG_CACHE).get(url) {
                let kind = image_kind(&hit).unwrap_or("image/jpeg");
                return Ok((kind.to_string(), hit));
            }
        }
        Err("封面加载失败".to_string())
    }
}

async fn download_image(url: &str) -> Result<(String, Arc<Vec<u8>>), String> {
    let (_, bytes) = fetch_bytes(url).await?;
    let plain = if image_kind(&bytes).is_some() {
        bytes
    } else {
        let dec = aes_cbc_decrypt(&bytes).ok_or_else(|| "封面解密失败".to_string())?;
        strip_padding(dec)
    };
    let kind = image_kind(&plain).unwrap_or("image/jpeg").to_string();
    Ok((kind, Arc::new(plain)))
}

/* ───────────────────────── HLS ───────────────────────── */

fn enc(s: &str) -> String {
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

fn dec(s: &str) -> String {
    percent_decode_str(s).decode_utf8_lossy().to_string()
}

fn absolutize(base: &str, target: &str) -> String {
    if target.starts_with("http://") || target.starts_with("https://") {
        return target.to_string();
    }
    if let Ok(b) = url::Url::parse(base) {
        if let Ok(j) = b.join(target) {
            return j.to_string();
        }
    }
    target.to_string()
}

/// 属性列表中的引号内可含逗号，不能直接 split(',')。
fn hls_attributes(line: &str) -> Option<(&str, Vec<&str>)> {
    let (tag, rest) = line.split_once(':')?;
    let mut attributes = Vec::new();
    let mut quoted = false;
    let mut start = 0;
    for (i, ch) in rest.char_indices() {
        if ch == '"' {
            quoted = !quoted;
        }
        if ch == ',' && !quoted {
            attributes.push(&rest[start..i]);
            start = i + 1;
        }
    }
    attributes.push(&rest[start..]);
    Some((tag, attributes))
}

fn map_uri_attributes(line: &str, mut rewrite: impl FnMut(&str) -> String) -> String {
    let Some((tag, attributes)) = hls_attributes(line) else {
        return line.to_string();
    };
    let mapped: Vec<String> = attributes
        .into_iter()
        .map(|attribute| {
            if let Some((key, value)) = attribute.split_once('=') {
                if key.trim() == "URI" {
                    if let Some(uri) = value
                        .trim()
                        .strip_prefix('"')
                        .and_then(|v| v.strip_suffix('"'))
                    {
                        return format!("{key}=\"{}\"", rewrite(uri));
                    }
                }
            }
            attribute.to_string()
        })
        .collect();
    format!("{tag}:{}", mapped.join(","))
}

fn rewrite_uri_attr(line: &str, prefix: &str) -> String {
    map_uri_attributes(line, |uri| format!("{prefix}/seg?u={}", enc(uri)))
}

/// 取 m3u8 并把 key / 子列表 / 分片地址改写到本地协议；同一 URL 并发只下载一次。
pub async fn load_playlist(url: &str, prefix: &str) -> Result<Arc<String>, String> {
    let cache_key = format!("{prefix}|{url}");
    if let Some(hit) = cache_guard(&PL_CACHE).get(&cache_key) {
        return Ok(hit);
    }
    let (leader, notify) = enter_in_flight(&cache_key).await;
    if leader {
        let result = download_playlist(url, prefix).await;
        leave_in_flight(&cache_key, &notify);
        if let Ok(arc) = &result {
            cache_guard(&PL_CACHE).put(cache_key, arc.clone(), 0);
        }
        result
    } else {
        for _ in 0..2 {
            notify.notified().await;
            if let Some(hit) = cache_guard(&PL_CACHE).get(&cache_key) {
                return Ok(hit);
            }
        }
        Err("播放列表加载失败".to_string())
    }
}

async fn download_playlist(url: &str, prefix: &str) -> Result<Arc<String>, String> {
    let (_, bytes) = fetch_bytes(url).await?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "播放列表不是 UTF-8 文本")?;
    if !text.trim_start_matches('\u{feff}').starts_with("#EXTM3U") {
        return Err("响应不是 HLS 播放列表".into());
    }
    Ok(Arc::new(rewrite_playlist(url, text, prefix)))
}

fn rewrite_playlist(url: &str, text: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(text.len() + 512);
    for raw in text.trim_start_matches('\u{feff}').lines() {
        let line = raw.trim_end();
        if line.is_empty() {
            out.push('\n');
            continue;
        }
        if line.starts_with('#') {
            // 禁用可派生 URL 的内容引导；DATERANGE 保留时间线/SCTE-35 元数据。
            if line.starts_with("#EXT-X-CONTENT-STEERING:") {
                continue;
            }
            if line.starts_with("#EXT-X-DATERANGE:") {
                if let Some((tag, attributes)) = hls_attributes(line) {
                    let safe: Vec<&str> = attributes
                        .into_iter()
                        .filter(|attribute| {
                            let key = attribute
                                .split('=')
                                .next()
                                .unwrap_or("")
                                .trim()
                                .to_ascii_uppercase();
                            !key.contains("URI") && key != "X-ASSET-LIST"
                        })
                        .collect();
                    out.push_str(&format!("{tag}:{}\n", safe.join(",")));
                }
                continue;
            }
            if line.contains("URI=\"") {
                // KEY/MAP/MEDIA/SESSION-KEY/PART/PRELOAD-HINT 等 URI 都必须经过目标检查。
                let absolute = absolutize_uri_in_attr(url, line);
                out.push_str(&rewrite_uri_attr(&absolute, prefix));
            } else {
                out.push_str(line);
            }
        } else {
            let absolute = absolutize(url, line);
            out.push_str(&format!("{prefix}/seg?u={}", enc(&absolute)));
        }
        out.push('\n');
    }

    out
}

fn absolutize_uri_in_attr(base: &str, line: &str) -> String {
    map_uri_attributes(line, |uri| absolutize(base, uri))
}

/// 加载分片或 AES Key（带内存缓存与 single-flight，避免拖动进度条时并发重复拉取导致卡顿）。
pub async fn load_segment(url: &str) -> Result<(Option<String>, Arc<Vec<u8>>), String> {
    if let Some((ctype, hit)) = cache_guard(&KEY_CACHE).get(url) {
        return Ok((Some(ctype), hit));
    }
    if let Some((ctype, hit)) = cache_guard(&SEG_CACHE).get(url) {
        return Ok((Some(ctype), hit));
    }
    let (leader, notify) = enter_in_flight(url).await;
    if leader {
        let result = download_segment(url).await;
        leave_in_flight(url, &notify);
        if let Ok((mime, arc)) = &result {
            let len = arc.len();
            if len <= 65536 {
                cache_guard(&KEY_CACHE).put(url.to_string(), (mime.clone(), arc.clone()), 0);
            } else if len <= SEG_CACHE_MAX_BYTES {
                cache_guard(&SEG_CACHE).put(url.to_string(), (mime.clone(), arc.clone()), arc.len());
            }
        }
        result.map(|(mime, arc)| (Some(mime), arc))
    } else {
        for _ in 0..2 {
            notify.notified().await;
            if let Some((ctype, hit)) = cache_guard(&KEY_CACHE).get(url) {
                return Ok((Some(ctype), hit));
            }
            if let Some((ctype, hit)) = cache_guard(&SEG_CACHE).get(url) {
                return Ok((Some(ctype), hit));
            }
        }
        Err("分片加载失败".to_string())
    }
}

async fn download_segment(url: &str) -> Result<(String, Arc<Vec<u8>>), String> {
    let (ctype, bytes) = fetch_bytes(url).await?;
    let mime = ctype.unwrap_or_else(|| {
        let p = url.split('?').next().unwrap_or(url).to_ascii_lowercase();
        if p.ends_with(".ts") {
            "video/mp2t".to_string()
        } else if p.ends_with(".m4s") || p.ends_with(".mp4") {
            "video/mp4".to_string()
        } else {
            "application/octet-stream".to_string()
        }
    });
    Ok((mime, Arc::new(bytes)))
}

/// 清空封面 / 播放列表 / 分片内存缓存
pub fn clear_caches() {
    if let Ok(mut g) = IMG_CACHE.lock() { g.clear(); }
    if let Ok(mut g) = PL_CACHE.lock() { g.clear(); }
    if let Ok(mut g) = KEY_CACHE.lock() { g.clear(); }
    if let Ok(mut g) = SEG_CACHE.lock() { g.clear(); }
    if let Ok(mut g) = IN_FLIGHT.lock() { g.clear(); }
}

/* ── single-flight：同一 URL 的并发请求只下载一次 ─────────────────
   首页瀑布流 24 个封面、拖动进度条时同分片被 hls.js 并发请求，
   没有去重时 N 个请求各自 fetch_bytes（且每次带 3 次重试），放大明显。
   领导者负责下载，等待者被唤醒后重查缓存（重查在具体 load_* 内完成）。 */

type NotifyMap = HashMap<String, Arc<tokio::sync::Notify>>;
static IN_FLIGHT: Lazy<Mutex<NotifyMap>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// 返回 (是否领导者, 等待用的通知器)。等待者在 leader 完成后于 load_* 中重查缓存。
async fn enter_in_flight(key: &str) -> (bool, Arc<tokio::sync::Notify>) {
    loop {
        let existing = {
            let mut m = IN_FLIGHT.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(n) = m.get(key) {
                n.clone()
            } else {
                let n = Arc::new(tokio::sync::Notify::new());
                m.insert(key.to_string(), n.clone());
                return (true, n);
            }
        };
        existing.notified().await;
        // 醒来后可能登记已清空、也可能被新一批重新登记；回到循环重新判定角色
    }
}

/// 领导者完成（成功或失败）后调用：移除登记并唤醒等待者。
fn leave_in_flight(key: &str, notify: &Arc<tokio::sync::Notify>) {
    {
        let mut m = IN_FLIGHT.lock().unwrap_or_else(|p| p.into_inner());
        // 只有当前登记仍是自己的通知器时才移除，避免误删新一批的登记
        if m.get(key).is_some_and(|n| Arc::ptr_eq(n, notify)) {
            m.remove(key);
        }
    }
    notify.notify_waiters();
}

/* ───────────────────────── 协议响应 ───────────────────────── */

fn respond(status: u16, ctype: &str, body: Vec<u8>, cache: &str) -> Response<Vec<u8>> {
    let len = body.len().to_string();
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::OK))
        .header("Content-Type", ctype)
        .header("Content-Length", len)
        .header("Accept-Ranges", "bytes")
        .header("X-Content-Type-Options", "nosniff")
        .header("Access-Control-Expose-Headers", "Content-Length, Content-Type, Accept-Ranges")
        .header("Cache-Control", cache)
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// 主清单的子清单也经 /seg 返回：必须继续改写，不能把内层 URL 原样交给播放器。
fn segment_response(
    target: &str,
    ctype: Option<&str>,
    bytes: Vec<u8>,
    origin: &str,
) -> Response<Vec<u8>> {
    let playlist = ctype.is_some_and(|t| t.to_ascii_lowercase().contains("mpegurl"))
        || bytes.starts_with(b"#EXTM3U")
        || bytes.starts_with(b"\xef\xbb\xbf#EXTM3U");
    if playlist {
        return match std::str::from_utf8(&bytes) {
            Ok(text) => respond(
                200,
                "application/vnd.apple.mpegurl",
                rewrite_playlist(target, text, origin).into_bytes(),
                // Rewriting nested URIs does not require disabling the upstream cache policy.
                "public, max-age=3600",
            ),
            Err(_) => respond(
                502,
                "text/plain",
                b"invalid playlist encoding".to_vec(),
                "no-store",
            ),
        };
    }
    respond(
        200,
        ctype.unwrap_or("application/octet-stream"),
        bytes,
        "public, max-age=3600",
    )
}

/// 统一入口：`<LOCAL_ORIGIN>/img?u=` / `hls?u=` / `seg?u=`
///
/// `origin` 是本平台自定义协议的完整基址，见 [`LOCAL_ORIGIN`]；用于改写 m3u8 里的
/// 分片与 key 地址。正常情况下调用方直接传 [`LOCAL_ORIGIN`]。
pub async fn handle(path: &str, query: &str, origin: &str) -> Response<Vec<u8>> {
    let target = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("u="))
        .map(dec)
        .unwrap_or_default();

    if target.is_empty() {
        return respond(400, "text/plain", b"missing u".to_vec(), "no-store");
    }

    let started = std::time::Instant::now();
    let route = match path {
        "/img" => "image",
        "/hls" => "playlist",
        "/seg" => "segment_or_key",
        _ => "unknown",
    };
    crate::playback_log::record(
        "proxy.begin",
        serde_json::json!({"route": route, "resource": crate::playback_log::resource_id(&target)}),
    );
    let response = match path {
        "/img" => match load_image(&target).await {
            Ok((kind, bytes)) => {
                respond(200, &kind, bytes.as_ref().clone(), "public, max-age=86400")
            }
            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
        },
        "/hls" => match load_playlist(&target, origin).await {
            Ok(text) => respond(
                200,
                "application/vnd.apple.mpegurl",
                text.as_bytes().to_vec(),
                "no-store",
            ),
            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
        },
        "/seg" => match load_segment(&target).await {
            Ok((ctype, bytes)) => {
                segment_response(&target, ctype.as_deref(), bytes.as_ref().clone(), origin)
            }
            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
        },
        _ => respond(404, "text/plain", b"not found".to_vec(), "no-store"),
    };
    crate::playback_log::record(
        "proxy.end",
        serde_json::json!({"route": route, "resource": crate::playback_log::resource_id(&target), "status": response.status().as_u16(), "bytes": response.body().len(), "elapsed_ms": started.elapsed().as_millis() as u64}),
    );
    response
}

#[cfg(test)]
mod lru_tests {
    use super::*;

    #[test]
    fn lru_evicts_least_recently_used() {
        let mut c: LruCache<u32> = LruCache::new(2, 0);
        c.put("a".into(), 1, 0);
        c.put("b".into(), 2, 0);
        assert_eq!(c.get("a"), Some(1)); // a 变为最近使用
        c.put("c".into(), 3, 0); // 应淘汰 b 而不是 a
        assert_eq!(c.get("a"), Some(1));
        assert_eq!(c.get("b"), None);
        assert_eq!(c.get("c"), Some(3));
    }

    #[test]
    fn byte_budget_evicts_until_fit() {
        let mut c: LruCache<u32> = LruCache::new(8, 100);
        c.put("a".into(), 1, 60);
        c.put("b".into(), 2, 30);
        assert_eq!(c.bytes_used, 90);
        c.put("c".into(), 3, 50); // 超 100 预算：先淘汰 a(60) 后 30+50=80 可放
        assert_eq!(c.get("a"), None);
        assert_eq!(c.get("b"), Some(2));
        assert_eq!(c.get("c"), Some(3));
        assert_eq!(c.bytes_used, 80);
    }

    #[test]
    fn overwrite_recharges_without_extra_eviction() {
        let mut c: LruCache<u32> = LruCache::new(2, 0);
        c.put("a".into(), 1, 0);
        c.put("b".into(), 2, 0);
        c.put("a".into(), 10, 0); // 覆盖已有 key 不应淘汰
        assert_eq!(c.get("a"), Some(10));
        assert_eq!(c.get("b"), Some(2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dateranges_keep_timing_and_scte_metadata_but_drop_external_resources() {
        let line = "#EXTM3U\n#EXT-X-DATERANGE:ID=\"event\",START-DATE=\"2026-11-07T00:00:00Z\",DURATION=4,SCTE35-OUT=0xFC,X-TEXT=\"a,b\",X-ASSET-URI=\"https://evil.example/ad\",X-ASSET-LIST=\"https://evil.example/list.json\"\n";
        let out = rewrite_playlist("https://cdn.example/master.m3u8", line, LOCAL_ORIGIN);
        assert!(out.contains("DURATION=4,SCTE35-OUT=0xFC,X-TEXT=\"a,b\""));
        assert!(out.contains("START-DATE="));
        assert!(!out.contains("evil.example") && !out.contains("X-ASSET"));
    }

    #[test]
    fn every_uri_attribute_is_rewritten_without_splitting_quoted_commas() {
        let line = "#EXT-X-MEDIA:NAME=\"audio,main\",URI=\"first.m3u8\",URI=\"second.m3u8\"";
        let absolute = absolutize_uri_in_attr("https://cdn.example/master.m3u8", line);
        let rewritten = rewrite_uri_attr(&absolute, LOCAL_ORIGIN);
        assert_eq!(
            rewritten.matches(&format!("{LOCAL_ORIGIN}/seg?u=")).count(),
            2
        );
        assert!(rewritten.contains("NAME=\"audio,main\""));
        assert!(!rewritten.contains("URI=\"https://"));
    }

    #[test]
    fn nested_playlists_and_alternate_uris_stay_behind_proxy() {
        let text = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"audio/list.m3u8\"\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"http://127.0.0.1/key\"\n#EXT-X-PART:DURATION=1,URI=\"part.ts\"\nvariant/list.m3u8\n";
        let response = segment_response(
            "https://cdn.example/master.m3u8",
            Some("application/octet-stream"),
            text.as_bytes().to_vec(),
            LOCAL_ORIGIN,
        );
        let body = std::str::from_utf8(response.body()).unwrap();
        assert_eq!(body.matches(&format!("{LOCAL_ORIGIN}/seg?u=")).count(), 4);
        assert!(!body.contains("URI=\"http://127.0.0.1"));
        assert!(body.contains("https%3A%2F%2Fcdn%2Eexample%2Faudio%2Flist%2Em3u8"));
        assert_eq!(
            response.headers()["Content-Type"],
            "application/vnd.apple.mpegurl"
        );
        assert_eq!(response.headers()["X-Content-Type-Options"], "nosniff");
        assert!(!response
            .headers()
            .contains_key("Access-Control-Allow-Origin"));
        let optional = rewrite_playlist("https://cdn.example/list.m3u8",
            "#EXTM3U\n#EXT-X-CONTENT-STEERING:SERVER-URI=\"https://other.example/list.json\"\n#EXT-X-DATERANGE:ID=\"ad\",X-ASSET-LIST=\"http://127.0.0.1/assets\"\nsegment.ts\n", LOCAL_ORIGIN);
        assert!(!optional.contains("CONTENT-STEERING") && !optional.contains("X-ASSET-LIST"));
        assert!(optional.contains("#EXT-X-DATERANGE:ID=\"ad\""));
        let bom = segment_response(
            "https://cdn.example/list.m3u8",
            None,
            b"\xef\xbb\xbf#EXTM3U\nsegment.ts\n".to_vec(),
            LOCAL_ORIGIN,
        );
        assert!(bom.body().starts_with(b"#EXTM3U\n"));
    }

    /// 联网测试：默认跳过，手动跑 `cargo test --lib -- --ignored`。
    /// 依赖上游 `/api/videos/117/play` 返回的实时播放地址。
    #[tokio::test]
    #[ignore = "联网测试：依赖上游实时播放地址，手动用 --ignored 运行"]
    async fn live_play_chain() {
        use crate::net::edge;
        let play = edge(
            &crate::net::base(),
            "GET",
            "/api/videos/117/play?ep=3&page_texts=0",
            None,
            None,
        )
        .await
        .expect("play api");
        let url = play["video_url"].as_str().expect("video_url").to_string();
        println!("play url: {}", &url[..url.len().min(90)]);
        let (_, bytes) = fetch_bytes(&url).await.expect("fetch playlist");
        let text = String::from_utf8_lossy(&bytes);
        println!(
            "raw playlist len={} head={}",
            text.len(),
            &text[..text.len().min(160)]
        );
        let q = format!("u={}", enc(&url));
        let resp = handle("/hls", &q, LOCAL_ORIGIN).await;
        let body = String::from_utf8_lossy(resp.body()).to_string();
        println!("proxied status={} len={}", resp.status(), body.len());
        assert!(body.contains("#EXTM3U"));
        // 取一个分片验证
        let seg_line = body
            .lines()
            .find(|l| !l.starts_with('#') && l.contains("/seg?u="))
            .expect("seg line")
            .to_string();
        println!("seg line: {}", &seg_line[..seg_line.len().min(120)]);
        let seg_q = seg_line.split("?u=").nth(1).unwrap();
        let seg = handle("/seg", &format!("u={seg_q}"), LOCAL_ORIGIN).await;
        println!("segment status={} len={}", seg.status(), seg.body().len());
        assert_eq!(seg.status(), 200);
        assert!(seg.body().len() > 1000);
    }

    /// 离线回归：不再依赖带 auth_key 时效的真实上游地址（旧地址已过期，会 403）。
    /// 与真实播放列表同构：带签名的分片地址 + 加密 KEY + 相对路径分片。
    #[test]
    fn playlist_rewrite_works() {
        let base = "https://cdn.example/videos5/abc/abc.m3u8?auth_key=9999999999-0-0-deadbeef&v=3&via=hgdj";
        let text = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin?auth_key=9999999999-0-0-deadbeef\"\n#EXTINF:4,\nseg-1.ts?auth_key=9999999999-0-0-deadbeef\n";
        let body = rewrite_playlist(base, text, LOCAL_ORIGIN);

        assert!(body.contains("#EXTM3U"), "not a playlist: {body}");
        assert!(
            body.contains(&format!("{LOCAL_ORIGIN}/seg?u=")),
            "segments not rewritten: {body}"
        );
        // 分片必须绝对化到源站，并保留签名查询串。
        assert!(
            body.contains("https%3A%2F%2Fcdn%2Eexample%2Fvideos5%2Fabc%2Fseg%2D1%2Ets%3Fauth%5Fkey%3D"),
            "segment not absolutized with query: {body}"
        );
        // 加密 KEY 也要走本地代理，否则 hls.js 会直接打源站被 CORS 拦住。
        assert!(
            body.contains("URI=\"") && body.contains("%2Fkey%2Ebin%3Fauth%5Fkey%3D"),
            "key uri not rewritten: {body}"
        );
        assert!(!body.contains("URI=\"key.bin"), "key uri left relative");
    }

    /// 离线回归：用已知明文 + 项目内置 key/IV 构造密文，验证解密、去填充与类型识别。
    /// 真实封面抓取那条仍保留为 `#[ignore]` 联网测试。
    #[test]
    fn cover_decrypt_roundtrip() {
        use aes::cipher::BlockEncrypt;

        let plain = b"\xFF\xD8\xFF\xE0cover-payload-for-test".to_vec();
        let mut buf = plain.clone();
        let pad = 16 - plain.len() % 16;
        buf.extend(std::iter::repeat_n(pad as u8, pad));

        let cipher = Aes128::new_from_slice(IMG_KEY).expect("key");
        let mut prev = [0u8; 16];
        prev.copy_from_slice(IMG_IV);
        let mut encrypted = Vec::with_capacity(buf.len());
        for chunk in buf.chunks(16) {
            let mut block = [0u8; 16];
            block.copy_from_slice(chunk);
            for i in 0..16 {
                block[i] ^= prev[i];
            }
            let mut out_block = block;
            cipher.encrypt_block((&mut out_block).into());
            encrypted.extend_from_slice(&out_block);
            prev = out_block;
        }

        let decrypted = aes_cbc_decrypt(&encrypted).expect("decrypt");
        let stripped = strip_padding(decrypted);
        assert_eq!(stripped, plain);
        assert_eq!(image_kind(&stripped), Some("image/jpeg"));
    }

    /// 联网测试：默认跳过。封面地址带时效签名，不能硬编码进仓库，
    /// 需要用当次上游返回的地址显式传入：
    /// `HGHUB_TEST_COVER_URL='https://…?auth_key=…' cargo test --lib -- --ignored`
    #[tokio::test]
    #[ignore = "联网测试：需要 HGHUB_TEST_COVER_URL，手动用 --ignored 运行"]
    async fn cover_decrypt_works() {
        let url = std::env::var("HGHUB_TEST_COVER_URL")
            .expect("需要设置 HGHUB_TEST_COVER_URL 为当前有效的封面地址");
        match load_image(&url).await {
            Ok((kind, bytes)) => {
                println!("kind={kind} len={}", bytes.len());
                assert!(kind.starts_with("image/"));
            }
            Err(e) => panic!("image failed: {e}"),
        }
    }
}
