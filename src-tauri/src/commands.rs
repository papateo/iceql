use crate::db::ConnectionPool;
use crate::models::{ColumnInfo, ConnectionConfig, QueryResult, TableInfo};
use crate::persistence;
use crate::ssh_tunnel;
use crate::ConnectionStore;
use crate::QueryTaskStore;
use crate::TransactionStore;
use crate::TunnelStore;
use uuid::Uuid;

#[tauri::command]
pub async fn test_connection(config: ConnectionConfig) -> Result<(), String> {
    // The tunnel (if any) only needs to live for the duration of this test — dropped at the
    // end of the function, which tears it down.
    let (effective_config, _tunnel) = ssh_tunnel::resolve_effective_config(&config).await?;
    let pool = ConnectionPool::connect(&effective_config).await?;
    // Try a simple query to verify the connection is live
    match &pool {
        ConnectionPool::Postgres(p, _) => {
            sqlx::query("SELECT 1")
                .execute(p)
                .await
                .map_err(|e| e.to_string())?;
        }
        ConnectionPool::MySQL(p, _) => {
            sqlx::query("SELECT 1")
                .execute(p)
                .await
                .map_err(|e| e.to_string())?;
        }
        ConnectionPool::SQLite(p, _) | ConnectionPool::CSV(p, _) => {
            sqlx::query("SELECT 1")
                .execute(p)
                .await
                .map_err(|e| e.to_string())?;
        }
        ConnectionPool::Mongo(_, _) | ConnectionPool::Redis(_, _) => {
            // connect() already pings the server, so a successful connect is enough here.
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn connect(
    config: ConnectionConfig,
    state: tauri::State<'_, ConnectionStore>,
    tunnels: tauri::State<'_, TunnelStore>,
) -> Result<String, String> {
    let (effective_config, tunnel) = ssh_tunnel::resolve_effective_config(&config).await?;
    let pool = ConnectionPool::connect(&effective_config).await?;
    let connection_id = Uuid::new_v4().to_string();
    let mut store = state.lock().await;
    store.insert(connection_id.clone(), pool);
    // Keep the tunnel (if any) alive for as long as this connection stays open — dropped
    // (torn down) in `disconnect` below.
    if let Some(tunnel) = tunnel {
        tunnels.lock().await.insert(connection_id.clone(), tunnel);
    }
    Ok(connection_id)
}

#[tauri::command]
pub async fn disconnect(
    connection_id: String,
    state: tauri::State<'_, ConnectionStore>,
    tunnels: tauri::State<'_, TunnelStore>,
) -> Result<(), String> {
    let mut store = state.lock().await;
    store.remove(&connection_id);
    tunnels.lock().await.remove(&connection_id);
    Ok(())
}

#[tauri::command]
pub async fn get_databases(
    connection_id: String,
    state: tauri::State<'_, ConnectionStore>,
) -> Result<Vec<String>, String> {
    let store = state.lock().await;
    let pool = store
        .get(&connection_id)
        .ok_or_else(|| "Connection not found".to_string())?;
    pool.get_databases().await
}

#[tauri::command]
pub async fn get_tables(
    connection_id: String,
    database: String,
    state: tauri::State<'_, ConnectionStore>,
) -> Result<Vec<TableInfo>, String> {
    let store = state.lock().await;
    let pool = store
        .get(&connection_id)
        .ok_or_else(|| "Connection not found".to_string())?;
    pool.get_tables(&database).await
}

#[tauri::command]
pub async fn get_columns(
    connection_id: String,
    database: String,
    table: String,
    state: tauri::State<'_, ConnectionStore>,
) -> Result<Vec<ColumnInfo>, String> {
    let store = state.lock().await;
    let pool = store
        .get(&connection_id)
        .ok_or_else(|| "Connection not found".to_string())?;
    pool.get_columns(&database, &table).await
}

#[tauri::command]
pub async fn get_primary_keys(
    connection_id: String,
    database: String,
    table: String,
    state: tauri::State<'_, ConnectionStore>,
) -> Result<Vec<String>, String> {
    let store = state.lock().await;
    let pool = store
        .get(&connection_id)
        .ok_or_else(|| "Connection not found".to_string())?;
    pool.get_primary_keys(&database, &table).await
}

#[tauri::command]
pub async fn execute_query(
    connection_id: String,
    database: String,
    query: String,
    query_id: String,
    state: tauri::State<'_, ConnectionStore>,
    task_state: tauri::State<'_, QueryTaskStore>,
) -> Result<QueryResult, String> {
    // Clone the pool handle out (cheap — sqlx pools are Arc-backed) and drop the store
    // lock immediately, so the query runs without blocking every other connection.
    let pool = {
        let store = state.lock().await;
        store
            .get(&connection_id)
            .ok_or_else(|| "Connection not found".to_string())?
            .clone()
    };

    let task_store = task_state.inner().clone();
    let handle = tokio::spawn(async move { pool.execute_query_in(&database, &query).await });

    {
        let mut tasks = task_store.lock().await;
        tasks.insert(query_id.clone(), handle.abort_handle());
    }

    let result = handle.await;

    {
        let mut tasks = task_store.lock().await;
        tasks.remove(&query_id);
    }

    match result {
        Ok(query_result) => query_result,
        Err(e) if e.is_cancelled() => Err("Query cancelled".to_string()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn cancel_query(
    query_id: String,
    task_state: tauri::State<'_, QueryTaskStore>,
) -> Result<(), String> {
    let tasks = task_state.lock().await;
    if let Some(handle) = tasks.get(&query_id) {
        handle.abort();
    }
    Ok(())
}

#[tauri::command]
pub async fn begin_transaction(
    connection_id: String,
    database: String,
    state: tauri::State<'_, ConnectionStore>,
    tx_store: tauri::State<'_, TransactionStore>,
) -> Result<String, String> {
    let config = {
        let store = state.lock().await;
        let pool = store
            .get(&connection_id)
            .ok_or_else(|| "Connection not found".to_string())?;
        match pool {
            ConnectionPool::Postgres(_, cfg)
            | ConnectionPool::MySQL(_, cfg)
            | ConnectionPool::SQLite(_, cfg)
            | ConnectionPool::CSV(_, cfg)
            | ConnectionPool::Mongo(_, cfg)
            | ConnectionPool::Redis(_, cfg) => cfg.clone(),
        }
    };

    let tx_pool = ConnectionPool::connect_single(&config, &database).await?;
    tx_pool.execute_raw("BEGIN").await?;

    let tx_id = Uuid::new_v4().to_string();
    tx_store.0.lock().await.insert(tx_id.clone(), tx_pool);
    Ok(tx_id)
}

#[tauri::command]
pub async fn execute_in_transaction(
    transaction_id: String,
    query: String,
    tx_store: tauri::State<'_, TransactionStore>,
) -> Result<QueryResult, String> {
    let store = tx_store.0.lock().await;
    let pool = store
        .get(&transaction_id)
        .ok_or_else(|| "Transaction not found".to_string())?;
    pool.execute_raw(&query).await
}

#[tauri::command]
pub async fn commit_transaction(
    transaction_id: String,
    tx_store: tauri::State<'_, TransactionStore>,
) -> Result<QueryResult, String> {
    let mut store = tx_store.0.lock().await;
    let pool = store
        .get(&transaction_id)
        .ok_or_else(|| "Transaction not found".to_string())?;
    let result = pool.execute_raw("COMMIT").await?;
    store.remove(&transaction_id);
    Ok(result)
}

#[tauri::command]
pub async fn rollback_transaction(
    transaction_id: String,
    tx_store: tauri::State<'_, TransactionStore>,
) -> Result<QueryResult, String> {
    let mut store = tx_store.0.lock().await;
    let pool = store
        .get(&transaction_id)
        .ok_or_else(|| "Transaction not found".to_string())?;
    let result = pool.execute_raw("ROLLBACK").await?;
    store.remove(&transaction_id);
    Ok(result)
}

#[tauri::command]
pub async fn get_table_data(
    connection_id: String,
    database: String,
    table: String,
    page: i64,
    page_size: i64,
    sort_col: Option<String>,
    sort_dir: Option<String>,
    state: tauri::State<'_, ConnectionStore>,
) -> Result<QueryResult, String> {
    let store = state.lock().await;
    let pool = store
        .get(&connection_id)
        .ok_or_else(|| "Connection not found".to_string())?;
    pool.get_table_data(&database, &table, page, page_size, sort_col.as_deref(), sort_dir.as_deref())
        .await
}

#[tauri::command]
pub async fn connect_demo(
    state: tauri::State<'_, ConnectionStore>,
) -> Result<(String, ConnectionConfig), String> {
    let mut store = state.lock().await;
    // Reuse existing demo connection if already created
    if let Some(existing_id) = store.iter().find_map(|(id, pool)| {
        if let crate::db::ConnectionPool::SQLite(_, cfg) = pool {
            if cfg.id == "iceql-demo" { Some(id.clone()) } else { None }
        } else {
            None
        }
    }) {
        let config = match store.get(&existing_id).unwrap() {
            crate::db::ConnectionPool::SQLite(_, cfg) => cfg.clone(),
            _ => unreachable!(),
        };
        return Ok((existing_id, config));
    }
    let (pool, config) = crate::db::ConnectionPool::create_demo().await?;
    let connection_id = Uuid::new_v4().to_string();
    store.insert(connection_id.clone(), pool);
    Ok((connection_id, config))
}

#[tauri::command]
pub fn load_connections(app: tauri::AppHandle) -> Result<Vec<ConnectionConfig>, String> {
    persistence::load(&app)
}

#[tauri::command]
pub fn save_connections(
    app: tauri::AppHandle,
    connections: Vec<ConnectionConfig>,
) -> Result<(), String> {
    persistence::save(&app, &connections)
}

#[tauri::command]
pub async fn mongo_update_field(
    connection_id: String,
    database: String,
    collection: String,
    id_json: String,
    field: String,
    value_json: String,
    state: tauri::State<'_, ConnectionStore>,
) -> Result<(), String> {
    let store = state.lock().await;
    let pool = store
        .get(&connection_id)
        .ok_or_else(|| "Connection not found".to_string())?;
    pool.mongo_update_field(&database, &collection, &id_json, &field, &value_json)
        .await
}

#[tauri::command]
pub async fn mongo_delete_documents(
    connection_id: String,
    database: String,
    collection: String,
    id_jsons: Vec<String>,
    state: tauri::State<'_, ConnectionStore>,
) -> Result<u64, String> {
    let store = state.lock().await;
    let pool = store
        .get(&connection_id)
        .ok_or_else(|| "Connection not found".to_string())?;
    pool.mongo_delete_documents(&database, &collection, &id_jsons)
        .await
}

#[tauri::command]
pub async fn redis_update_field(
    connection_id: String,
    database: String,
    key: String,
    field: String,
    value_json: String,
    state: tauri::State<'_, ConnectionStore>,
) -> Result<(), String> {
    let store = state.lock().await;
    let pool = store
        .get(&connection_id)
        .ok_or_else(|| "Connection not found".to_string())?;
    pool.redis_update_field(&database, &key, &field, &value_json).await
}

#[tauri::command]
pub async fn redis_delete_keys(
    connection_id: String,
    database: String,
    keys: Vec<String>,
    state: tauri::State<'_, ConnectionStore>,
) -> Result<u64, String> {
    let store = state.lock().await;
    let pool = store
        .get(&connection_id)
        .ok_or_else(|| "Connection not found".to_string())?;
    pool.redis_delete_keys(&database, &keys).await
}
