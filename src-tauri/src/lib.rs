use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

#[derive(Default)]
pub struct ScreenshotCache(pub Mutex<HashMap<String, String>>);

#[derive(Serialize)]
pub struct MonitorInfo {
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
fn get_monitors() -> Result<Vec<MonitorInfo>, String> {
    use xcap::Monitor;
    let monitors = Monitor::all().map_err(|e| e.to_string())?;
    let mut infos = Vec::new();
    for m in monitors {
        infos.push(MonitorInfo {
            name: m.name().map_err(|e| e.to_string())?,
            x: m.x().map_err(|e| e.to_string())?,
            y: m.y().map_err(|e| e.to_string())?,
            width: m.width().map_err(|e| e.to_string())?,
            height: m.height().map_err(|e| e.to_string())?,
        });
    }
    Ok(infos)
}

#[tauri::command]
fn capture_all_monitors(cache: State<'_, ScreenshotCache>) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use image::codecs::jpeg::JpegEncoder;
    use std::io::Cursor;
    use xcap::Monitor;

    let monitors = Monitor::all().map_err(|e| e.to_string())?;
    let mut screenshots = cache.0.lock().unwrap();
    screenshots.clear();

    for monitor in monitors {
        let name = monitor.name().map_err(|e| e.to_string())?;
        let image = monitor.capture_image().map_err(|e| e.to_string())?;

        // Convert RGBA → RGB (JPEG doesn't support alpha)
        let rgb_image = image::DynamicImage::ImageRgba8(image).to_rgb8();

        // Encode as JPEG quality 85 — ~10× faster than PNG, much smaller payload
        let mut buffer = Cursor::new(Vec::new());
        let mut encoder = JpegEncoder::new_with_quality(&mut buffer, 85);
        encoder.encode_image(&rgb_image).map_err(|e| e.to_string())?;

        let b64 = STANDARD.encode(buffer.into_inner());
        screenshots.insert(name, format!("data:image/jpeg;base64,{}", b64));
    }
    Ok(())
}


#[tauri::command]
fn get_monitor_capture(monitor_name: String, cache: State<'_, ScreenshotCache>) -> Result<String, String> {
    let screenshots = cache.0.lock().unwrap();
    screenshots.get(&monitor_name).cloned().ok_or("No capture found for monitor".to_string())
}

#[tauri::command]
fn debug_log(msg: String) {
    use std::io::{self, Write};
    println!("[FRONTEND DEBUG] {}", msg);
    let _ = io::stdout().flush();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {


    tauri::Builder::default()
        .manage(ScreenshotCache::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())

        .setup(|app| {
            use tauri::Manager;
            println!("[RUST SETUP] Starting Tauri setup...");
            let windows = app.webview_windows();
            println!("[RUST SETUP] Webview windows count: {}", windows.len());
            for (label, win) in &windows {
                println!("[RUST SETUP] Found window label: {}, is_visible: {:?}", label, win.is_visible());
                println!("[RUST SETUP] is_minimized: {:?}, is_maximized: {:?}, is_focused: {:?}", 
                    win.is_minimized(), win.is_maximized(), win.is_focused());
                println!("[RUST SETUP] outer_position: {:?}, inner_size: {:?}", 
                    win.outer_position(), win.inner_size());
                println!("[RUST SETUP] current_monitor: {:?}", win.current_monitor());
                #[cfg(target_os = "windows")]
                if let Ok(hwnd) = win.hwnd() {
                    println!("[RUST SETUP] Window HWND: {:?}, int: {}", hwnd, hwnd.0 as usize);
                }
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
            if windows.is_empty() {
                println!("[RUST SETUP] No windows configured or created! Attempting to create 'main' window manually...");
                let win_builder = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                    .title("Vajra")
                    .inner_size(800.0, 600.0)
                    .visible(true)
                    .center();
                match win_builder.build() {
                    Ok(w) => {
                        println!("[RUST SETUP] Successfully manually created main window!");
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                    Err(e) => {
                        eprintln!("[RUST SETUP] Failed to create main window: {}", e);
                    }
                }
            }
            if cfg!(debug_assertions) {
                let _ = app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                );
            }
            println!("[RUST SETUP] Setup completed successfully!");
            Ok(())
        })
        .on_window_event(|window, event| {
            println!("[WINDOW EVENT] {}: {:?}", window.label(), event);
        })
        .invoke_handler(tauri::generate_handler![get_monitors, capture_all_monitors, get_monitor_capture, debug_log])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
