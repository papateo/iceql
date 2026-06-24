import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { v4 as uuidv4 } from "uuid";
import type {
  ConnectionConfig,
  ActiveConnection,
  Tab,
  TableInfo,
  ColumnInfo,
  QueryResult,
  QueryLog,
} from "../types";

// PostgreSQL folds unquoted identifiers to lowercase, so case-sensitive names (e.g. "BAGIAN")
// only resolve when double-quoted. To let users write `select * from BAGIAN` without quotes,
// we rewrite bare identifiers that match a known table/column whose stored name has uppercase.
//
// Builds a map of lowercased name -> canonical name for names that REQUIRE quoting. When two
// distinct canonical names share a lowercased form, the entry is marked ambiguous (null) and skipped.
function buildQuoteMap(ac: ActiveConnection, database: string): Map<string, string | null> {
  const map = new Map<string, string | null>();
  const add = (name: string) => {
    if (name === name.toLowerCase()) return; // already lowercase: Postgres resolves it fine
    const key = name.toLowerCase();
    if (map.has(key)) {
      if (map.get(key) !== name) map.set(key, null); // ambiguous
    } else {
      map.set(key, name);
    }
  };
  for (const t of ac.dbTables[database] ?? []) add(t.name);
  const prefix = `${database}.`;
  for (const [key, cols] of Object.entries(ac.dbColumns)) {
    if (!key.startsWith(prefix)) continue;
    for (const c of cols) add(c.name);
  }
  return map;
}

// SQL keywords are never rewritten, even if a case-sensitive column/table shares the name,
// so clauses like `ORDER BY` aren't broken by a column named "Order".
const SQL_KEYWORDS = new Set([
  "select", "from", "where", "and", "or", "not", "in", "is", "null", "like", "ilike",
  "order", "group", "by", "having", "limit", "offset", "join", "inner", "left", "right",
  "outer", "full", "cross", "natural", "on", "using", "as", "union", "all", "distinct",
  "insert", "into", "values", "update", "set", "delete", "create", "drop", "alter", "table",
  "view", "index", "between", "exists", "case", "when", "then", "else", "end", "asc", "desc",
  "with", "returning", "true", "false", "count", "sum", "avg", "min", "max", "cast",
]);

