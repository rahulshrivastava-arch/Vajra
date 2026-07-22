use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Emitter, State};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutEvent, ShortcutState};

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
    let ctrl_shift_s = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyS);

    tauri::Builder::default()
        .manage(ScreenshotCache::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts([ctrl_shift_s])
                .unwrap()
                .with_handler(
                    move |app: &tauri::AppHandle, shortcut: &Shortcut, event: ShortcutEvent| {
                        if shortcut == &ctrl_shift_s && event.state() == ShortcutState::Pressed {
                            let _ = app.emit("open-snipping-tool", ());
                        }
                    },
                )
                .build(),
        )
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_monitors, capture_all_monitors, get_monitor_capture, debug_log])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
