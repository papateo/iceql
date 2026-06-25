use crate::db::ConnectionPool;
use crate::models::{ColumnInfo, ConnectionConfig, QueryResult, TableInfo};
use crate::persistence;
use crate::ConnectionStore;
use crate::TransactionStore;
use uuid::Uuid;

#[tauri::command]
pub async fn test_connection(config: ConnectionConfig) -> Result<(), String> {
    let pool = ConnectionPool::connect(&config).await?;
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
        ConnectionPool::SQLite(p) => {
            sqlx::query("SELECT 1")
                .execute(p)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn connect(
    config: ConnectionConfig,
    state: tauri::State<'_, ConnectionStore>,
) -> Result<String, String> {
    let pool = ConnectionPool::connect(&config).await?;
    let connection_id = Uuid::new_v4().to_string();
    let mut store = state.lock().await;
    store.insert(connection_id.clone(), pool);
    Ok(connection_id)
}

#[tauri::command]
pub async fn disconnect(
    connection_id: String,
    state: tauri::State<'_, ConnectionStore>,
) -> Result<(), String> {
    let mut store = state.lock().await;
    store.remove(&connection_id);
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
pub async fn execute_query(
    connection_id: String,
    database: String,
    query: String,
    state: tauri::State<'_, ConnectionStore>,
) -> Result<QueryResult, String> {
    let store = state.lock().await;
    let pool = store
        .get(&connection_id)
        .ok_or_else(|| "Connection not found".to_string())?;
    pool.execute_query_in(&database, &query).await
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
            ConnectionPool::Postgres(_, cfg) => {
                crate::models::ConnectionConfig { db_type: "postgresql".to_string(), ..cfg.clone() }
            }
            ConnectionPool::MySQL(_, cfg) => {
                crate::models::ConnectionConfig { db_type: "mysql".to_string(), ..cfg.clone() }
            }
            ConnectionPool::SQLite(_) => {
                crate::models::ConnectionConfig {
                    id: String::new(),
                    name: String::new(),
                    db_type: "sqlite".to_string(),
                    host: String::new(),
                    port: 0,
                    username: String::new(),
                    password: String::new(),
                    database: database.clone(),
                    filename: Some(database.clone()),
                }
            }
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
    state: tauri::State<'_, ConnectionStore>,
) -> Result<QueryResult, String> {
    let store = state.lock().await;
    let pool = store
        .get(&connection_id)
        .ok_or_else(|| "Connection not found".to_string())?;
    pool.get_table_data(&database, &table, page, page_size).await
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
