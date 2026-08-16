use crate::models::{ColumnInfo, ConnectionConfig, QueryResult, TableInfo};
use futures_util::TryStreamExt;
use sqlx::Column;
use sqlx::TypeInfo;
use std::collections::HashSet;
use std::time::Instant;

#[derive(Clone)]
pub enum ConnectionPool {
    Postgres(sqlx::PgPool, ConnectionConfig),
    MySQL(sqlx::MySqlPool, ConnectionConfig),
    SQLite(sqlx::SqlitePool, ConnectionConfig),
    CSV(sqlx::SqlitePool, ConnectionConfig),
    Mongo(mongodb::Client, ConnectionConfig),
    // Just connection parameters — Redis has no long-lived pool here. Every operation opens
    // its own short-lived connection scoped to the requested db index (see redis_connection),
    // since Redis' "selected database" is per-connection state that would otherwise race
    // across concurrently open tabs sharing one connection/db-index-agnostic client.
    Redis(redis::Client, ConnectionConfig),
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
    pub async fn create_demo() -> Result<(Self, ConnectionConfig), String> {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(5)
            .connect("sqlite::memory:")
            .await
            .map_err(|e| format!("Failed to create demo database: {e}"))?;

        sqlx::query(
            "CREATE TABLE categories (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT
            )",
        )
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

        sqlx::query(
            "INSERT INTO categories (id, name, description) VALUES
            (1, 'Electronics', 'Phones, laptops, and gadgets'),
            (2, 'Clothing', 'Fashion and apparel'),
            (3, 'Books', 'Books and educational materials'),
            (4, 'Home & Garden', 'Furniture, decor, and garden'),
            (5, 'Sports', 'Sporting goods and fitness equipment')",
        )
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

