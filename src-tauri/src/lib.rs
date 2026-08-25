mod commands;
mod db;
mod models;
mod mqtt;
mod persistence;
mod ssh_tunnel;

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use db::ConnectionPool;

pub type ConnectionStore = Arc<Mutex<HashMap<String, ConnectionPool>>>;

// Keyed by the same connection id as ConnectionStore — holds each connection's live SSH
// tunnel (if any) alive for as long as the connection is open. Dropping an entry (on
// disconnect) tears the tunnel down.
pub type TunnelStore = Arc<Mutex<HashMap<String, ssh_tunnel::SshTunnel>>>;

// Keyed by connection id — holds each open MQTT connection alive and lets commands reach its
// client to subscribe/unsubscribe/publish.
pub type MqttStore = Arc<Mutex<HashMap<String, mqtt::MqttConnection>>>;

// Tracks the abort handle for each in-flight query, keyed by the frontend-generated
// query id, so a running query can be cancelled from a separate command invocation.
pub type QueryTaskStore = Arc<Mutex<HashMap<String, tokio::task::AbortHandle>>>;

pub struct TransactionStore(pub Arc<Mutex<HashMap<String, ConnectionPool>>>);

impl TransactionStore {
    pub fn new() -> Self {
        TransactionStore(Arc::new(Mutex::new(HashMap::new())))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let connection_store: ConnectionStore = Arc::new(Mutex::new(HashMap::new()));
    let transaction_store = TransactionStore::new();
    let query_task_store: QueryTaskStore = Arc::new(Mutex::new(HashMap::new()));
    let tunnel_store: TunnelStore = Arc::new(Mutex::new(HashMap::new()));
    let mqtt_store: MqttStore = Arc::new(Mutex::new(HashMap::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(connection_store)
        .manage(transaction_store)
        .manage(query_task_store)
        .manage(tunnel_store)
        .manage(mqtt_store)
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                use tauri::menu::{AboutMetadataBuilder, MenuBuilder, SubmenuBuilder};

                let bytes = include_bytes!("../icons/icon.png");
                let img = image::load_from_memory(bytes)
                    .map_err(|e| tauri::Error::Anyhow(e.into()))?
                    .into_rgba8();
                let width = img.width();
                let height = img.height();
                let icon = tauri::image::Image::new_owned(img.into_raw(), width, height);

                if let Some(window) = app.get_webview_window("main") {
                    window.set_icon(icon.clone())?;
                }

                let about_metadata = AboutMetadataBuilder::new()
                    .icon(Some(icon))
                    .build();

                let app_menu = SubmenuBuilder::new(app, "IceQL")
                    .about(Some(about_metadata))
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;

                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;

                let menu = MenuBuilder::new(app)
                    .item(&app_menu)
                    .item(&edit_menu)
                    .build()?;

                app.set_menu(menu)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::test_connection,
            commands::connect,
            commands::connect_demo,
            commands::disconnect,
            commands::get_databases,
            commands::get_tables,
            commands::get_columns,
            commands::get_primary_keys,
            commands::execute_query,
            commands::cancel_query,
            commands::get_table_data,
            commands::load_connections,
            commands::save_connections,
            commands::begin_transaction,
            commands::execute_in_transaction,
            commands::commit_transaction,
            commands::rollback_transaction,
            commands::mongo_update_field,
            commands::mongo_delete_documents,
            commands::redis_update_field,
            commands::redis_delete_keys,
            commands::mqtt_connect,
            commands::mqtt_disconnect,
            commands::mqtt_subscribe,
            commands::mqtt_unsubscribe,
            commands::mqtt_publish,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
