use crate::models::{ColumnInfo, ConnectionConfig, QueryResult, TableInfo};
use sqlx::Column;
use sqlx::TypeInfo;
use std::time::Instant;

pub enum ConnectionPool {
    Postgres(sqlx::PgPool, ConnectionConfig),
    MySQL(sqlx::MySqlPool),
    SQLite(sqlx::SqlitePool),
}

impl ConnectionPool {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self, String> {
        match config.db_type.as_str() {
            "postgresql" => {
                let url = format!(
                    "postgres://{}:{}@{}:{}/{}",
                    urlencoding_simple(&config.username),
                    urlencoding_simple(&config.password),
                    config.host,
                    config.port,
                    config.database
                );
                let pool = sqlx::PgPool::connect(&url)
                    .await
                    .map_err(|e| format!("PostgreSQL connection failed: {e}"))?;
                Ok(ConnectionPool::Postgres(pool, config.clone()))
            }
            "mysql" => {
                let url = format!(
                    "mysql://{}:{}@{}:{}/{}",
                    urlencoding_simple(&config.username),
                    urlencoding_simple(&config.password),
                    config.host,
                    config.port,
                    config.database
                );
                let pool = sqlx::MySqlPool::connect(&url)
                    .await
                    .map_err(|e| format!("MySQL connection failed: {e}"))?;
                Ok(ConnectionPool::MySQL(pool))
            }
            "sqlite" => {
                let path = config
                    .filename
                    .as_deref()
                    .unwrap_or(&config.database);
                let url = format!("sqlite:{path}");
                let pool = sqlx::SqlitePool::connect(&url)
                    .await
                    .map_err(|e| format!("SQLite connection failed: {e}"))?;
                Ok(ConnectionPool::SQLite(pool))
            }
            other => Err(format!("Unsupported database type: {other}")),
        }
    }

