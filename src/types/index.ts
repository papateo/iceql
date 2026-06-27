export type DbType = "postgresql" | "mysql" | "sqlite" | "csv";

export interface ConnectionConfig {
  id: string;
  name: string;
  db_type: DbType;
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  filename?: string; // for SQLite
}

export interface TableInfo {
  name: string;
  table_type: string;
}

export interface ColumnInfo {
  name: string;
  data_type: string;
  is_nullable: boolean;
  column_default: string | null;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  row_count: number;
  execution_time_ms: number;
}

export interface DatabaseNode {
  name: string;
  tables: TableInfo[];
  expanded: boolean;
}

export type TabType = "table" | "query";

export interface Tab {
  id: string;
  title: string;
  type: TabType;
  connectionId: string;
  database: string;
  table?: string;
  query?: string;
  /** Preview (temporary) tab — opened via single click, replaced by the next single click. */
  preview?: boolean;
}

export interface QueryLog {
  id: string;
  sql: string;
  connectionName: string;
  database: string;
  status: "success" | "error";
  rowsAffected?: number;
  executionTimeMs?: number;
  error?: string;
  timestamp: Date;
}

export interface ActiveConnection {
  connectionId: string; // runtime UUID from backend
  config: ConnectionConfig;
  databases: string[];
  expandedDbs: Set<string>;
  dbTables: Record<string, TableInfo[]>;
  expandedTables: Set<string>;
  dbColumns: Record<string, ColumnInfo[]>; // key: db.table
  dbErrors: Record<string, string>; // key: dbName → error message
}
