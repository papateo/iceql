use crate::models::{ColumnInfo, ConnectionConfig, QueryResult, TableInfo};
use sqlx::Column;
use sqlx::TypeInfo;
use std::time::Instant;

pub enum ConnectionPool {
    Postgres(sqlx::PgPool, ConnectionConfig),
    MySQL(sqlx::MySqlPool, ConnectionConfig),
    SQLite(sqlx::SqlitePool, ConnectionConfig),
    CSV(sqlx::SqlitePool, ConnectionConfig),
}

/// Derive the in-memory SQLite table name from the CSV file's stem.
fn csv_table_name(config: &ConnectionConfig) -> String {
    let stem = config
        .filename
        .as_deref()
        .and_then(|p| std::path::Path::new(p).file_stem())
        .and_then(|s| s.to_str())
        .unwrap_or("data");
    let name: String = stem
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '_' { c } else { '_' })
        .collect();
    if name.is_empty() { "data".to_string() } else { name }
}

/// Parse a CSV file and load it into a new in-memory SQLite pool.
async fn load_csv_into_sqlite(path: &str, config: &ConnectionConfig) -> Result<ConnectionPool, String> {
    let path_owned = path.to_string();

    let (table_name, headers, records) = tokio::task::spawn_blocking(move || {
        let stem = std::path::Path::new(&path_owned)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("data")
            .to_string();
        let tname: String = stem
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '_' { c } else { '_' })
            .collect();
        let tname = if tname.is_empty() { "data".to_string() } else { tname };

        let mut rdr = csv::Reader::from_path(&path_owned)
            .map_err(|e| format!("Cannot open CSV file: {e}"))?;

        let headers: Vec<String> = rdr
            .headers()
            .map_err(|e| format!("CSV header error: {e}"))?
            .iter()
            .map(|h| h.to_string())
            .collect();

        if headers.is_empty() {
            return Err("CSV file has no columns".to_string());
        }

        let mut records: Vec<Vec<String>> = Vec::new();
        for result in rdr.records() {
            let record = result.map_err(|e| format!("CSV row error: {e}"))?;
            records.push(record.iter().map(|f| f.to_string()).collect());
        }

        Ok::<(String, Vec<String>, Vec<Vec<String>>), String>((tname, headers, records))
    })
    .await
    .map_err(|e| format!("Thread join error: {e}"))??;

    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .map_err(|e| format!("Failed to create in-memory SQLite: {e}"))?;

    let col_defs: String = headers
        .iter()
        .map(|h| format!("\"{}\" TEXT", h.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(", ");
    let create_sql = format!("CREATE TABLE \"{table_name}\" ({col_defs})");
    sqlx::query(&create_sql)
        .execute(&pool)
        .await
        .map_err(|e| format!("Failed to create table: {e}"))?;

    if !records.is_empty() {
        let placeholders: String = headers.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        let insert_sql = format!("INSERT INTO \"{table_name}\" VALUES ({placeholders})");
        for record in &records {
            let mut query = sqlx::query(&insert_sql);
            for field in record {
                query = query.bind(field.as_str());
            }
            query
                .execute(&pool)
                .await
                .map_err(|e| format!("Failed to insert CSV row: {e}"))?;
        }
    }

    Ok(ConnectionPool::CSV(pool, config.clone()))
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
                Ok(ConnectionPool::MySQL(pool, config.clone()))
            }
            "sqlite" => {
                let path = config.filename.as_deref().unwrap_or(&config.database);
                let url = format!("sqlite:{path}");
                let pool = sqlx::SqlitePool::connect(&url)
                    .await
                    .map_err(|e| format!("SQLite connection failed: {e}"))?;
                Ok(ConnectionPool::SQLite(pool, config.clone()))
            }
            "csv" => {
                let path = config
                    .filename
                    .as_deref()
                    .ok_or_else(|| "CSV file path is required".to_string())?;
                load_csv_into_sqlite(path, config).await
            }
            other => Err(format!("Unsupported database type: {other}")),
        }
    }

    /// Create a dedicated single-connection pool for transaction use.
    pub async fn connect_single(config: &ConnectionConfig, database: &str) -> Result<Self, String> {
        match config.db_type.as_str() {
            "postgresql" => {
                let url = format!(
                    "postgres://{}:{}@{}:{}/{}",
                    urlencoding_simple(&config.username),
                    urlencoding_simple(&config.password),
                    config.host,
                    config.port,
                    database
                );
                let pool = sqlx::postgres::PgPoolOptions::new()
                    .max_connections(1)
                    .connect(&url)
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
                    database
                );
                let pool = sqlx::mysql::MySqlPoolOptions::new()
                    .max_connections(1)
                    .connect(&url)
                    .await
                    .map_err(|e| format!("MySQL connection failed: {e}"))?;
                Ok(ConnectionPool::MySQL(pool, config.clone()))
            }
            "sqlite" => {
                let path = config.filename.as_deref().unwrap_or(&config.database);
                let url = format!("sqlite:{path}");
                let pool = sqlx::sqlite::SqlitePoolOptions::new()
                    .max_connections(1)
                    .connect(&url)
                    .await
                    .map_err(|e| format!("SQLite connection failed: {e}"))?;
                Ok(ConnectionPool::SQLite(pool, config.clone()))
            }
            "csv" => Err("CSV data sources do not support transactions".to_string()),
            other => Err(format!("Unsupported database type: {other}")),
        }
    }

    /// Execute a raw query on this pool (used inside transactions).
    pub async fn execute_raw(&self, query: &str) -> Result<QueryResult, String> {
        let start = Instant::now();
        match self {
            ConnectionPool::Postgres(pool, _) => {
                if is_dml(query) {
                    execute_dml_pg(pool, query, start).await
                } else {
                    execute_pg(pool, query, start).await
                }
            }
            ConnectionPool::MySQL(pool, _) => {
                if is_dml(query) {
                    execute_dml_mysql(pool, query, start).await
                } else {
                    execute_mysql(pool, query, start).await
                }
            }
            ConnectionPool::SQLite(pool, _) | ConnectionPool::CSV(pool, _) => {
                if is_dml(query) {
                    execute_dml_sqlite(pool, query, start).await
                } else {
                    execute_sqlite(pool, query, start).await
                }
            }
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
            ConnectionPool::MySQL(pool, _) => {
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
            ConnectionPool::SQLite(_, _) => Ok(vec!["main".to_string()]),
            ConnectionPool::CSV(_, _) => Ok(vec!["csv".to_string()]),
        }
    }

    pub async fn get_tables(&self, database: &str) -> Result<Vec<TableInfo>, String> {
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
            ConnectionPool::MySQL(pool, _) => {
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
            ConnectionPool::SQLite(pool, _) => {
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
            ConnectionPool::CSV(_, config) => {
                let tname = csv_table_name(config);
                Ok(vec![TableInfo { name: tname, table_type: "TABLE".to_string() }])
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
            ConnectionPool::MySQL(pool, _) => {
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
            ConnectionPool::SQLite(pool, _) | ConnectionPool::CSV(pool, _) => {
                let query = format!("PRAGMA table_info(\"{table}\")");
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

    pub async fn get_primary_keys(
        &self,
        database: &str,
        table: &str,
    ) -> Result<Vec<String>, String> {
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
                    "SELECT a.attname \
                     FROM pg_index i \
                     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) \
                     WHERE i.indrelid = $1::regclass AND i.indisprimary \
                     ORDER BY array_position(i.indkey, a.attnum)",
                )
                .bind(table)
                .fetch_all(pool_ref)
                .await
                .map_err(|e| e.to_string())?;
                use sqlx::Row;
                Ok(rows.iter().map(|r| r.get::<String, _>("attname")).collect())
            }
            ConnectionPool::MySQL(pool, _) => {
                let rows = sqlx::query(
                    "SELECT COLUMN_NAME \
                     FROM information_schema.COLUMNS \
                     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_KEY = 'PRI' \
                     ORDER BY ORDINAL_POSITION",
                )
                .bind(database)
                .bind(table)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;
                use sqlx::Row;
                Ok(rows.iter().map(|r| r.get::<String, _>("COLUMN_NAME")).collect())
            }
            ConnectionPool::SQLite(pool, _) => {
                let query = format!("SELECT name FROM pragma_table_info('{table}') WHERE pk > 0 ORDER BY pk");
                let rows = sqlx::query(&query)
                    .fetch_all(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                use sqlx::Row;
                Ok(rows.iter().map(|r| r.get::<String, _>("name")).collect())
            }
            ConnectionPool::CSV(_, _) => Ok(vec![]),
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
            ConnectionPool::MySQL(pool, config) => {
                let target_pool;
                let pool_ref: &sqlx::MySqlPool = if database == config.database {
                    pool
                } else {
                    let url = format!(
                        "mysql://{}:{}@{}:{}/{}",
                        urlencoding_simple(&config.username),
                        urlencoding_simple(&config.password),
                        config.host,
                        config.port,
                        database
                    );
                    target_pool = sqlx::MySqlPool::connect(&url).await.map_err(|e| e.to_string())?;
                    &target_pool
                };
                if is_dml(query) {
                    execute_dml_mysql(pool_ref, query, start).await
                } else {
                    execute_mysql(pool_ref, query, start).await
                }
            }
            ConnectionPool::SQLite(pool, _) | ConnectionPool::CSV(pool, _) => {
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
        sort_col: Option<&str>,
        sort_dir: Option<&str>,
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
                let order = build_order_clause(sort_col, sort_dir, '"');
                data_query = format!(
                    "SELECT * FROM public.\"{table}\"{order} LIMIT {page_size} OFFSET {offset}"
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
            ConnectionPool::MySQL(pool, _) => {
                count_query = format!("SELECT COUNT(*) FROM `{database}`.`{table}`");
                let order = build_order_clause(sort_col, sort_dir, '`');
                data_query = format!(
                    "SELECT * FROM `{database}`.`{table}`{order} LIMIT {page_size} OFFSET {offset}"
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
            ConnectionPool::SQLite(pool, _) => {
                count_query = format!("SELECT COUNT(*) FROM \"{table}\"");
                let order = build_order_clause(sort_col, sort_dir, '"');
                data_query = format!(
                    "SELECT * FROM \"{table}\"{order} LIMIT {page_size} OFFSET {offset}"
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
            ConnectionPool::CSV(pool, config) => {
                let tname = csv_table_name(config);
                count_query = format!("SELECT COUNT(*) FROM \"{tname}\"");
                let order = build_order_clause(sort_col, sort_dir, '"');
                data_query = format!(
                    "SELECT * FROM \"{tname}\"{order} LIMIT {page_size} OFFSET {offset}"
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

/// Build an `ORDER BY` clause for a paged table query.
fn build_order_clause(sort_col: Option<&str>, sort_dir: Option<&str>, q: char) -> String {
    match sort_col {
        Some(col) if !col.is_empty() => {
            let dir = match sort_dir {
                Some(d) if d.eq_ignore_ascii_case("desc") => "DESC",
                _ => "ASC",
            };
            let escaped = col.replace(q, &format!("{q}{q}"));
            format!(" ORDER BY {q}{escaped}{q} {dir}")
        }
        _ => String::new(),
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

async fn execute_dml_mysql_conn(conn: &mut sqlx::pool::PoolConnection<sqlx::MySql>, query: &str, start: Instant) -> Result<QueryResult, String> {
    let result = sqlx::query(query)
        .execute(&mut **conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(QueryResult {
        columns: vec!["rows_affected".to_string()],
        rows: vec![vec![serde_json::Value::Number(result.rows_affected().into())]],
        row_count: result.rows_affected(),
        execution_time_ms: start.elapsed().as_millis() as u64,
    })
}

async fn execute_mysql_conn(conn: &mut sqlx::pool::PoolConnection<sqlx::MySql>, query: &str, start: Instant) -> Result<QueryResult, String> {
    use sqlx::Row;
    let rows = sqlx::query(query)
        .fetch_all(&mut **conn)
        .await
        .map_err(|e| e.to_string())?;
    let elapsed = start.elapsed().as_millis() as u64;
    if rows.is_empty() {
        return Ok(QueryResult { columns: vec![], rows: vec![], row_count: 0, execution_time_ms: elapsed });
    }
    let columns: Vec<String> = rows[0].columns().iter().map(|c| c.name().to_string()).collect();
    let mut result_rows = Vec::new();
    for row in &rows {
        let mut result_row = Vec::new();
        for i in 0..row.columns().len() {
            let val = if let Ok(v) = row.try_get::<i64, _>(i) {
                serde_json::Value::Number(v.into())
            } else if let Ok(v) = row.try_get::<f64, _>(i) {
                serde_json::Number::from_f64(v).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
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
    Ok(QueryResult { columns, row_count: result_rows.len() as u64, rows: result_rows, execution_time_ms: elapsed })
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
