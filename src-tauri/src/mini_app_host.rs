/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Local Mini Apps: apps the agent writes on this computer, served straight off
//! disk on `tbapp://<id>/`.
//!
//! Every request reads the file again, so an edit shows up on the next reload and a
//! new app is reachable the moment its folder exists — no dev server, no backend
//! registry, no restart. The host of the URL is the app id, which gives each app
//! its own origin on macOS and Linux; the frame's `allow-same-origin` is only safe
//! because of that. Windows maps custom schemes onto one shared
//! `http://tbapp.localhost` origin and is not supported yet.

use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime};

pub const SCHEME: &str = "tbapp";
const MANIFEST: &str = "miniapp.json";
const SDK_PATH: &str = "/__thunderbolt/sdk.js";
/// Built from `miniapps/sdk/src/local-entry.ts` by `bun run build:miniapp-sdk`.
const SDK_SOURCE: &str = include_str!("../resources/miniapp-sdk.js");
const HOST_ORIGIN_PLACEHOLDER: &str = "__THUNDERBOLT_HOST_ORIGIN__";

const STARTER_HTML: &str = include_str!("../resources/miniapp-starter/index.html");
const STARTER_JS: &str = include_str!("../resources/miniapp-starter/app.js");

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<u64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalMiniApp {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    /// Absolute folder the agent edits.
    pub path: String,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn apps_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("mini-apps");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root)
}

/// Ids are URL hosts and folder names, so they stay lowercase ASCII.
fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn slugify(name: &str) -> String {
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let slug = slug
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let slug: String = slug.chars().take(40).collect();
    if slug.is_empty() {
        "app".into()
    } else {
        slug
    }
}

fn read_manifest(dir: &Path) -> Option<Manifest> {
    let text = std::fs::read_to_string(dir.join(MANIFEST)).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_manifest(dir: &Path, manifest: &Manifest) -> Result<(), String> {
    let text = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(MANIFEST), text).map_err(|e| e.to_string())
}

fn to_local_app(id: String, dir: &Path, manifest: Manifest) -> LocalMiniApp {
    LocalMiniApp {
        id,
        name: manifest.name,
        description: manifest.description,
        icon: manifest.icon,
        path: dir.to_string_lossy().into_owned(),
    }
}

fn list_in(root: &Path) -> Vec<LocalMiniApp> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut apps: Vec<LocalMiniApp> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let id = entry.file_name().to_string_lossy().into_owned();
            let dir = entry.path();
            if !is_valid_id(&id) || !dir.is_dir() {
                return None;
            }
            let manifest = read_manifest(&dir)?;
            if manifest.deleted_at.is_some() {
                return None;
            }
            Some(to_local_app(id, &dir, manifest))
        })
        .collect();
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps
}

/// A starter nobody has touched yet: same name, and both files exactly as created.
fn is_untouched_starter(dir: &Path, manifest: &Manifest, name: &str) -> bool {
    let unchanged = |file: &str, expected: &str| {
        std::fs::read_to_string(dir.join(file)).is_ok_and(|c| c == expected)
    };
    manifest.name == name
        && unchanged("index.html", &STARTER_HTML.replace("{{name}}", name))
        && unchanged("app.js", STARTER_JS)
}

fn create_in(root: &Path, name: &str, description: &str) -> Result<LocalMiniApp, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("A Mini App needs a name".into());
    }
    // Reuse an empty starter rather than stacking another identical entry in the sidebar.
    let untouched = list_in(root).into_iter().find(|app| {
        let dir = Path::new(&app.path);
        read_manifest(dir).is_some_and(|m| is_untouched_starter(dir, &m, name))
    });
    if let Some(app) = untouched {
        return Ok(app);
    }
    let id = format!("{}-{:x}", slugify(name), now_millis());
    let dir = root.join(&id);
    std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
    let manifest = Manifest {
        name: name.to_string(),
        description: description.trim().to_string(),
        icon: "app-window".into(),
        deleted_at: None,
    };
    write_manifest(&dir, &manifest)?;
    std::fs::write(
        dir.join("index.html"),
        STARTER_HTML.replace("{{name}}", &manifest.name),
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(dir.join("app.js"), STARTER_JS).map_err(|e| e.to_string())?;
    Ok(to_local_app(id, &dir, manifest))
}

/// Soft delete: the folder and the user's files stay, the manifest is tombstoned.
fn delete_in(root: &Path, id: &str) -> Result<(), String> {
    if !is_valid_id(id) {
        return Err("Unknown Mini App".into());
    }
    let dir = root.join(id);
    let mut manifest = read_manifest(&dir).ok_or("Unknown Mini App")?;
    manifest.deleted_at = Some(now_millis());
    write_manifest(&dir, &manifest)
}

#[tauri::command]
pub fn mini_apps_list(webview: tauri::Webview) -> Result<Vec<LocalMiniApp>, String> {
    crate::agent_execution::require_main(&webview)?;
    Ok(list_in(&apps_root(webview.app_handle())?))
}

#[tauri::command]
pub fn mini_apps_create(
    webview: tauri::Webview,
    name: String,
    description: Option<String>,
) -> Result<LocalMiniApp, String> {
    crate::agent_execution::require_main(&webview)?;
    create_in(
        &apps_root(webview.app_handle())?,
        &name,
        &description.unwrap_or_default(),
    )
}

