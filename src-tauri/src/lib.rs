pub mod auth;
pub mod cli_config;
pub mod commands;
pub mod config;
pub mod db;
pub mod error;
pub mod knowledge;
pub mod mcp;
pub mod protocol;
pub mod provider;
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
            // 知识库向量索引固定放在 app_data_dir/kb/ 下
            let kb_dir = dir.join("kb");
            std::fs::create_dir_all(&kb_dir).ok();
            *state.kb_index_dir.write() = kb_dir;

            // 从 tauri-plugin-store 加载 fallback 并同步到 AppState
            if let Ok(store) = app.store("store.bin") {
                if let Some(value) = store.get("fallback") {
                    if let Some(obj) = value.as_object() {
                        let channel_id = obj
                            .get("channel_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let model = obj
                            .get("model")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        if !channel_id.is_empty() && !model.is_empty() {
                            *state.fallback.write() = Some((channel_id, model));
                        }
                    }
                }
            }

            // 从 tauri-plugin-store 加载安全设置并同步到 AppState
            let sec = security::get_security_settings(&app.handle());
            security::apply_settings(&state, &sec);

            // 从 tauri-plugin-store 加载整流器配置并同步到 AppState
            let rect = crate::proxy::rectifier::get_rectifier_config(&app.handle());
            crate::proxy::rectifier::apply_settings(&state, &rect);

            // 从 tauri-plugin-store 加载 RAG 设置并同步到 AppState
            let rag = knowledge::settings::get_rag_settings(&app.handle());
            knowledge::settings::apply_settings(&state, &rag);

            // 从 tauri-plugin-store 加载应用配置（首选端口）并同步到 AppState
            let appcfg = config::settings::get_app_config(&app.handle());
            config::settings::apply_settings(&state, &appcfg);

            // 启动时按保留天数清理日志（失败仅记录，不阻断启动）
            if let Ok(store) = app.store("store.bin") {
                if let Some(days) = store.get("log_retention_days").and_then(|v| v.as_i64()) {
                    if days > 0 {
                        let cutoff = chrono::Utc::now().timestamp() - days * 86400;
                        if let Err(e) = state.repo.delete_logs_before(cutoff) {
                            log::error!("log retention cleanup failed: {}", e);
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
            commands::config::spawn_gateway(&state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::channel::list_channels,
            commands::channel::create_channel,
            commands::channel::update_channel,
            commands::channel::delete_channel,
            commands::channel::test_channel,
            commands::channel::set_model_map,
            commands::channel::delete_model_map,
            commands::channel::get_model_map,
            commands::api_key::list_api_keys,
            commands::api_key::create_api_key,
            commands::api_key::set_api_key_enabled,
            commands::api_key::delete_api_key,
            commands::api_key::update_quota,
            commands::api_key::update_api_key,
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
            commands::log::get_log_stats,
            commands::log::get_log_timeseries,
            commands::log::delete_logs_before,
            commands::log::clear_logs,
            commands::log::set_log_retention_days,
            commands::log::get_log_retention_days,
            commands::stats::get_stats,
            commands::security::get_security_settings,
            commands::security::set_security_setting,
            commands::security::get_builtin_security_rules,
            commands::security::update_builtin_security_rule,
            commands::security::reset_builtin_security_rules,
            commands::security::get_custom_security_rules,
            commands::security::create_custom_security_rule,
            commands::security::toggle_custom_security_rule,
            commands::security::delete_custom_security_rule,
            commands::security::get_security_findings,
            commands::knowledge::create_kb,
            commands::knowledge::list_kbs,
            commands::knowledge::set_kb_status,
            commands::knowledge::rename_kb,
            commands::knowledge::update_kb_embedding_channel,
            commands::knowledge::delete_kb,
            commands::knowledge::reindex_kb,
            commands::knowledge::upload_document,
            commands::knowledge::list_documents,
            commands::knowledge::delete_document,
            commands::knowledge::search_kb,
            commands::knowledge::get_rag_settings,
            commands::knowledge::set_rag_setting,
            commands::config::export_config,
            commands::config::default_export_path,
            commands::config::preview_import,
            commands::config::import_config,
            commands::config::get_app_config,
            commands::config::set_preferred_port,
            commands::config::restart_gateway,
            commands::config::get_cli_targets,
            commands::config::write_cli_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
