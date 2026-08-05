pub mod auth;
pub mod db;
pub mod error;
pub mod provider;
pub mod protocol;
pub mod proxy;
pub mod router;

use db::Db;
use proxy::state::AppState;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("app_data_dir");
            std::fs::create_dir_all(&dir).ok();
            let db = Db::open(&dir.join("llm-gateway.db")).expect("open db");
            let state = AppState::new(db);
            app.manage(state.clone());

            // 启动网关（独立 tokio runtime 线程，避免阻塞 Tauri）
            std::thread::spawn(move || {
                let rt = tokio::runtime::Runtime::new().unwrap();
                rt.block_on(async move {
                    match proxy::server::start(state.clone(), 8777).await {
                        Ok(handle) => {
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
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