// Rewrite a query, quoting bare identifiers found in `quoteMap`. Skips string literals,
// line/block comments, and identifiers that are already double-quoted.
function autoQuoteIdentifiers(query: string, quoteMap: Map<string, string | null>): string {
  if (quoteMap.size === 0) return query;
  let out = "";
  let i = 0;
  const n = query.length;
  while (i < n) {
    const ch = query[i];
    if (ch === "-" && query[i + 1] === "-") {
      let j = i;
      while (j < n && query[j] !== "\n") j++;
      out += query.slice(i, j);
      i = j;
    } else if (ch === "/" && query[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(query[j] === "*" && query[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      out += query.slice(i, j);
      i = j;
    } else if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (query[j] === "'" && query[j + 1] === "'") { j += 2; continue; }
        if (query[j] === "'") { j++; break; }
        j++;
      }
      out += query.slice(i, j);
      i = j;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (query[j] === '"' && query[j + 1] === '"') { j += 2; continue; }
        if (query[j] === '"') { j++; break; }
        j++;
      }
      out += query.slice(i, j);
      i = j;
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(query[j])) j++;
      const word = query.slice(i, j);
      const lower = word.toLowerCase();
      const canonical = SQL_KEYWORDS.has(lower) ? null : quoteMap.get(lower);
      out += canonical ? `"${canonical}"` : word;
      i = j;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

// Saved connections persistence via Tauri backend
export async function loadSavedConnections(): Promise<ConnectionConfig[]> {
  try {
    return await invoke<ConnectionConfig[]>("load_connections");
  } catch {
    return [];
  }
}

export async function saveConnections(
  connections: ConnectionConfig[]
): Promise<void> {
  try {
    await invoke("save_connections", { connections });
  } catch (e) {
    console.error("Failed to save connections:", e);
  }
}

export function useAppStore() {
  const [savedConnections, setSavedConnections] = useState<ConnectionConfig[]>(
    []
  );
  const [activeConnections, setActiveConnections] = useState<
    Map<string, ActiveConnection>
  >(new Map());
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<
    string | null
  >(null);
  const [queryLogs, setQueryLogs] = useState<QueryLog[]>([]);

  const addLog = useCallback((log: Omit<QueryLog, "id" | "timestamp">) => {
    setQueryLogs((prev) => [
      { ...log, id: uuidv4(), timestamp: new Date() },
      ...prev,
    ].slice(0, 500)); // keep max 500 entries
  }, []);

  const addConnection = useCallback(
    async (config: ConnectionConfig) => {
      const newConfig = { ...config, id: config.id || uuidv4() };
      const updated = [...savedConnections, newConfig];
      setSavedConnections(updated);
      await saveConnections(updated);
      return newConfig;
    },
    [savedConnections]
  );

  const updateConnection = useCallback(
    async (config: ConnectionConfig) => {
      const updated = savedConnections.map((c) =>
        c.id === config.id ? config : c
      );
      setSavedConnections(updated);
      await saveConnections(updated);
    },
    [savedConnections]
  );

  const deleteConnection = useCallback(
    async (id: string) => {
      const updated = savedConnections.filter((c) => c.id !== id);
      setSavedConnections(updated);
      await saveConnections(updated);
    },
    [savedConnections]
  );

  const connectToDb = useCallback(
    async (config: ConnectionConfig): Promise<string> => {
      const connectionId = await invoke<string>("connect", { config });
      const databases = await invoke<string[]>("get_databases", {
        connectionId,
      });
      const ac: ActiveConnection = {
        connectionId,
        config,
        databases,
        expandedDbs: new Set(),
        dbTables: {},
        expandedTables: new Set(),
        dbColumns: {},
      };
      setActiveConnections((prev) => {
        const next = new Map(prev);
        next.set(config.id, ac);
        return next;
      });
      setSelectedConnectionId(config.id);
      return connectionId;
    },
    []
  );

  const disconnectFromDb = useCallback(async (configId: string) => {
    setActiveConnections((prev) => {
      const ac = prev.get(configId);
      if (ac) {
        invoke("disconnect", { connectionId: ac.connectionId }).catch(
          console.error
        );
      }
      const next = new Map(prev);
      next.delete(configId);
      return next;
    });
    setSelectedConnectionId((prev) => (prev === configId ? null : prev));
    setTabs((prev) => prev.filter((t) => t.connectionId !== configId));
  }, []);

  const expandDatabase = useCallback(
    async (configId: string, dbName: string) => {
      const ac = activeConnections.get(configId);
      if (!ac) return;

      const alreadyExpanded = ac.expandedDbs.has(dbName);

      if (alreadyExpanded) {
        setActiveConnections((prev) => {
          const next = new Map(prev);
          const conn = next.get(configId)!;
          const newExpanded = new Set(conn.expandedDbs);
          newExpanded.delete(dbName);
          next.set(configId, { ...conn, expandedDbs: newExpanded });
          return next;
        });
        return;
      }

      if (!ac.dbTables[dbName]) {
        const tables = await invoke<TableInfo[]>("get_tables", {
          connectionId: ac.connectionId,
          database: dbName,
        });
        setActiveConnections((prev) => {
          const next = new Map(prev);
          const conn = next.get(configId)!;
          const newExpanded = new Set(conn.expandedDbs);
          newExpanded.add(dbName);
          next.set(configId, {
            ...conn,
            expandedDbs: newExpanded,
            dbTables: { ...conn.dbTables, [dbName]: tables },
          });
          return next;
        });
      } else {
        setActiveConnections((prev) => {
          const next = new Map(prev);
          const conn = next.get(configId)!;
          const newExpanded = new Set(conn.expandedDbs);
          newExpanded.add(dbName);
          next.set(configId, { ...conn, expandedDbs: newExpanded });
          return next;
        });
      }
    },
    [activeConnections]
  );

  const expandTable = useCallback(
    async (configId: string, dbName: string, tableName: string) => {
      const ac = activeConnections.get(configId);
      if (!ac) return;
      const key = `${dbName}.${tableName}`;
      const alreadyExpanded = ac.expandedTables.has(key);

      if (alreadyExpanded) {
        setActiveConnections((prev) => {
          const next = new Map(prev);
          const conn = next.get(configId)!;
          const newExpanded = new Set(conn.expandedTables);
          newExpanded.delete(key);
          next.set(configId, { ...conn, expandedTables: newExpanded });
          return next;
        });
        return;
      }

      if (!ac.dbColumns[key]) {
        const columns = await invoke<ColumnInfo[]>("get_columns", {
          connectionId: ac.connectionId,
          database: dbName,
          table: tableName,
        });
        setActiveConnections((prev) => {
          const next = new Map(prev);
          const conn = next.get(configId)!;
          const newExpanded = new Set(conn.expandedTables);
          newExpanded.add(key);
          next.set(configId, {
            ...conn,
            expandedTables: newExpanded,
            dbColumns: { ...conn.dbColumns, [key]: columns },
          });
          return next;
        });
      } else {
        setActiveConnections((prev) => {
          const next = new Map(prev);
          const conn = next.get(configId)!;
          const newExpanded = new Set(conn.expandedTables);
          newExpanded.add(key);
          next.set(configId, { ...conn, expandedTables: newExpanded });
          return next;
        });
      }
    },
    [activeConnections]
  );

  // Load tables (and their columns) for a database so the query editor can offer autocomplete.
  // Idempotent: skips anything already cached. Columns are fetched in small chunks to avoid
  // overwhelming the connection pool on large schemas.
  const loadSchemaForDb = useCallback(
    async (configId: string, dbName: string) => {
      const ac = activeConnections.get(configId);
      if (!ac || !dbName) return;

      let tables = ac.dbTables[dbName];
      if (!tables) {
        tables = await invoke<TableInfo[]>("get_tables", {
          connectionId: ac.connectionId,
          database: dbName,
        });
        setActiveConnections((prev) => {
          const next = new Map(prev);
          const conn = next.get(configId);
          if (!conn) return prev;
          next.set(configId, { ...conn, dbTables: { ...conn.dbTables, [dbName]: tables! } });
          return next;
        });
      }

      const missing = tables.filter((t) => !ac.dbColumns[`${dbName}.${t.name}`]);
      const CHUNK = 8;
      for (let i = 0; i < missing.length; i += CHUNK) {
        const chunk = missing.slice(i, i + CHUNK);
        const loaded = await Promise.all(
          chunk.map(async (t) => {
            try {
              const cols = await invoke<ColumnInfo[]>("get_columns", {
                connectionId: ac.connectionId,
                database: dbName,
                table: t.name,
              });
              return [`${dbName}.${t.name}`, cols] as const;
            } catch {
              return null;
            }
          })
        );
        setActiveConnections((prev) => {
          const next = new Map(prev);
          const conn = next.get(configId);
          if (!conn) return prev;
          const dbColumns = { ...conn.dbColumns };
          for (const entry of loaded) {
            if (entry) dbColumns[entry[0]] = entry[1];
          }
          next.set(configId, { ...conn, dbColumns });
          return next;
        });
      }
    },
    [activeConnections]
  );

  const openTableTab = useCallback(
    (configId: string, dbName: string, tableName: string) => {
      const tabId = `${configId}:${dbName}:${tableName}`;
      const existing = tabs.find((t) => t.id === tabId);
      if (existing) {
        setActiveTabId(tabId);
        return;
      }
      const tab: Tab = {
        id: tabId,
        title: tableName,
        type: "table",
        connectionId: configId,
        database: dbName,
        table: tableName,
      };
      setTabs((prev) => [...prev, tab]);
      setActiveTabId(tabId);
    },
    [tabs]
  );

  const openQueryTab = useCallback(
    (configId: string, dbName: string) => {
      const tabId = uuidv4();
      const tab: Tab = {
        id: tabId,
        title: "Query",
        type: "query",
        connectionId: configId,
        database: dbName,
        query: "",
      };
      setTabs((prev) => [...prev, tab]);
      setActiveTabId(tabId);
    },
    []
  );

  const closeTab = useCallback(
    (tabId: string) => {
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === tabId);
        const next = prev.filter((t) => t.id !== tabId);
        if (activeTabId === tabId && next.length > 0) {
          const newIdx = Math.min(idx, next.length - 1);
          setActiveTabId(next[newIdx].id);
        } else if (next.length === 0) {
          setActiveTabId(null);
        }
        return next;
      });
    },
    [activeTabId]
  );

  const updateTabQuery = useCallback(
    (tabId: string, query: string) => {
      setTabs((prev) =>
        prev.map((t) => (t.id === tabId ? { ...t, query } : t))
      );
    },
    []
  );

  const updateTabDatabase = useCallback(
    (tabId: string, database: string) => {
      setTabs((prev) =>
        prev.map((t) => (t.id === tabId ? { ...t, database } : t))
      );
    },
    []
  );

  const executeQuery = useCallback(
    async (configId: string, database: string, query: string): Promise<QueryResult> => {
      const ac = activeConnections.get(configId);
      if (!ac) throw new Error("Not connected");
      // For Postgres, auto-quote known case-sensitive identifiers so unquoted queries resolve.
      const finalQuery =
        ac.config.db_type === "postgresql"
          ? autoQuoteIdentifiers(query, buildQuoteMap(ac, database))
          : query;
      try {
        const result = await invoke<QueryResult>("execute_query", {
          connectionId: ac.connectionId,
          database,
          query: finalQuery,
        });
        addLog({
          sql: finalQuery,
          connectionName: ac.config.name,
          database: ac.config.database,
          status: "success",
          rowsAffected: result.row_count,
          executionTimeMs: result.execution_time_ms,
        });
        return result;
      } catch (e) {
        addLog({
          sql: finalQuery,
          connectionName: ac.config.name,
          database: ac.config.database,
          status: "error",
          error: String(e),
        });
        throw e;
      }
    },
    [activeConnections, addLog]
  );

  const clearLogs = useCallback(() => setQueryLogs([]), []);

  return {
    savedConnections,
    setSavedConnections,
    activeConnections,
    tabs,
    activeTabId,
    setActiveTabId,
    selectedConnectionId,
    setSelectedConnectionId,
    addConnection,
    updateConnection,
    deleteConnection,
    connectToDb,
    disconnectFromDb,
    expandDatabase,
    expandTable,
    loadSchemaForDb,
    openTableTab,
    openQueryTab,
    closeTab,
    updateTabQuery,
    updateTabDatabase,
    executeQuery,
    addLog,
    queryLogs,
    clearLogs,
  };
}