#[tauri::command]
pub fn mini_apps_delete(webview: tauri::Webview, id: String) -> Result<(), String> {
    crate::agent_execution::require_main(&webview)?;
    delete_in(&apps_root(webview.app_handle())?, &id)
}

/// The main webview's origin, the only page allowed to frame an app.
///
/// Built by hand because the `url` crate reports custom schemes like
/// `tauri://localhost` as opaque (`"null"`), which no browser would match.
fn host_origin<R: Runtime>(app: &AppHandle<R>) -> String {
    let Some(url) = app.get_webview_window("main").and_then(|w| w.url().ok()) else {
        return "tauri://localhost".into();
    };
    let host = url.host_str().unwrap_or("localhost");
    match url.port() {
        Some(port) => format!("{}://{}:{}", url.scheme(), host, port),
        None => format!("{}://{}", url.scheme(), host),
    }
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "wasm" => "application/wasm",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Resolve a request path inside the app folder, refusing anything that could climb out.
fn resolve_file(app_dir: &Path, request_path: &str) -> Option<PathBuf> {
    let relative = Path::new(request_path.trim_start_matches('/'));
    if relative
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return None;
    }
    let candidate = app_dir.join(relative);
    let file = if candidate.is_dir() {
        candidate.join("index.html")
    } else {
        candidate
    };
    file.is_file().then_some(file)
}

fn respond(
    status: StatusCode,
    mime: &str,
    body: Vec<u8>,
    frame_ancestors: &str,
) -> Response<Vec<u8>> {
    // Same three headers a deployed Mini App must send (docs/internals/architecture/mini-apps.md),
    // plus a CSP that keeps the page on its own files while still allowing HTTPS APIs.
    let csp = format!(
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; \
         img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https:; \
         base-uri 'none'; form-action 'none'; frame-ancestors {frame_ancestors}"
    );
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-store")
        .header("Content-Security-Policy", csp)
        .header("Cross-Origin-Embedder-Policy", "credentialless")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .header("X-Content-Type-Options", "nosniff")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn serve<R: Runtime>(app: &AppHandle<R>, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let origin = host_origin(app);
    let not_found = || {
        respond(
            StatusCode::NOT_FOUND,
            "text/plain",
            b"Not found".to_vec(),
            &origin,
        )
    };
    let id = request.uri().host().unwrap_or_default();
    let path = request.uri().path();
    if path == SDK_PATH {
        let sdk = SDK_SOURCE.replace(HOST_ORIGIN_PLACEHOLDER, &origin);
        return respond(
            StatusCode::OK,
            "text/javascript; charset=utf-8",
            sdk.into_bytes(),
            &origin,
        );
    }
    let Ok(root) = apps_root(app) else {
        return not_found();
    };
    let app_dir = root.join(id);
    let live = is_valid_id(id) && read_manifest(&app_dir).is_some_and(|m| m.deleted_at.is_none());
    let Some(file) = live.then(|| resolve_file(&app_dir, path)).flatten() else {
        return not_found();
    };
    match std::fs::read(&file) {
        Ok(bytes) => respond(StatusCode::OK, content_type(&file), bytes, &origin),
        Err(_) => not_found(),
    }
}

/// Register the `tbapp://` handler on the app builder.
pub fn register<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol(SCHEME, |ctx, request, responder| {
        let app = ctx.app_handle().clone();
        tauri::async_runtime::spawn_blocking(move || responder.respond(serve(&app, &request)));
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_and_ids() {
        assert_eq!(slugify("My Finance App!"), "my-finance-app");
        assert_eq!(slugify("***"), "app");
        assert!(is_valid_id("my-app-18f"));
        assert!(!is_valid_id("../etc"));
        assert!(!is_valid_id("My-App"));
    }

    #[test]
    fn create_list_and_soft_delete() {
        let root = tempfile::tempdir().unwrap();
        let app = create_in(root.path(), "Order Tracker", "Tracks orders").unwrap();
        assert!(app.id.starts_with("order-tracker-"));
        assert!(Path::new(&app.path).join("index.html").is_file());
        let listed = list_in(root.path());
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Order Tracker");

        // An untouched starter is reused instead of duplicated...
        assert_eq!(
            create_in(root.path(), "Order Tracker", "").unwrap().id,
            app.id
        );
        // ...but once the agent has written to it, a new one is made.
        std::fs::write(Path::new(&app.path).join("app.js"), "// built").unwrap();
        let second = create_in(root.path(), "Order Tracker", "").unwrap();
        assert_ne!(second.id, app.id);
        delete_in(root.path(), &second.id).unwrap();

        delete_in(root.path(), &app.id).unwrap();
        assert!(list_in(root.path()).is_empty());
        // Soft delete keeps the user's files.
        assert!(Path::new(&app.path).join("app.js").is_file());
    }

    #[test]
    fn resolve_refuses_traversal() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("index.html"), "hi").unwrap();
        assert!(resolve_file(root.path(), "/").is_some());
        assert!(resolve_file(root.path(), "/index.html").is_some());
        assert!(resolve_file(root.path(), "/../secret").is_none());
        assert!(resolve_file(root.path(), "/missing.js").is_none());
    }
}
