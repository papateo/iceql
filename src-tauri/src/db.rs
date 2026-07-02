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