        sqlx::query(
            "CREATE TABLE customers (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                phone TEXT,
                city TEXT,
                country TEXT,
                joined_date TEXT
            )",
        )
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

        sqlx::query(
            "INSERT INTO customers (id, name, email, phone, city, country, joined_date) VALUES
            (1, 'Alice Johnson', 'alice@example.com', '+1-555-0101', 'New York', 'USA', '2023-01-15'),
            (2, 'Bob Smith', 'bob@example.com', '+1-555-0102', 'Los Angeles', 'USA', '2023-02-20'),
            (3, 'Carol White', 'carol@example.com', '+44-20-7946-0958', 'London', 'UK', '2023-03-10'),
            (4, 'David Lee', 'david@example.com', '+65-9123-4567', 'Singapore', 'SG', '2023-04-05'),
            (5, 'Emma Garcia', 'emma@example.com', '+34-600-123-456', 'Madrid', 'Spain', '2023-05-18'),
            (6, 'Frank Chen', 'frank@example.com', '+86-139-1234-5678', 'Shanghai', 'China', '2023-06-22'),
            (7, 'Grace Kim', 'grace@example.com', '+82-10-1234-5678', 'Seoul', 'Korea', '2023-07-30'),
            (8, 'Henry Brown', 'henry@example.com', '+61-412-345-678', 'Sydney', 'Australia', '2023-08-14'),
            (9, 'Iris Patel', 'iris@example.com', '+91-98765-43210', 'Mumbai', 'India', '2023-09-03'),
            (10, 'Jack Wilson', 'jack@example.com', '+1-555-0110', 'Toronto', 'Canada', '2023-10-25'),
            (11, 'Kate Martinez', 'kate@example.com', '+52-55-1234-5678', 'Mexico City', 'Mexico', '2023-11-11'),
            (12, 'Liam Anderson', 'liam@example.com', '+46-70-123-4567', 'Stockholm', 'Sweden', '2023-12-01')",
        )
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

        sqlx::query(
            "CREATE TABLE products (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                category_id INTEGER REFERENCES categories(id),
                price REAL NOT NULL,
                stock INTEGER NOT NULL,
                description TEXT
            )",
        )
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

        sqlx::query(
            "INSERT INTO products (id, name, category_id, price, stock, description) VALUES
            (1,  'Laptop Pro 15',       1, 1299.99, 45,  'High-performance laptop with 16GB RAM'),
            (2,  'Wireless Earbuds',    1,   89.99, 120, 'Noise-cancelling Bluetooth earbuds'),
            (3,  'Smartphone X12',      1,  799.99,  60, 'Latest smartphone with 5G support'),
            (4,  'Smart Watch',         1,  249.99,  35, 'Fitness tracker with heart rate monitor'),
            (5,  'USB-C Hub',           1,   49.99, 200, '7-in-1 USB-C multiport adapter'),
            (6,  'Men T-Shirt',         2,   24.99, 300, 'Premium cotton casual t-shirt'),
            (7,  'Women Dress',         2,   59.99, 150, 'Elegant summer dress'),
            (8,  'Running Shoes',       5,  119.99,  80, 'Lightweight marathon running shoes'),
            (9,  'SQL Mastery',         3,   39.99, 500, 'Complete guide to SQL databases'),
            (10, 'Clean Code',          3,   34.99, 450, 'Principles of agile software craftsmanship'),
            (11, 'Office Chair',        4,  299.99,  25, 'Ergonomic office chair with lumbar support'),
            (12, 'Desk Lamp',           4,   44.99, 100, 'LED desk lamp with adjustable brightness'),
            (13, 'Yoga Mat',            5,   29.99, 175, 'Non-slip premium yoga mat'),
            (14, 'Mechanical Keyboard', 1,  149.99,  55, 'TKL mechanical keyboard with RGB lighting'),
            (15, 'Gaming Mouse',        1,   69.99,  90, 'High-precision gaming mouse 25K DPI')",
        )
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

        sqlx::query(
            "CREATE TABLE orders (
                id INTEGER PRIMARY KEY,
                customer_id INTEGER REFERENCES customers(id),
                product_id INTEGER REFERENCES products(id),
                quantity INTEGER NOT NULL,
                total_amount REAL NOT NULL,
                status TEXT NOT NULL,
                order_date TEXT NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

        sqlx::query(
            "INSERT INTO orders (id, customer_id, product_id, quantity, total_amount, status, order_date) VALUES
            (1,  1,  1, 1,    1299.99, 'delivered',  '2024-01-05'),
            (2,  1,  2, 2,     179.98, 'delivered',  '2024-01-12'),
            (3,  2,  3, 1,     799.99, 'delivered',  '2024-01-18'),
            (4,  3,  9, 1,      39.99, 'delivered',  '2024-01-20'),
            (5,  4,  4, 1,     249.99, 'shipped',    '2024-02-01'),
            (6,  5,  7, 2,     119.98, 'delivered',  '2024-02-05'),
            (7,  6, 14, 1,     149.99, 'processing', '2024-02-10'),
            (8,  7,  8, 1,     119.99, 'delivered',  '2024-02-14'),
            (9,  8, 11, 1,     299.99, 'shipped',    '2024-02-20'),
            (10, 9, 13, 2,      59.98, 'delivered',  '2024-02-25'),
            (11,10,  5, 3,     149.97, 'delivered',  '2024-03-01'),
            (12,11,  6, 5,     124.95, 'delivered',  '2024-03-08'),
            (13,12, 15, 1,      69.99, 'processing', '2024-03-10'),
            (14, 1, 10, 1,      34.99, 'delivered',  '2024-03-15'),
            (15, 2, 12, 2,      89.98, 'shipped',    '2024-03-20'),
            (16, 3,  4, 1,     249.99, 'delivered',  '2024-03-22'),
            (17, 5,  1, 1,    1299.99, 'cancelled',  '2024-03-25'),
            (18, 6,  2, 1,      89.99, 'delivered',  '2024-04-01'),
            (19, 7,  3, 1,     799.99, 'processing', '2024-04-05'),
            (20, 8,  9, 2,      79.98, 'delivered',  '2024-04-10')",
        )
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

        sqlx::query(
            "CREATE TABLE employees (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                role TEXT NOT NULL,
                department TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                hire_date TEXT NOT NULL,
                salary REAL NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

        sqlx::query(
            "INSERT INTO employees (id, name, role, department, email, hire_date, salary) VALUES
            (1,  'Sarah Connor',       'CEO',                'Executive',   'sarah@company.com',   '2018-03-01', 180000),
            (2,  'Mike Wazowski',      'CTO',                'Engineering', 'mike@company.com',    '2018-05-15', 160000),
            (3,  'Anna Stark',         'Head of Sales',      'Sales',       'anna@company.com',    '2019-01-10', 120000),
            (4,  'James Bond',         'Senior Engineer',    'Engineering', 'james@company.com',   '2019-06-20', 110000),
            (5,  'Diana Prince',       'UX Designer',        'Design',      'diana@company.com',   '2020-02-14',  95000),
            (6,  'Bruce Wayne',        'Product Manager',    'Product',     'bruce@company.com',   '2020-07-01', 105000),
            (7,  'Peter Parker',       'Backend Engineer',   'Engineering', 'peter@company.com',   '2021-01-11',  90000),
            (8,  'Mary Jane',          'Frontend Engineer',  'Engineering', 'mary@company.com',    '2021-03-22',  88000),
            (9,  'Clark Kent',         'Data Analyst',       'Analytics',   'clark@company.com',   '2021-09-05',  85000),
            (10, 'Lois Lane',          'Marketing Lead',     'Marketing',   'lois@company.com',    '2022-02-28',  92000),
            (11, 'Tony Stark',         'DevOps Engineer',    'Engineering', 'tony@company.com',    '2022-06-15', 100000),
            (12, 'Natasha Romanoff',   'Security Engineer',  'Engineering', 'natasha@company.com', '2023-01-09', 105000)",
        )
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

        sqlx::query(
            "CREATE VIEW sales_summary AS
            SELECT
                p.name AS product_name,
                c.name AS category,
                SUM(o.quantity) AS total_sold,
                ROUND(SUM(o.total_amount), 2) AS total_revenue
            FROM orders o
            JOIN products p ON o.product_id = p.id
            JOIN categories c ON p.category_id = c.id
            WHERE o.status != 'cancelled'
            GROUP BY p.id, p.name, c.name
            ORDER BY total_revenue DESC",
        )
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

        let config = ConnectionConfig {
            id: "iceql-demo".to_string(),
            name: "Demo Database".to_string(),
            db_type: "sqlite".to_string(),
            host: String::new(),
            port: 0,
            username: String::new(),
            password: String::new(),
            database: "main".to_string(),
            filename: None,
        };

        Ok((ConnectionPool::SQLite(pool, config.clone()), config))
    }

    pub async fn connect(config: &ConnectionConfig) -> Result<Self, String> {
        match config.db_type.as_str() {
            "postgresql" => {
                let options = sqlx::postgres::PgConnectOptions::new()
                    .host(&config.host)
                    .port(config.port)
                    .username(&config.username)
                    .password(&config.password)
                    .database(&config.database);
                let pool = sqlx::PgPool::connect_with(options)
                    .await
                    .map_err(|e| format!("PostgreSQL connection failed: {e}"))?;
                Ok(ConnectionPool::Postgres(pool, config.clone()))
            }
            "mysql" => {
                let options = sqlx::mysql::MySqlConnectOptions::new()
                    .host(&config.host)
                    .port(config.port)
                    .username(&config.username)
                    .password(&config.password)
                    .database(&config.database);
                let pool = sqlx::MySqlPool::connect_with(options)
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
            "mongodb" => {
                let options = mongo_client_options(config);
                let client = mongodb::Client::with_options(options)
                    .map_err(|e| format!("MongoDB connection failed: {e}"))?;
                // Validate connectivity up front so a bad host/auth fails at connect time.
                client
                    .database("admin")
                    .run_command(bson::doc! { "ping": 1 })
                    .await
                    .map_err(|e| format!("MongoDB connection failed: {e}"))?;
                Ok(ConnectionPool::Mongo(client, config.clone()))
            }
            "redis" => {
                let db = redis_db_index(config);
                let client = redis::Client::open(redis_connection_info(config, db))
                    .map_err(|e| format!("Redis connection failed: {e}"))?;
                // Validate connectivity up front so a bad host/auth fails at connect time.
                let mut conn = client
                    .get_multiplexed_async_connection()
                    .await
                    .map_err(|e| format!("Redis connection failed: {e}"))?;
                redis::cmd("PING")
                    .query_async::<String>(&mut conn)
                    .await
                    .map_err(|e| format!("Redis connection failed: {e}"))?;
                Ok(ConnectionPool::Redis(client, config.clone()))
            }
            other => Err(format!("Unsupported database type: {other}")),
        }
    }

    /// Create a dedicated single-connection pool for transaction use.
    pub async fn connect_single(config: &ConnectionConfig, database: &str) -> Result<Self, String> {
        match config.db_type.as_str() {
            "postgresql" => {
                let options = sqlx::postgres::PgConnectOptions::new()
                    .host(&config.host)
                    .port(config.port)
                    .username(&config.username)
                    .password(&config.password)
                    .database(database);
                let pool = sqlx::postgres::PgPoolOptions::new()
                    .max_connections(1)
                    .connect_with(options)
                    .await
                    .map_err(|e| format!("PostgreSQL connection failed: {e}"))?;
                Ok(ConnectionPool::Postgres(pool, config.clone()))
            }
            "mysql" => {
                let options = sqlx::mysql::MySqlConnectOptions::new()
                    .host(&config.host)
                    .port(config.port)
                    .username(&config.username)
                    .password(&config.password)
                    .database(database);
                let pool = sqlx::mysql::MySqlPoolOptions::new()
                    .max_connections(1)
                    .connect_with(options)
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
            "mongodb" => Err("MongoDB connections do not support transactions".to_string()),
            "redis" => Err("Redis connections do not support transactions".to_string()),
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
            ConnectionPool::Mongo(_, _) => {
                Err("MongoDB connections do not support transactions".to_string())
            }
            ConnectionPool::Redis(_, _) => {
                Err("Redis connections do not support transactions".to_string())
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
            ConnectionPool::Mongo(client, _) => {
                client.list_database_names().await.map_err(|e| e.to_string())
            }
            ConnectionPool::Redis(_, config) => {
                // Redis "databases" are numbered slots (0..N), not names — CONFIG GET tells us
                // how many the server was started with. Cluster mode and some managed Redis
                // offerings restrict CONFIG GET or don't support SELECT at all, so fall back to
                // just db 0 rather than failing the whole connection.
                let count = redis_database_count(config).await.unwrap_or(1);
                Ok((0..count).map(|i| i.to_string()).collect())
            }
        }
    }

    pub async fn get_tables(&self, database: &str) -> Result<Vec<TableInfo>, String> {
        match self {
            ConnectionPool::Postgres(pool, config) => {
                let target_pool;
                let pool_ref: &sqlx::PgPool = if database == config.database {
                    pool
                } else {
                    let options = sqlx::postgres::PgConnectOptions::new()
                        .host(&config.host)
                        .port(config.port)
                        .username(&config.username)
                        .password(&config.password)
                        .database(database);
                    target_pool = sqlx::PgPool::connect_with(options).await.map_err(|e| e.to_string())?;
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
            ConnectionPool::Mongo(client, _) => {
                let names = client
                    .database(database)
                    .list_collection_names()
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(names
                    .into_iter()
                    .map(|name| TableInfo { name, table_type: "COLLECTION".to_string() })
                    .collect())
            }
            ConnectionPool::Redis(_, config) => {
                let db = database.parse::<i64>().unwrap_or_else(|_| redis_db_index(config));
                let mut conn = redis_connection(config, db).await?;
                let keys = redis_scan_keys(&mut conn, "*", REDIS_SCAN_CAP).await?;
                let mut groups: Vec<String> = keys.iter().map(|k| redis_key_group(k)).collect();
                groups.sort();
                groups.dedup();
                Ok(groups
                    .into_iter()
                    .map(|name| TableInfo { name, table_type: "KEYS".to_string() })
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
                    let options = sqlx::postgres::PgConnectOptions::new()
                        .host(&config.host)
                        .port(config.port)
                        .username(&config.username)
                        .password(&config.password)
                        .database(database);
                    target_pool = sqlx::PgPool::connect_with(options).await.map_err(|e| e.to_string())?;
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
            ConnectionPool::Mongo(client, _) => {
                // Collections are schemaless — sample a handful of documents and report the
                // union of fields seen, best-effort. Not authoritative like a real schema.
                let coll = client.database(database).collection::<bson::Document>(table);
                let mut cursor = coll
                    .find(bson::doc! {})
                    .limit(50)
                    .await
                    .map_err(|e| e.to_string())?;
                let mut order: Vec<String> = vec![];
                let mut seen = HashSet::new();
                let mut types: std::collections::HashMap<String, String> = std::collections::HashMap::new();
                while let Some(doc) = cursor.try_next().await.map_err(|e| e.to_string())? {
                    for (k, v) in doc.iter() {
                        if seen.insert(k.clone()) {
                            order.push(k.clone());
                            types.insert(k.clone(), bson_type_name(v));
                        }
                    }
                }
                if let Some(pos) = order.iter().position(|c| c == "_id") {
                    let id = order.remove(pos);
                    order.insert(0, id);
                }
                Ok(order
                    .into_iter()
                    .map(|name| {
                        let is_id = name == "_id";
                        ColumnInfo {
                            data_type: types.get(&name).cloned().unwrap_or_else(|| "mixed".to_string()),
                            is_nullable: !is_id,
                            column_default: None,
                            name,
                        }
                    })
                    .collect())
            }
            ConnectionPool::Redis(_, _) => {
                // Synthetic schema — every key-group "table" row has this fixed shape.
                Ok(vec![
                    ColumnInfo { name: "key".to_string(), data_type: "string".to_string(), is_nullable: false, column_default: None },
                    ColumnInfo { name: "type".to_string(), data_type: "string".to_string(), is_nullable: false, column_default: None },
                    ColumnInfo { name: "ttl".to_string(), data_type: "int".to_string(), is_nullable: true, column_default: None },
                    ColumnInfo { name: "value".to_string(), data_type: "mixed".to_string(), is_nullable: true, column_default: None },
                ])
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
                    let options = sqlx::postgres::PgConnectOptions::new()
                        .host(&config.host)
                        .port(config.port)
                        .username(&config.username)
                        .password(&config.password)
                        .database(database);
                    target_pool = sqlx::PgPool::connect_with(options).await.map_err(|e| e.to_string())?;
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
            ConnectionPool::Mongo(_, _) => Ok(vec!["_id".to_string()]),
            ConnectionPool::Redis(_, _) => Ok(vec!["key".to_string()]),
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
                    let options = sqlx::postgres::PgConnectOptions::new()
                        .host(&config.host)
                        .port(config.port)
                        .username(&config.username)
                        .password(&config.password)
                        .database(database);
                    target_pool = sqlx::PgPool::connect_with(options).await.map_err(|e| e.to_string())?;
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
                    let options = sqlx::mysql::MySqlConnectOptions::new()
                        .host(&config.host)
                        .port(config.port)
                        .username(&config.username)
                        .password(&config.password)
                        .database(database);
                    target_pool = sqlx::MySqlPool::connect_with(options).await.map_err(|e| e.to_string())?;
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
            ConnectionPool::Mongo(client, _) => {
                mongo_run_find_query(client, database, query, start).await
            }
            ConnectionPool::Redis(_, config) => {
                let db = database.parse::<i64>().unwrap_or_else(|_| redis_db_index(config));
                redis_run_command_query(config, db, query, start).await
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
                    let options = sqlx::postgres::PgConnectOptions::new()
                        .host(&config.host)
                        .port(config.port)
                        .username(&config.username)
                        .password(&config.password)
                        .database(database);
                    target_pool = sqlx::PgPool::connect_with(options).await.map_err(|e| e.to_string())?;
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
            ConnectionPool::Mongo(client, _) => {
                let start = Instant::now();
                let coll = client.database(database).collection::<bson::Document>(table);
                let total = coll
                    .count_documents(bson::doc! {})
                    .await
                    .map_err(|e| e.to_string())? as u64;

                let mut find = coll.find(bson::doc! {}).skip((page * page_size).max(0) as u64).limit(page_size);
                if let Some(col) = sort_col.filter(|c| !c.is_empty()) {
                    let dir: i32 = if sort_dir.map(|d| d.eq_ignore_ascii_case("desc")).unwrap_or(false) { -1 } else { 1 };
                    find = find.sort(bson::doc! { col: dir });
                }
                let mut cursor = find.await.map_err(|e| e.to_string())?;

                let mut docs: Vec<bson::Document> = vec![];
                while let Some(doc) = cursor.try_next().await.map_err(|e| e.to_string())? {
                    docs.push(doc);
                }

                let mut result = flatten_mongo_docs(&docs);
                result.row_count = total;
                result.execution_time_ms = start.elapsed().as_millis() as u64;
                Ok(result)
            }
            ConnectionPool::Redis(_, config) => {
                let start = Instant::now();
                let db = database.parse::<i64>().unwrap_or_else(|_| redis_db_index(config));
                let mut conn = redis_connection(config, db).await?;

                // No true offset pagination over SCAN — fetch the (capped) matching key set
                // once, sort/slice it in memory. Fine for the key counts this UI is meant for;
                // a group with more keys than REDIS_SCAN_CAP just shows its first slice of them.
                let mut keys = redis_group_keys(&mut conn, table, REDIS_SCAN_CAP).await?;
                keys.sort();
                let total = keys.len() as u64;

                let mut rows_data = vec![];
                for key in &keys {
                    rows_data.push(redis_key_row(&mut conn, key).await?);
                }

                if let Some(col) = sort_col.filter(|c| !c.is_empty()) {
                    let desc = sort_dir.map(|d| d.eq_ignore_ascii_case("desc")).unwrap_or(false);
                    rows_data.sort_by(|a, b| {
                        let ord = match col {
                            "type" => a.1.cmp(&b.1),
                            "ttl" => a.2.cmp(&b.2),
                            _ => a.0.cmp(&b.0), // "key" or anything else
                        };
                        if desc { ord.reverse() } else { ord }
                    });
                }

                let offset = (page * page_size).max(0) as usize;
                let page_rows: Vec<Vec<serde_json::Value>> = rows_data
                    .into_iter()
                    .skip(offset)
                    .take(page_size.max(0) as usize)
                    .map(|(key, type_name, ttl, value)| {
                        vec![
                            serde_json::Value::String(key),
                            serde_json::Value::String(type_name),
                            serde_json::json!(ttl),
                            value,
                        ]
                    })
                    .collect();

                Ok(QueryResult {
                    columns: vec!["key".to_string(), "type".to_string(), "ttl".to_string(), "value".to_string()],
                    row_count: total,
                    rows: page_rows,
                    execution_time_ms: start.elapsed().as_millis() as u64,
                })
            }
        }
    }

    /// Set a single top-level field on one document, matched by `_id`. `id_json` and
    /// `value_json` are the raw text the frontend has for each — parsed as JSON when possible
    /// (so numbers/booleans/objects/ObjectId-extended-JSON round-trip as their real BSON type),
    /// otherwise stored as the literal string the user typed.
    pub async fn mongo_update_field(
        &self,
        database: &str,
        collection: &str,
        id_json: &str,
        field: &str,
        value_json: &str,
    ) -> Result<(), String> {
        let client = match self {
            ConnectionPool::Mongo(c, _) => c,
            _ => return Err("Not a MongoDB connection".to_string()),
        };
        let id_bson = json_or_string_to_bson(id_json)?;
        let value_bson = json_or_string_to_bson(value_json)?;
        let mut set_doc = bson::Document::new();
        set_doc.insert(field, value_bson);
        let coll = client.database(database).collection::<bson::Document>(collection);
        coll.update_one(bson::doc! { "_id": id_bson }, bson::doc! { "$set": set_doc })
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Delete documents by `_id`. Returns the number actually deleted.
    pub async fn mongo_delete_documents(
        &self,
        database: &str,
        collection: &str,
        id_jsons: &[String],
    ) -> Result<u64, String> {
        let client = match self {
            ConnectionPool::Mongo(c, _) => c,
            _ => return Err("Not a MongoDB connection".to_string()),
        };
        let ids = id_jsons
            .iter()
            .map(|s| json_or_string_to_bson(s))
            .collect::<Result<Vec<_>, _>>()?;
        let coll = client.database(database).collection::<bson::Document>(collection);
        let result = coll
            .delete_many(bson::doc! { "_id": { "$in": ids } })
            .await
            .map_err(|e| e.to_string())?;
        Ok(result.deleted_count)
    }

    /// Update one of a Redis key's two editable pseudo-fields: `"ttl"` (EXPIRE/PERSIST) or
    /// `"value"` (type-aware full replace — hash/list/set/zset are DEL'd and rewritten rather
    /// than diffed field-by-field, since their contents aren't addressable the way a document's
    /// fields are). The key name and type itself aren't editable, matching Mongo's `_id` rule.
    pub async fn redis_update_field(
        &self,
        database: &str,
        key: &str,
        field: &str,
        value_json: &str,
    ) -> Result<(), String> {
        let config = match self {
            ConnectionPool::Redis(_, cfg) => cfg,
            _ => return Err("Not a Redis connection".to_string()),
        };
        let db = database.parse::<i64>().unwrap_or_else(|_| redis_db_index(config));
        let mut conn = redis_connection(config, db).await?;

        match field {
            "ttl" => {
                let ttl: Option<i64> = serde_json::from_str(value_json).unwrap_or(None);
                match ttl {
                    Some(secs) if secs > 0 => {
                        redis::cmd("EXPIRE")
                            .arg(key)
                            .arg(secs)
                            .query_async::<i64>(&mut conn)
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                    _ => {
                        redis::cmd("PERSIST")
                            .arg(key)
                            .query_async::<i64>(&mut conn)
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                }
                Ok(())
            }
            "value" => {
                let type_name: String = redis::cmd("TYPE")
                    .arg(key)
                    .query_async(&mut conn)
                    .await
                    .map_err(|e| e.to_string())?;
                let value: serde_json::Value =
                    serde_json::from_str(value_json).map_err(|e| format!("Invalid JSON: {e}"))?;
                redis_write_value(&mut conn, key, &type_name, &value).await
            }
            other => Err(format!("Unknown field: {other}")),
        }
    }

    /// Delete keys by name. Returns the number actually deleted.
    pub async fn redis_delete_keys(&self, database: &str, keys: &[String]) -> Result<u64, String> {
        let config = match self {
            ConnectionPool::Redis(_, cfg) => cfg,
            _ => return Err("Not a Redis connection".to_string()),
        };
        if keys.is_empty() {
            return Ok(0);
        }
        let db = database.parse::<i64>().unwrap_or_else(|_| redis_db_index(config));
        let mut conn = redis_connection(config, db).await?;
        redis::cmd("DEL")
            .arg(keys)
            .query_async(&mut conn)
            .await
            .map_err(|e| e.to_string())
    }
}

/// Build `mongodb::options::ClientOptions` from a `ConnectionConfig`, wiring up
/// host/port/credentials via the driver's typed builders instead of a hand-built URI string
/// (avoids percent-encoding pitfalls with special characters in the username/password).
fn mongo_client_options(config: &ConnectionConfig) -> mongodb::options::ClientOptions {
    use mongodb::options::{ClientOptions, Credential, ServerAddress};

    let port = if config.port == 0 { None } else { Some(config.port) };
    let hosts = vec![ServerAddress::Tcp { host: config.host.clone(), port }];

    if config.username.is_empty() {
        ClientOptions::builder().hosts(hosts).build()
    } else {
        let source = if config.database.is_empty() { None } else { Some(config.database.clone()) };
        let credential = Credential::builder()
            .username(config.username.clone())
            .password(config.password.clone())
            .source(source)
            .build();
        ClientOptions::builder().hosts(hosts).credential(credential).build()
    }
}

/// Best-effort BSON type name for a sampled field — shown in the sidebar's schema tree.
fn bson_type_name(b: &bson::Bson) -> String {
    match b {
        bson::Bson::Double(_) => "double",
        bson::Bson::String(_) => "string",
        bson::Bson::Array(_) => "array",
        bson::Bson::Document(_) => "object",
        bson::Bson::Boolean(_) => "bool",
        bson::Bson::Null => "null",
        bson::Bson::Int32(_) => "int32",
        bson::Bson::Int64(_) => "int64",
        bson::Bson::ObjectId(_) => "objectId",
        bson::Bson::DateTime(_) => "date",
        bson::Bson::Decimal128(_) => "decimal128",
        bson::Bson::Timestamp(_) => "timestamp",
        bson::Bson::Binary(_) => "binary",
        _ => "mixed",
    }
    .to_string()
}

/// Convert a BSON value to JSON for display, using MongoDB's "relaxed" extended JSON so
/// ObjectId/DateTime/etc. round-trip as `{"$oid": "..."}`-style tagged objects instead of
/// being silently coerced or dropped.
fn bson_to_json(b: &bson::Bson) -> serde_json::Value {
    b.clone().into_relaxed_extjson()
}

/// Flatten a page of Mongo documents into a `QueryResult`: columns are the union of top-level
/// field names across the page (in first-seen order, with `_id` pinned first), and each row
/// aligns values to that column set. Nested objects/arrays stay as JSON in their cell — the
/// grid already renders non-primitive cell values as JSON text.
fn flatten_mongo_docs(docs: &[bson::Document]) -> QueryResult {
    let mut columns: Vec<String> = vec![];
    let mut seen = HashSet::new();
    for doc in docs {
        for (k, _) in doc.iter() {
            if seen.insert(k.clone()) {
                columns.push(k.clone());
            }
        }
    }
    if let Some(pos) = columns.iter().position(|c| c == "_id") {
        let id = columns.remove(pos);
        columns.insert(0, id);
    }

    let rows: Vec<Vec<serde_json::Value>> = docs
        .iter()
        .map(|doc| {
            columns
                .iter()
                .map(|c| doc.get(c).map(bson_to_json).unwrap_or(serde_json::Value::Null))
                .collect()
        })
        .collect();

    QueryResult {
        row_count: rows.len() as u64,
        columns,
        rows,
        execution_time_ms: 0,
    }
}

/// The Mongo "query tab" has no SQL to run — the frontend sends a small JSON spec instead:
/// `{"collection": "...", "filter": {...}, "sort": {...}, "limit": 200}`. Only `collection`
/// is required; `filter`/`sort` accept MongoDB extended JSON (e.g. `{"$oid": "..."}`).
async fn mongo_run_find_query(
    client: &mongodb::Client,
    database: &str,
    query: &str,
    start: Instant,
) -> Result<QueryResult, String> {
    #[derive(serde::Deserialize)]
    struct MongoQuerySpec {
        collection: String,
        filter: Option<serde_json::Value>,
        sort: Option<serde_json::Value>,
        limit: Option<i64>,
    }

    let spec: MongoQuerySpec =
        serde_json::from_str(query).map_err(|e| format!("Invalid Mongo query: {e}"))?;

    let filter = match spec.filter {
        Some(v) => json_to_document(v)?,
        None => bson::Document::new(),
    };

    let coll = client.database(database).collection::<bson::Document>(&spec.collection);
    let mut find = coll.find(filter).limit(spec.limit.unwrap_or(200));
    if let Some(sort_val) = spec.sort {
        find = find.sort(json_to_document(sort_val)?);
    }

    let mut cursor = find.await.map_err(|e| e.to_string())?;
    let mut docs: Vec<bson::Document> = vec![];
    while let Some(doc) = cursor.try_next().await.map_err(|e| e.to_string())? {
        docs.push(doc);
    }

    let mut result = flatten_mongo_docs(&docs);
    result.execution_time_ms = start.elapsed().as_millis() as u64;
    Ok(result)
}

/// Parse a JSON value (extended JSON allowed, e.g. `{"$oid": "..."}`) into a BSON document.
fn json_to_document(v: serde_json::Value) -> Result<bson::Document, String> {
    let bson_val = bson::Bson::try_from(v).map_err(|e| format!("Invalid BSON value: {e}"))?;
    bson_val
        .as_document()
        .cloned()
        .ok_or_else(|| "Expected a JSON object".to_string())
}

/// Parse a single JSON-or-plain-text value into BSON, used for `_id` filters and edited cell
/// values: valid JSON (numbers, booleans, null, objects, arrays, extended JSON) is interpreted
/// as its typed BSON equivalent; anything else (e.g. bare unquoted text) is stored as a string,
/// matching what the user actually typed.
fn json_or_string_to_bson(s: &str) -> Result<bson::Bson, String> {
    match serde_json::from_str::<serde_json::Value>(s) {
        Ok(v) => bson::Bson::try_from(v).map_err(|e| format!("Invalid BSON value: {e}")),
        Err(_) => Ok(bson::Bson::String(s.to_string())),
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

// ---------------------------------------------------------------------------
// Redis helpers
// ---------------------------------------------------------------------------

/// Cap on how many keys a SCAN-based listing (key-group tree, group contents) will collect.
/// Keeps the sidebar tree and table-data view responsive against huge keyspaces — a group
/// with more keys than this just shows its first slice rather than enumerating everything.
const REDIS_SCAN_CAP: usize = 5000;

/// Cap on how many elements of a single list/set/zset get fetched for display/edit.
const REDIS_VALUE_ELEMENT_CAP: isize = 1000;

/// The db index a connection defaults to — `ConnectionConfig.database` holds it as text
/// (e.g. "0"), same field SQL dialects use for a database *name*.
fn redis_db_index(config: &ConnectionConfig) -> i64 {
    config.database.trim().parse::<i64>().unwrap_or(0).max(0)
}

fn redis_connection_info(config: &ConnectionConfig, db: i64) -> redis::ConnectionInfo {
    redis::ConnectionInfo {
        addr: redis::ConnectionAddr::Tcp(config.host.clone(), config.port),
        redis: redis::RedisConnectionInfo {
            db,
            username: if config.username.is_empty() { None } else { Some(config.username.clone()) },
            password: if config.password.is_empty() { None } else { Some(config.password.clone()) },
            protocol: redis::ProtocolVersion::RESP2,
        },
    }
}

/// Opens a fresh, short-lived connection scoped to `db`. Redis' "selected database" is
/// per-connection state, so sharing one connection across tabs pointed at different db indices
/// would race; opening one per operation sidesteps that entirely and is cheap for Redis.
async fn redis_connection(config: &ConnectionConfig, db: i64) -> Result<redis::aio::MultiplexedConnection, String> {
    let client = redis::Client::open(redis_connection_info(config, db))
        .map_err(|e| format!("Redis connection failed: {e}"))?;
    client
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| format!("Redis connection failed: {e}"))
}

/// Number of logical databases the server was started with. Cluster mode / some managed Redis
/// offerings restrict `CONFIG GET` or don't support multiple databases at all.
async fn redis_database_count(config: &ConnectionConfig) -> Result<i64, String> {
    let mut conn = redis_connection(config, 0).await?;
    let result: Vec<String> = redis::cmd("CONFIG")
        .arg("GET")
        .arg("databases")
        .query_async(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    result
        .get(1)
        .and_then(|s| s.parse::<i64>().ok())
        .ok_or_else(|| "Could not determine database count".to_string())
}

/// SCAN loop collecting up to `cap` keys matching `pattern`. Non-blocking (unlike KEYS), the
/// conventional way to enumerate a Redis keyspace.
async fn redis_scan_keys(
    conn: &mut redis::aio::MultiplexedConnection,
    pattern: &str,
    cap: usize,
) -> Result<Vec<String>, String> {
    let mut cursor: u64 = 0;
    let mut keys = Vec::new();
    loop {
        let (next_cursor, batch): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(pattern)
            .arg("COUNT")
            .arg(1000)
            .query_async(conn)
            .await
            .map_err(|e| e.to_string())?;
        keys.extend(batch);
        cursor = next_cursor;
        if cursor == 0 || keys.len() >= cap {
            break;
        }
    }
    keys.truncate(cap);
    Ok(keys)
}

/// The pseudo-"table" a key belongs to: everything before its first `:` (a near-universal
/// Redis namespacing convention), or the whole key when there's no colon.
fn redis_key_group(key: &str) -> String {
    match key.find(':') {
        Some(idx) if idx > 0 => key[..idx].to_string(),
        _ => key.to_string(),
    }
}

/// All keys belonging to one group: an exact match on the group name itself (a bare key with
/// no colon, grouped under its own full name) plus everything under the `group:*` prefix.
async fn redis_group_keys(
    conn: &mut redis::aio::MultiplexedConnection,
    group: &str,
    cap: usize,
) -> Result<Vec<String>, String> {
    let mut keys: Vec<String> = Vec::new();
    let exists: i64 = redis::cmd("EXISTS")
        .arg(group)
        .query_async(conn)
        .await
        .map_err(|e| e.to_string())?;
    if exists > 0 {
        keys.push(group.to_string());
    }
    let prefixed = redis_scan_keys(conn, &format!("{group}:*"), cap).await?;
    for k in prefixed {
        if !keys.contains(&k) {
            keys.push(k);
        }
    }
    keys.truncate(cap);
    Ok(keys)
}

/// Fetch a key's value, shaped for display/edit by its Redis type. Hash → JSON object;
/// list/set → JSON array of strings; zset → JSON array of `{member, score}` (the same shape
/// `redis_write_value` expects back on save, so display and edit round-trip losslessly).
async fn redis_fetch_value(
    conn: &mut redis::aio::MultiplexedConnection,
    key: &str,
    type_name: &str,
) -> Result<serde_json::Value, String> {
    match type_name {
        "string" => {
            let v: Option<String> = redis::cmd("GET").arg(key).query_async(conn).await.map_err(|e| e.to_string())?;
            Ok(v.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null))
        }
        "hash" => {
            let v: std::collections::HashMap<String, String> = redis::cmd("HGETALL")
                .arg(key)
                .query_async(conn)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(v).unwrap_or(serde_json::Value::Object(Default::default())))
        }
        "list" => {
            let v: Vec<String> = redis::cmd("LRANGE")
                .arg(key)
                .arg(0)
                .arg(REDIS_VALUE_ELEMENT_CAP - 1)
                .query_async(conn)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Array(v.into_iter().map(serde_json::Value::String).collect()))
        }
        "set" => {
            let v: Vec<String> = redis::cmd("SMEMBERS").arg(key).query_async(conn).await.map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Array(v.into_iter().map(serde_json::Value::String).collect()))
        }
        "zset" => {
            let flat: Vec<String> = redis::cmd("ZRANGE")
                .arg(key)
                .arg(0)
                .arg(REDIS_VALUE_ELEMENT_CAP - 1)
                .arg("WITHSCORES")
                .query_async(conn)
                .await
                .map_err(|e| e.to_string())?;
            let pairs: Vec<serde_json::Value> = flat
                .chunks(2)
                .filter(|c| c.len() == 2)
                .map(|c| serde_json::json!({ "member": c[0], "score": c[1].parse::<f64>().unwrap_or(0.0) }))
                .collect();
            Ok(serde_json::Value::Array(pairs))
        }
        "none" => Ok(serde_json::Value::Null),
        other => Ok(serde_json::Value::String(format!("(unsupported type: {other})"))),
    }
}

/// One row of a key-group listing: (key, type, ttl seconds, value).
async fn redis_key_row(
    conn: &mut redis::aio::MultiplexedConnection,
    key: &str,
) -> Result<(String, String, i64, serde_json::Value), String> {
    let type_name: String = redis::cmd("TYPE").arg(key).query_async(conn).await.map_err(|e| e.to_string())?;
    let ttl: i64 = redis::cmd("TTL").arg(key).query_async(conn).await.map_err(|e| e.to_string())?;
    let value = redis_fetch_value(conn, key, &type_name).await?;
    Ok((key.to_string(), type_name, ttl, value))
}

/// A JSON scalar as the raw string Redis stores for list/set members and hash field values.
fn json_scalar_to_redis_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Parse a zset edit value: either `[{"member": "...", "score": n}, ...]` or `{"member": n}`.
fn redis_parse_zset_value(value: &serde_json::Value) -> Result<Vec<(String, f64)>, String> {
    if let Some(arr) = value.as_array() {
        arr.iter()
            .map(|item| {
                let member = item
                    .get("member")
                    .and_then(|m| m.as_str())
                    .ok_or_else(|| "Each zset entry needs a \"member\" string".to_string())?;
                let score = item
                    .get("score")
                    .and_then(|s| s.as_f64())
                    .ok_or_else(|| "Each zset entry needs a numeric \"score\"".to_string())?;
                Ok((member.to_string(), score))
            })
            .collect()
    } else if let Some(obj) = value.as_object() {
        obj.iter()
            .map(|(member, score)| {
                let score = score
                    .as_f64()
                    .ok_or_else(|| format!("Score for \"{member}\" must be a number"))?;
                Ok((member.clone(), score))
            })
            .collect()
    } else {
        Err("Expected a JSON array of {member, score} or an object of member: score".to_string())
    }
}

/// Write a JSON value into a key with type-aware full-replace semantics. Hash/list/set/zset are
/// DEL'd and rewritten (their contents aren't addressable field-by-field the way a document's
/// are), preserving the key's existing TTL across the DEL since that would otherwise clear it —
/// strings use `SET ... KEEPTTL` instead, needing no extra round-trip.
async fn redis_write_value(
    conn: &mut redis::aio::MultiplexedConnection,
    key: &str,
    type_name: &str,
    value: &serde_json::Value,
) -> Result<(), String> {
    match type_name {
        "string" | "none" => {
            let s = json_scalar_to_redis_string(value);
            redis::cmd("SET")
                .arg(key)
                .arg(s)
                .arg("KEEPTTL")
                .query_async::<redis::Value>(conn)
                .await
                .map_err(|e| e.to_string())?;
        }
        "hash" => {
            let obj = value
                .as_object()
                .ok_or_else(|| "Expected a JSON object for a hash value".to_string())?;
            let ttl: i64 = redis::cmd("TTL").arg(key).query_async(conn).await.map_err(|e| e.to_string())?;
            redis::cmd("DEL").arg(key).query_async::<i64>(conn).await.map_err(|e| e.to_string())?;
            if !obj.is_empty() {
                let mut cmd = redis::cmd("HSET");
                cmd.arg(key);
                for (k, v) in obj {
                    cmd.arg(k).arg(json_scalar_to_redis_string(v));
                }
                cmd.query_async::<i64>(conn).await.map_err(|e| e.to_string())?;
            }
            if ttl > 0 {
                redis::cmd("EXPIRE").arg(key).arg(ttl).query_async::<i64>(conn).await.map_err(|e| e.to_string())?;
            }
        }
        "list" => {
            let arr = value
                .as_array()
                .ok_or_else(|| "Expected a JSON array for a list value".to_string())?;
            let ttl: i64 = redis::cmd("TTL").arg(key).query_async(conn).await.map_err(|e| e.to_string())?;
            redis::cmd("DEL").arg(key).query_async::<i64>(conn).await.map_err(|e| e.to_string())?;
            if !arr.is_empty() {
                let mut cmd = redis::cmd("RPUSH");
                cmd.arg(key);
                for v in arr {
                    cmd.arg(json_scalar_to_redis_string(v));
                }
                cmd.query_async::<i64>(conn).await.map_err(|e| e.to_string())?;
            }
            if ttl > 0 {
                redis::cmd("EXPIRE").arg(key).arg(ttl).query_async::<i64>(conn).await.map_err(|e| e.to_string())?;
            }
        }
        "set" => {
            let arr = value
                .as_array()
                .ok_or_else(|| "Expected a JSON array for a set value".to_string())?;
            let ttl: i64 = redis::cmd("TTL").arg(key).query_async(conn).await.map_err(|e| e.to_string())?;
            redis::cmd("DEL").arg(key).query_async::<i64>(conn).await.map_err(|e| e.to_string())?;
            if !arr.is_empty() {
                let mut cmd = redis::cmd("SADD");
                cmd.arg(key);
                for v in arr {
                    cmd.arg(json_scalar_to_redis_string(v));
                }
                cmd.query_async::<i64>(conn).await.map_err(|e| e.to_string())?;
            }
            if ttl > 0 {
                redis::cmd("EXPIRE").arg(key).arg(ttl).query_async::<i64>(conn).await.map_err(|e| e.to_string())?;
            }
        }
        "zset" => {
            let pairs = redis_parse_zset_value(value)?;
            let ttl: i64 = redis::cmd("TTL").arg(key).query_async(conn).await.map_err(|e| e.to_string())?;
            redis::cmd("DEL").arg(key).query_async::<i64>(conn).await.map_err(|e| e.to_string())?;
            if !pairs.is_empty() {
                let mut cmd = redis::cmd("ZADD");
                cmd.arg(key);
                for (member, score) in &pairs {
                    cmd.arg(score).arg(member);
                }
                cmd.query_async::<i64>(conn).await.map_err(|e| e.to_string())?;
            }
            if ttl > 0 {
                redis::cmd("EXPIRE").arg(key).arg(ttl).query_async::<i64>(conn).await.map_err(|e| e.to_string())?;
            }
        }
        other => return Err(format!("Editing a Redis '{other}' key isn't supported yet")),
    }
    Ok(())
}

/// Split one command line into arguments the way a shell (or redis-cli) would — respecting
/// single/double-quoted segments so values containing spaces can be passed as one argument.
fn redis_tokenize(line: &str) -> Vec<String> {
    let mut tokens = vec![];
    let mut current = String::new();
    let mut in_quotes: Option<char> = None;
    for c in line.chars() {
        match in_quotes {
            Some(q) if c == q => in_quotes = None,
            Some(_) => current.push(c),
            None => match c {
                '"' | '\'' => in_quotes = Some(c),
                c if c.is_whitespace() => {
                    if !current.is_empty() {
                        tokens.push(std::mem::take(&mut current));
                    }
                }
                _ => current.push(c),
            },
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

/// Convert an arbitrary Redis command reply into JSON for display in the query tab's results.
fn redis_value_to_json(v: &redis::Value) -> serde_json::Value {
    match v {
        redis::Value::Nil => serde_json::Value::Null,
        redis::Value::Int(i) => serde_json::json!(i),
        redis::Value::BulkString(bytes) => serde_json::Value::String(String::from_utf8_lossy(bytes).to_string()),
        redis::Value::Array(items) | redis::Value::Set(items) => {
            serde_json::Value::Array(items.iter().map(redis_value_to_json).collect())
        }
        redis::Value::Map(pairs) => {
            let obj: serde_json::Map<String, serde_json::Value> = pairs
                .iter()
                .map(|(k, v)| {
                    let key = match redis_value_to_json(k) {
                        serde_json::Value::String(s) => s,
                        other => other.to_string(),
                    };
                    (key, redis_value_to_json(v))
                })
                .collect();
            serde_json::Value::Object(obj)
        }
        redis::Value::SimpleString(s) => serde_json::Value::String(s.clone()),
        redis::Value::Okay => serde_json::Value::String("OK".to_string()),
        redis::Value::Double(d) => serde_json::json!(d),
        redis::Value::Boolean(b) => serde_json::Value::Bool(*b),
        redis::Value::BigNumber(n) => serde_json::Value::String(n.to_string()),
        redis::Value::VerbatimString { text, .. } => serde_json::Value::String(text.clone()),
        _ => serde_json::Value::Null,
    }
}

/// The Redis "query tab" has no structured spec like Mongo's — each non-empty line of the
/// editor is run as its own raw Redis command (redis-cli-style), and every command's reply
/// becomes one result row alongside the command text that produced it.
async fn redis_run_command_query(
    config: &ConnectionConfig,
    db: i64,
    query: &str,
    start: Instant,
) -> Result<QueryResult, String> {
    let mut conn = redis_connection(config, db).await?;
    let mut rows = vec![];
    for line in query.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let tokens = redis_tokenize(line);
        if tokens.is_empty() {
            continue;
        }
        let mut cmd = redis::cmd(&tokens[0]);
        for arg in &tokens[1..] {
            cmd.arg(arg);
        }
        let result: Result<redis::Value, redis::RedisError> = cmd.query_async(&mut conn).await;
        let value_json = match result {
            Ok(v) => redis_value_to_json(&v),
            Err(e) => serde_json::Value::String(format!("ERROR: {e}")),
        };
        rows.push(vec![serde_json::Value::String(line.to_string()), value_json]);
    }
    Ok(QueryResult {
        columns: vec!["command".to_string(), "result".to_string()],
        row_count: rows.len() as u64,
        rows,
        execution_time_ms: start.elapsed().as_millis() as u64,
    })
}
