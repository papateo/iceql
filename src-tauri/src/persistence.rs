use crate::models::ConnectionConfig;
use std::path::PathBuf;
use tauri::Manager;

fn get_connections_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;
    std::fs::create_dir_all(&app_dir).map_err(|e| format!("Failed to create app dir: {e}"))?;
    Ok(app_dir.join("connections.json"))
}

pub fn load(app: &tauri::AppHandle) -> Result<Vec<ConnectionConfig>, String> {
    let path = get_connections_file(app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read connections: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse connections: {e}"))
}

pub fn save(app: &tauri::AppHandle, connections: &[ConnectionConfig]) -> Result<(), String> {
    let path = get_connections_file(app)?;
    let content = serde_json::to_string_pretty(connections)
        .map_err(|e| format!("Failed to serialize connections: {e}"))?;
    std::fs::write(&path, content).map_err(|e| format!("Failed to write connections: {e}"))
}
