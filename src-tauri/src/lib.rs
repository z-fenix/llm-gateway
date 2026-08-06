pub mod auth;
pub mod commands;
pub mod db;
pub mod error;
pub mod provider;
pub mod protocol;
pub mod proxy;
pub mod router;
pub mod security;

use db::Db;
use proxy::state::AppState;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
use tauri_plugin_store::StoreExt;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("app_data_dir");
            std::fs::create_dir_all(&dir).ok();
            let db = Db::open(&dir.join("llm-gateway.db")).expect("open db");
            let state = AppState::new(db);

            // 从 tauri-plugin-store 加载 fallback 并同步到 AppState
            if let Ok(store) = app.store("store.bin") {
                if let Some(value) = store.get("fallback") {
                    if let Some(obj) = value.as_object() {
                        let channel_id = obj.get("channel_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let model = obj.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        if !channel_id.is_empty() && !model.is_empty() {
                            *state.fallback.write().unwrap() = Some((channel_id, model));
                        }
                    }
                }
            }

            app.manage(state.clone());

            // 系统托盘：退出 + 点击显示窗口
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&quit_item])?;
            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                .on_menu_event(|app, event| {
                    if event.id.as_ref() == "quit" {
                        app.exit(0);
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            if let Err(e) = tray_builder.build(app) {
                log::warn!("failed to create system tray: {}", e);
            }

            // 启动网关（独立 tokio runtime 线程，避免阻塞 Tauri）
            std::thread::spawn(move || {
                let rt = tokio::runtime::Runtime::new().unwrap();
                rt.block_on(async move {
                    match proxy::server::start(state.clone(), 8777).await {
                        Ok((handle, _addr)) => {
                            handle.await.expect("serve gateway");
                        }
                        Err(e) => {
                            log::error!("no available port in 8777..=8787: {}", e);
                        }
                    }
                });
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::channel::list_channels,
            commands::channel::create_channel,
            commands::channel::update_channel,
            commands::channel::delete_channel,
            commands::channel::test_channel,
            commands::api_key::list_api_keys,
            commands::api_key::create_api_key,
            commands::api_key::set_api_key_enabled,
            commands::api_key::delete_api_key,
            commands::api_key::update_quota,
            commands::role_route::list_role_routes,
            commands::role_route::set_role_route,
            commands::role_route::delete_role_route,
            commands::role_route::list_role_patterns,
            commands::role_route::upsert_role_pattern,
            commands::role_route::delete_role_pattern,
            commands::role_route::get_fallback,
            commands::role_route::set_fallback,
            commands::role_route::clear_fallback,
            commands::log::list_logs,
            commands::stats::get_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
