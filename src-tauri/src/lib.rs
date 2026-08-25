pub mod auth;
pub mod cli_config;
pub mod commands;
pub mod config;
pub mod db;
pub mod error;
pub mod knowledge;
pub mod mcp;
pub mod mcp_client;
pub mod protocol;
pub mod provider;
pub mod proxy;
pub mod router;
pub mod security;
pub mod session_manager;

use db::Db;
use proxy::state::AppState;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};
use tauri_plugin_store::StoreExt;

/// 显示并聚焦主窗口（托盘点击 / 托盘菜单“显示主窗口”共用）。
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("app_data_dir");
            std::fs::create_dir_all(&dir).ok();
            let db = Db::open(&dir.join("llm-gateway.db")).expect("open db");
            let mut state = AppState::new(db);
            // 密钥加密：优先系统凭据库主密钥（Windows 凭据管理器），不可用时降级进程内随机。
            let cipher = std::sync::Arc::new(security::crypto::Cipher::keyring_load_or_create());
            state.repo.set_cipher(cipher);
            if let Err(e) = state.repo.migrate_plaintext_keys() {
                log::error!("plaintext key migration failed: {e}");
            }
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

            // 启动时重连启用中的 MCP server（尽力而为，失败仅记录，不阻塞启动/不等待握手）
            let mcp_state = state.clone();
            tauri::async_runtime::spawn(async move {
                commands::mcp_server::reconnect_enabled(&mcp_state).await;
            });

            // 系统托盘：显示主窗口 + 退出；点击托盘图标同样显示窗口
            let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                .on_menu_event(|app, event| {
                    if event.id.as_ref() == "show" {
                        show_main_window(app);
                    } else if event.id.as_ref() == "quit" {
                        app.exit(0);
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        show_main_window(tray.app_handle());
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
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 关闭时最小化到托盘（默认开启，可在设置中关闭）
                let minimize = window
                    .app_handle()
                    .try_state::<AppState>()
                    .map(|st| {
                        // parking_lot 读写锁不中毒，但 try_read 可避免写锁占用时阻塞关闭回调
                        st.app
                            .try_read()
                            .map(|cfg| cfg.minimize_to_tray)
                            .unwrap_or(false)
                    })
                    .unwrap_or(false);
                if minimize {
                    api.prevent_close();
                    // 托盘创建失败（启动时已记 warn）时窗口将无托可还原，这里再提示一次
                    if window.app_handle().tray_by_id("main").is_none() {
                        log::warn!(
                            "hiding window to tray on close but no system tray is available; window may be unreachable"
                        );
                    }
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::channel::list_channels,
            commands::channel::create_channel,
            commands::channel::update_channel,
            commands::channel::delete_channel,
            commands::channel::duplicate_channel,
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
            commands::role_route::upsert_role_route,
            commands::role_route::delete_role_route,
            commands::role_route::get_breaker_status,
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
            commands::prompt::list_prompts,
            commands::prompt::upsert_prompt,
            commands::prompt::delete_prompt,
            commands::prompt::enable_prompt,
            commands::prompt::get_enabled_prompt,
            commands::skill::list_skills,
            commands::skill::upsert_skill,
            commands::skill::delete_skill,
            commands::skill::toggle_skill_enabled,
            commands::skill::list_installed_skills,
            commands::skill::import_installed_skill,
            commands::skill::sync_skill_mcp,
            commands::stats::get_stats,
            commands::stats::get_role_stats,
            commands::pricing::list_model_prices,
            commands::pricing::upsert_model_price,
            commands::pricing::delete_model_price,
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
            commands::session::list_sessions,
            commands::session::get_session_messages,
            commands::session::delete_session,
            commands::rectifier::get_rectifier_config,
            commands::rectifier::set_rectifier_config,
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
            commands::mcp_server::list_mcp_servers,
            commands::mcp_server::upsert_mcp_server,
            commands::mcp_server::delete_mcp_server,
            commands::mcp_server::toggle_mcp_server_enabled,
            commands::mcp_server::connect_mcp_server,
            commands::mcp_server::disconnect_mcp_server,
            commands::mcp_server::test_mcp_connection,
            commands::config::export_config,
            commands::config::default_export_path,
            commands::config::preview_import,
            commands::config::import_config,
            commands::config::get_app_config,
            commands::config::set_preferred_port,
            commands::config::set_minimize_to_tray,
            commands::config::restart_gateway,
            commands::config::get_cli_targets,
            commands::config::write_cli_config,
            commands::config::merge_gateway_env,
            commands::cli::read_cli_config,
            commands::cli::write_cli_config_content,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
