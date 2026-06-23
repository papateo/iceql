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

  const executeQuery = useCallback(
    async (configId: string, database: string, query: string): Promise<QueryResult> => {
      const ac = activeConnections.get(configId);
      if (!ac) throw new Error("Not connected");
      try {
        const result = await invoke<QueryResult>("execute_query", {
          connectionId: ac.connectionId,
          database,
          query,
        });
        addLog({
          sql: query,
          connectionName: ac.config.name,
          database: ac.config.database,
          status: "success",
          rowsAffected: result.row_count,
          executionTimeMs: result.execution_time_ms,
        });
        return result;
      } catch (e) {
        addLog({
          sql: query,
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
    openTableTab,
    openQueryTab,
    closeTab,
    updateTabQuery,
    executeQuery,
    addLog,
    queryLogs,
    clearLogs,
  };
}
