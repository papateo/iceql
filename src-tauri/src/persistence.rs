use crate::models::ConnectionConfig;
use keyring::Entry;
use std::collections::HashSet;
use std::path::PathBuf;
use tauri::Manager;

const KEYCHAIN_SERVICE: &str = "com.iceql.sqlclient";

fn get_connections_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;
    std::fs::create_dir_all(&app_dir).map_err(|e| format!("Failed to create app dir: {e}"))?;
    Ok(app_dir.join("connections.json"))
}

fn keychain_entry(id: &str, field: &str) -> Option<Entry> {
    Entry::new(KEYCHAIN_SERVICE, &format!("{id}:{field}")).ok()
}

fn keychain_get(id: &str, field: &str) -> Option<String> {
    keychain_entry(id, field)?.get_password().ok()
}

// Best-effort: if the OS keychain is unavailable (e.g. no Secret Service
// running on Linux), fail silently rather than blocking the user from
// saving their connections. The password just won't survive a restart.
fn keychain_set(id: &str, field: &str, value: &str) {
    if let Some(entry) = keychain_entry(id, field) {
        let _ = entry.set_password(value);
    }
}

fn keychain_delete(id: &str, field: &str) {
    if let Some(entry) = keychain_entry(id, field) {
        let _ = entry.delete_credential();
    }
}

/// Loads connections from disk, filling in secrets (DB password, SSH
/// password/passphrase) from the OS keychain since they are never stored
/// in the JSON file itself.
///
/// Connections saved by older versions of the app may still have plaintext
/// secrets sitting in the JSON file (keychain lookup misses, so the value
/// parsed from disk is kept as-is). When that happens, the file is
/// immediately rewritten via `save` to migrate those secrets into the
/// keychain rather than waiting for the user to next edit a connection.
pub fn load(app: &tauri::AppHandle) -> Result<Vec<ConnectionConfig>, String> {
    let path = get_connections_file(app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read connections: {e}"))?;
    let mut connections: Vec<ConnectionConfig> =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse connections: {e}"))?;

    let mut needs_migration = false;
    for conn in &mut connections {
        match keychain_get(&conn.id, "password") {
            Some(password) => conn.password = password,
            None => needs_migration |= !conn.password.is_empty(),
        }
        if let Some(tunnel) = &mut conn.ssh_tunnel {
            match keychain_get(&conn.id, "ssh_password") {
                Some(password) => tunnel.password = Some(password),
                None => needs_migration |= tunnel.password.as_deref().is_some_and(|p| !p.is_empty()),
            }
            match keychain_get(&conn.id, "ssh_passphrase") {
                Some(passphrase) => tunnel.passphrase = Some(passphrase),
                None => needs_migration |= tunnel.passphrase.as_deref().is_some_and(|p| !p.is_empty()),
            }
        }
    }

    if needs_migration {
        save(app, &connections)?;
    }

    Ok(connections)
}

/// Persists connections to disk. Secrets are stripped out of the JSON and
/// stored in the OS keychain instead (Keychain on macOS, Credential Manager
/// on Windows, Secret Service on Linux), keyed by connection id.
pub fn save(app: &tauri::AppHandle, connections: &[ConnectionConfig]) -> Result<(), String> {
    let path = get_connections_file(app)?;

    // Drop keychain entries for connections that were removed, so deleting
    // a saved connection doesn't leave its secrets behind forever.
    let old_ids: Vec<String> = if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|c| serde_json::from_str::<Vec<ConnectionConfig>>(&c).ok())
            .map(|old| old.into_iter().map(|c| c.id).collect())
            .unwrap_or_default()
    } else {
        vec![]
    };
    let new_ids: HashSet<&str> = connections.iter().map(|c| c.id.as_str()).collect();
    for old_id in &old_ids {
        if !new_ids.contains(old_id.as_str()) {
            keychain_delete(old_id, "password");
            keychain_delete(old_id, "ssh_password");
            keychain_delete(old_id, "ssh_passphrase");
        }
    }

    // Stash each secret in the keychain (or remove it there if it was
    // cleared) and never write it to the JSON file on disk.
    let mut sanitized: Vec<ConnectionConfig> = connections.to_vec();
    for conn in &mut sanitized {
        if conn.password.is_empty() {
            keychain_delete(&conn.id, "password");
        } else {
            keychain_set(&conn.id, "password", &conn.password);
        }
        conn.password = String::new();

        if let Some(tunnel) = &mut conn.ssh_tunnel {
            match tunnel.password.as_deref() {
                Some(p) if !p.is_empty() => keychain_set(&conn.id, "ssh_password", p),
                _ => keychain_delete(&conn.id, "ssh_password"),
            }
            tunnel.password = None;

            match tunnel.passphrase.as_deref() {
                Some(p) if !p.is_empty() => keychain_set(&conn.id, "ssh_passphrase", p),
                _ => keychain_delete(&conn.id, "ssh_passphrase"),
            }
            tunnel.passphrase = None;
        }
    }

    let content = serde_json::to_string_pretty(&sanitized)
        .map_err(|e| format!("Failed to serialize connections: {e}"))?;
    std::fs::write(&path, content).map_err(|e| format!("Failed to write connections: {e}"))
}