    pub async fn get_databases(&self) -> Result<Vec<String>, String> {
        match self {
            ConnectionPool::Postgres(pool, _) => {
                let rows = sqlx::query("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname")
                    .fetch_all(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(rows
                    .iter()
                    .map(|r| {
                        use sqlx::Row;
                        r.get::<String, _>("datname")
                    })
                    .collect())
            }
            ConnectionPool::MySQL(pool) => {
                let rows = sqlx::query("SHOW DATABASES")
                    .fetch_all(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(rows
                    .iter()
                    .map(|r| {
                        use sqlx::Row;
                        r.get::<String, _>(0)
                    })
                    .collect())
            }
            ConnectionPool::SQLite(_) => {
                // SQLite doesn't have multiple databases; return "main"
                Ok(vec!["main".to_string()])
            }
        }
    }

    pub async fn get_tables(&self, database: &str) -> Result<Vec<TableInfo>, String> {
        match self {
            ConnectionPool::Postgres(pool, config) => {
                // PostgreSQL can't switch databases in-session; create a new connection to the target db
                let target_pool;
                let pool_ref: &sqlx::PgPool = if database == config.database {
                    pool
                } else {
                    let url = format!(
                        "postgres://{}:{}@{}:{}/{}",
                        urlencoding_simple(&config.username),
                        urlencoding_simple(&config.password),
                        config.host,
                        config.port,
                        database
                    );
                    target_pool = sqlx::PgPool::connect(&url).await.map_err(|e| e.to_string())?;
                    &target_pool
                };
                let rows = sqlx::query(
                    "SELECT table_name, table_type FROM information_schema.tables \
                     WHERE table_schema = 'public' ORDER BY table_name",
                )
                .fetch_all(pool_ref)
                .await
                .map_err(|e| e.to_string())?;
                Ok(rows
                    .iter()
                    .map(|r| {
                        use sqlx::Row;
                        TableInfo {
                            name: r.get("table_name"),
                            table_type: r.get("table_type"),
                        }
                    })
                    .collect())
            }
            ConnectionPool::MySQL(pool) => {
                let rows = sqlx::query(
                    "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES \
                     WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
                )
                .bind(database)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;
                Ok(rows
                    .iter()
                    .map(|r| {
                        use sqlx::Row;
                        TableInfo {
                            name: r.get("TABLE_NAME"),
                            table_type: r.get("TABLE_TYPE"),
                        }
                    })
                    .collect())
            }
            ConnectionPool::SQLite(pool) => {
                let rows = sqlx::query(
                    "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name",
                )
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;
                Ok(rows
                    .iter()
                    .map(|r| {
                        use sqlx::Row;
                        TableInfo {
                            name: r.get("name"),
                            table_type: r.get::<String, _>("type").to_uppercase(),
                        }
                    })
                    .collect())
            }
        }
    }

    pub async fn get_columns(
        &self,
        database: &str,
        table: &str,
    ) -> Result<Vec<ColumnInfo>, String> {
        match self {
            ConnectionPool::Postgres(pool, config) => {
                let target_pool;
                let pool_ref: &sqlx::PgPool = if database == config.database {
                    pool
                } else {
                    let url = format!(
                        "postgres://{}:{}@{}:{}/{}",
                        urlencoding_simple(&config.username),
                        urlencoding_simple(&config.password),
                        config.host,
                        config.port,
                        database
                    );
                    target_pool = sqlx::PgPool::connect(&url).await.map_err(|e| e.to_string())?;
                    &target_pool
                };
                let rows = sqlx::query(
                    "SELECT column_name, data_type, is_nullable, column_default \
                     FROM information_schema.columns \
                     WHERE table_schema = 'public' AND table_name = $1 \
                     ORDER BY ordinal_position",
                )
                .bind(table)
                .fetch_all(pool_ref)
                .await
                .map_err(|e| e.to_string())?;
                Ok(rows
                    .iter()
                    .map(|r| {
                        use sqlx::Row;
                        ColumnInfo {
                            name: r.get("column_name"),
                            data_type: r.get("data_type"),
                            is_nullable: r.get::<String, _>("is_nullable") == "YES",
                            column_default: r.get("column_default"),
                        }
                    })
                    .collect())
            }
            ConnectionPool::MySQL(pool) => {
                let rows = sqlx::query(
                    "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT \
                     FROM information_schema.COLUMNS \
                     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
                     ORDER BY ORDINAL_POSITION",
                )
                .bind(database)
                .bind(table)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;
                Ok(rows
                    .iter()
                    .map(|r| {
                        use sqlx::Row;
                        ColumnInfo {
                            name: r.get("COLUMN_NAME"),
                            data_type: r.get("DATA_TYPE"),
                            is_nullable: r.get::<String, _>("IS_NULLABLE") == "YES",
                            column_default: r.get("COLUMN_DEFAULT"),
                        }
                    })
                    .collect())
            }
            ConnectionPool::SQLite(pool) => {
                let query = format!("PRAGMA table_info({table})");
                let rows = sqlx::query(&query)
                    .fetch_all(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(rows
                    .iter()
                    .map(|r| {
                        use sqlx::Row;
                        ColumnInfo {
                            name: r.get("name"),
                            data_type: r.get::<String, _>("type"),
                            is_nullable: r.get::<i32, _>("notnull") == 0,
                            column_default: r.get("dflt_value"),
                        }
                    })
                    .collect())
            }
        }
    }

    pub async fn execute_query_in(&self, database: &str, query: &str) -> Result<QueryResult, String> {
        let start = Instant::now();
        match self {
            ConnectionPool::Postgres(pool, config) => {
                let target_pool;
                let pool_ref: &sqlx::PgPool = if database == config.database {
                    pool
                } else {
                    let url = format!(
                        "postgres://{}:{}@{}:{}/{}",
                        urlencoding_simple(&config.username),
                        urlencoding_simple(&config.password),
                        config.host,
                        config.port,
                        database
                    );
                    target_pool = sqlx::PgPool::connect(&url).await.map_err(|e| e.to_string())?;
                    &target_pool
                };
                if is_dml(query) {
                    execute_dml_pg(pool_ref, query, start).await
                } else {
                    execute_pg(pool_ref, query, start).await
                }
            }
            ConnectionPool::MySQL(pool) => {
                if is_dml(query) {
                    execute_dml_mysql(pool, query, start).await
                } else {
                    execute_mysql(pool, query, start).await
                }
            }
            ConnectionPool::SQLite(pool) => {
                if is_dml(query) {
                    execute_dml_sqlite(pool, query, start).await
                } else {
                    execute_sqlite(pool, query, start).await
                }
            }
        }
    }

    pub async fn get_table_data(
        &self,
        database: &str,
        table: &str,
        page: i64,
        page_size: i64,
    ) -> Result<QueryResult, String> {
        let offset = page * page_size;
        let count_query;
        let data_query;

        match self {
            ConnectionPool::Postgres(pool, config) => {
                let target_pool;
                let pool_ref: &sqlx::PgPool = if database == config.database {
                    pool
                } else {
                    let url = format!(
                        "postgres://{}:{}@{}:{}/{}",
                        urlencoding_simple(&config.username),
                        urlencoding_simple(&config.password),
                        config.host,
                        config.port,
                        database
                    );
                    target_pool = sqlx::PgPool::connect(&url).await.map_err(|e| e.to_string())?;
                    &target_pool
                };
                count_query = format!("SELECT COUNT(*) FROM public.\"{table}\"");
                data_query = format!(
                    "SELECT * FROM public.\"{table}\" LIMIT {page_size} OFFSET {offset}"
                );
                let start = Instant::now();
                let count_row = sqlx::query(&count_query)
                    .fetch_one(pool_ref)
                    .await
                    .map_err(|e| e.to_string())?;
                use sqlx::Row;
                let total: i64 = count_row.get(0);
                let mut result = execute_pg(pool_ref, &data_query, start).await?;
                result.row_count = total as u64;
                Ok(result)
            }
            ConnectionPool::MySQL(pool) => {
                count_query = format!("SELECT COUNT(*) FROM `{database}`.`{table}`");
                data_query = format!(
                    "SELECT * FROM `{database}`.`{table}` LIMIT {page_size} OFFSET {offset}"
                );
                let start = Instant::now();
                let count_row = sqlx::query(&count_query)
                    .fetch_one(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                use sqlx::Row;
                let total: i64 = count_row.get(0);
                let mut result = execute_mysql(pool, &data_query, start).await?;
                result.row_count = total as u64;
                Ok(result)
            }
            ConnectionPool::SQLite(pool) => {
                count_query = format!("SELECT COUNT(*) FROM \"{table}\"");
                data_query = format!(
                    "SELECT * FROM \"{table}\" LIMIT {page_size} OFFSET {offset}"
                );
                let start = Instant::now();
                let count_row = sqlx::query(&count_query)
                    .fetch_one(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                use sqlx::Row;
                let total: i64 = count_row.get(0);
                let mut result = execute_sqlite(pool, &data_query, start).await?;
                result.row_count = total as u64;
                Ok(result)
            }
        }
    }
}

fn is_dml(query: &str) -> bool {
    let q = query.trim_start().to_lowercase();
    q.starts_with("insert")
        || q.starts_with("update")
        || q.starts_with("delete")
        || q.starts_with("replace")
        || q.starts_with("create")
        || q.starts_with("drop")
        || q.starts_with("alter")
        || q.starts_with("truncate")
}

async fn execute_dml_pg(pool: &sqlx::PgPool, query: &str, start: Instant) -> Result<QueryResult, String> {
    let result = sqlx::query(query)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(QueryResult {
        columns: vec!["rows_affected".to_string()],
        rows: vec![vec![serde_json::Value::Number(result.rows_affected().into())]],
        row_count: result.rows_affected(),
        execution_time_ms: start.elapsed().as_millis() as u64,
    })
}

async fn execute_dml_mysql(pool: &sqlx::MySqlPool, query: &str, start: Instant) -> Result<QueryResult, String> {
    let result = sqlx::query(query)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(QueryResult {
        columns: vec!["rows_affected".to_string()],
        rows: vec![vec![serde_json::Value::Number(result.rows_affected().into())]],
        row_count: result.rows_affected(),
        execution_time_ms: start.elapsed().as_millis() as u64,
    })
}

async fn execute_dml_sqlite(pool: &sqlx::SqlitePool, query: &str, start: Instant) -> Result<QueryResult, String> {
    let result = sqlx::query(query)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(QueryResult {
        columns: vec!["rows_affected".to_string()],
        rows: vec![vec![serde_json::Value::Number(result.rows_affected().into())]],
        row_count: result.rows_affected(),
        execution_time_ms: start.elapsed().as_millis() as u64,
    })
}

fn urlencoding_simple(s: &str) -> String {
    // Basic percent-encoding for connection strings
    s.chars()
        .flat_map(|c| match c {
            '@' => vec!['%', '4', '0'],
            ':' => vec!['%', '3', 'A'],
            '/' => vec!['%', '2', 'F'],
            ' ' => vec!['%', '2', '0'],
            _ => vec![c],
        })
        .collect()
}

async fn execute_pg(
    pool: &sqlx::PgPool,
    query: &str,
    start: Instant,
) -> Result<QueryResult, String> {
    use sqlx::Row;

    let rows = sqlx::query(query)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    let elapsed = start.elapsed().as_millis() as u64;

    if rows.is_empty() {
        // Could be a DDL/DML that returns no rows — just return affected rows
        return Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            row_count: 0,
            execution_time_ms: elapsed,
        });
    }

    let columns: Vec<String> = rows[0]
        .columns()
        .iter()
        .map(|c| c.name().to_string())
        .collect();

    let mut result_rows = Vec::new();
    for row in &rows {
        let mut result_row = Vec::new();
        for (i, col) in row.columns().iter().enumerate() {
            let type_name = col.type_info().name();
            let val = pg_value_to_json(&row, i, type_name);
            result_row.push(val);
        }
        result_rows.push(result_row);
    }

    Ok(QueryResult {
        columns,
        row_count: result_rows.len() as u64,
        rows: result_rows,
        execution_time_ms: elapsed,
    })
}

fn pg_value_to_json(row: &sqlx::postgres::PgRow, i: usize, type_name: &str) -> serde_json::Value {
    use sqlx::Row;

    match type_name {
        "INT2" | "INT4" | "INT8" | "int2" | "int4" | "int8" => {
            if let Ok(v) = row.try_get::<i64, _>(i) {
                serde_json::Value::Number(v.into())
            } else {
                serde_json::Value::Null
            }
        }
        "FLOAT4" | "FLOAT8" | "float4" | "float8" | "NUMERIC" | "numeric" => {
            if let Ok(v) = row.try_get::<f64, _>(i) {
                serde_json::Number::from_f64(v)
                    .map(serde_json::Value::Number)
                    .unwrap_or(serde_json::Value::Null)
            } else {
                serde_json::Value::Null
            }
        }
        "BOOL" | "bool" => {
            if let Ok(v) = row.try_get::<bool, _>(i) {
                serde_json::Value::Bool(v)
            } else {
                serde_json::Value::Null
            }
        }
        "JSON" | "JSONB" | "json" | "jsonb" => {
            if let Ok(v) = row.try_get::<serde_json::Value, _>(i) {
                v
            } else {
                serde_json::Value::Null
            }
        }
        _ => {
            if let Ok(v) = row.try_get::<String, _>(i) {
                serde_json::Value::String(v)
            } else {
                serde_json::Value::Null
            }
        }
    }
}

async fn execute_mysql(
    pool: &sqlx::MySqlPool,
    query: &str,
    start: Instant,
) -> Result<QueryResult, String> {
    use sqlx::Row;

    let rows = sqlx::query(query)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    let elapsed = start.elapsed().as_millis() as u64;

    if rows.is_empty() {
        return Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            row_count: 0,
            execution_time_ms: elapsed,
        });
    }

    let columns: Vec<String> = rows[0]
        .columns()
        .iter()
        .map(|c| c.name().to_string())
        .collect();

    let mut result_rows = Vec::new();
    for row in &rows {
        let mut result_row = Vec::new();
        for i in 0..row.columns().len() {
            let val = if let Ok(v) = row.try_get::<i64, _>(i) {
                serde_json::Value::Number(v.into())
            } else if let Ok(v) = row.try_get::<f64, _>(i) {
                serde_json::Number::from_f64(v)
                    .map(serde_json::Value::Number)
                    .unwrap_or(serde_json::Value::Null)
            } else if let Ok(v) = row.try_get::<bool, _>(i) {
                serde_json::Value::Bool(v)
            } else if let Ok(v) = row.try_get::<String, _>(i) {
                serde_json::Value::String(v)
            } else {
                serde_json::Value::Null
            };
            result_row.push(val);
        }
        result_rows.push(result_row);
    }

    Ok(QueryResult {
        columns,
        row_count: result_rows.len() as u64,
        rows: result_rows,
        execution_time_ms: elapsed,
    })
}

async fn execute_sqlite(
    pool: &sqlx::SqlitePool,
    query: &str,
    start: Instant,
) -> Result<QueryResult, String> {
    use sqlx::Row;

    let rows = sqlx::query(query)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    let elapsed = start.elapsed().as_millis() as u64;

    if rows.is_empty() {
        return Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            row_count: 0,
            execution_time_ms: elapsed,
        });
    }

    let columns: Vec<String> = rows[0]
        .columns()
        .iter()
        .map(|c| c.name().to_string())
        .collect();

    let mut result_rows = Vec::new();
    for row in &rows {
        let mut result_row = Vec::new();
        for i in 0..row.columns().len() {
            let val = if let Ok(v) = row.try_get::<i64, _>(i) {
                serde_json::Value::Number(v.into())
            } else if let Ok(v) = row.try_get::<f64, _>(i) {
                serde_json::Number::from_f64(v)
                    .map(serde_json::Value::Number)
                    .unwrap_or(serde_json::Value::Null)
            } else if let Ok(v) = row.try_get::<bool, _>(i) {
                serde_json::Value::Bool(v)
            } else if let Ok(v) = row.try_get::<String, _>(i) {
                serde_json::Value::String(v)
            } else {
                serde_json::Value::Null
            };
            result_row.push(val);
        }
        result_rows.push(result_row);
    }

    Ok(QueryResult {
        columns,
        row_count: result_rows.len() as u64,
        rows: result_rows,
        execution_time_ms: elapsed,
    })
}
