export type DbType = "postgresql" | "mysql" | "sqlite" | "csv" | "mongodb" | "redis" | "mqtt";

export interface SshTunnelConfig {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  auth_method: "password" | "key";
  password?: string;
  private_key_path?: string; // path on disk — the key's contents are never stored in the config
  passphrase?: string;
}

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
  ssh_tunnel?: SshTunnelConfig;
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

export type TabType = "table" | "query" | "mqtt-topic";

export interface Tab {
  id: string;
  title: string;
  type: TabType;
  connectionId: string;
  database: string;
  table?: string;
  query?: string;
  topic?: string; // for "mqtt-topic" tabs
  /** Preview (temporary) tab — opened via single click, replaced by the next single click. */
  preview?: boolean;
}

// MQTT has no schema to browse up front — topics are discovered only as messages arrive, so
// the tree below is built and owned entirely client-side from the live message stream.
export interface MqttMessage {
  payload: string; // decoded as UTF-8 (lossy) for display
  qos: number;
  retain: boolean;
  timestampMs: number;
}

export interface MqttTopicNode {
  name: string; // this path segment only, e.g. "livingroom"
  fullPath: string; // e.g. "home/livingroom"
  children: Record<string, MqttTopicNode>;
  messages: MqttMessage[]; // history for messages published to this exact topic, newest last
  messageCount: number; // total ever received at this exact topic (messages[] is capped)
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
  mqttRoot?: MqttTopicNode; // MQTT only — root of the live topic tree
}
