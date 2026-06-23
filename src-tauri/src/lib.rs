mod commands;
mod db;
mod models;
mod persistence;

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use db::ConnectionPool;

pub type ConnectionStore = Arc<Mutex<HashMap<String, ConnectionPool>>>;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let connection_store: ConnectionStore = Arc::new(Mutex::new(HashMap::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(connection_store)
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                let bytes = include_bytes!("../icons/icon.png");
                let img = image::load_from_memory(bytes)
                    .map_err(|e| tauri::Error::Anyhow(e.into()))?
                    .into_rgba8();
                let width = img.width();
                let height = img.height();
                let icon = tauri::image::Image::new_owned(img.into_raw(), width, height);
                if let Some(window) = app.get_webview_window("main") {
                    window.set_icon(icon)?;
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::test_connection,
            commands::connect,
            commands::disconnect,
            commands::get_databases,
            commands::get_tables,
            commands::get_columns,
            commands::execute_query,
            commands::get_table_data,
            commands::load_connections,
            commands::save_connections,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
