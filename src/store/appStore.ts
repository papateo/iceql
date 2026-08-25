import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { v4 as uuidv4 } from "uuid";
import type {
  ConnectionConfig,
  ActiveConnection,
  Tab,
  TableInfo,
  ColumnInfo,
  QueryResult,
  QueryLog,
  MqttTopicNode,
  MqttMessage,
} from "../types";

interface MqttMessageEvent {
  connection_id: string;
  topic: string;
  payload_base64: string;
  qos: number;
  retain: boolean;
  timestamp_ms: number;
}

const MQTT_MESSAGES_PER_TOPIC = 200;

function emptyMqttNode(name: string, fullPath: string): MqttTopicNode {
  return { name, fullPath, children: {}, messages: [], messageCount: 0 };
}

// Inserts a message into the tree at the exact topic path, creating intermediate nodes for any
// path segments not seen before (immutably, so React re-renders only the changed branch).
function insertMqttMessage(root: MqttTopicNode, topic: string, msg: MqttMessage): MqttTopicNode {
  const segments = topic.split("/");
  const recur = (node: MqttTopicNode, idx: number): MqttTopicNode => {
    if (idx === segments.length) {
      return {
        ...node,
        messages: [...node.messages, msg].slice(-MQTT_MESSAGES_PER_TOPIC),
        messageCount: node.messageCount + 1,
      };
    }
    const seg = segments[idx];
    // Built from the original segments array (not incrementally concatenated) so a topic
    // starting with "/" — whose first segment is "" — doesn't get treated as "no path yet"
    // by a `path ? ... : seg` fallback and silently lose its leading slash in fullPath.
    const childPath = segments.slice(0, idx + 1).join("/");
    const child = node.children[seg] ?? emptyMqttNode(seg, childPath);
    return {
      ...node,
      children: { ...node.children, [seg]: recur(child, idx + 1) },
    };
  };
  return recur(root, 0);
}

// Resets one topic's message history (and count) back to empty, leaving its children and every
// other topic in the tree untouched — used by the "Clear" button in a topic's message view.
function clearMqttTopicNode(root: MqttTopicNode, topic: string): MqttTopicNode {
  const segments = topic.split("/");
  const recur = (node: MqttTopicNode, idx: number): MqttTopicNode => {
    if (idx === segments.length) return { ...node, messages: [], messageCount: 0 };
    const seg = segments[idx];
    const child = node.children[seg];
    if (!child) return node; // nothing recorded at this path yet — nothing to clear
    return { ...node, children: { ...node.children, [seg]: recur(child, idx + 1) } };
  };
  return recur(root, 0);
}

function base64ToUtf8(b64: string): string {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
}

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

// Session persistence (tabs + which connections were active)
const SESSION_KEY = "iceql-session";

interface PersistedSession {
  tabs: Tab[];
  activeTabId: string | null;
  activeConnectionIds: string[]; // configIds that were connected
}

export function saveSession(tabs: Tab[], activeTabId: string | null, activeConnectionIds: string[]) {
  try {
    const session: PersistedSession = { tabs, activeTabId, activeConnectionIds };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch { /* ignore */ }
}

export function loadSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedSession;
  } catch {
    return null;
  }
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
  // The data source (connection) whose tab workspace is currently shown. Tabs are
  // scoped per data source — the tab bar only lists tabs for this connection.
  const [activeDataSourceId, setActiveDataSourceId] = useState<string | null>(null);
  // Remembers the last-active tab for each data source, so switching back restores it.
  const [activeTabByDs, setActiveTabByDs] = useState<Record<string, string>>({});
  const [selectedConnectionId, setSelectedConnectionId] = useState<
    string | null
  >(null);
  const [queryLogs, setQueryLogs] = useState<QueryLog[]>([]);
  // Transient "reveal this table in the sidebar tree" request, set by locateTable.
  const [locateTarget, setLocateTarget] = useState<{
    configId: string;
    dbName: string;
    tableName: string;
    nonce: number;
  } | null>(null);
  // One `mqtt-message` event listener per open MQTT connection, torn down on disconnect —
  // a ref (not state) since it's plumbing, not something a render should react to.
  const mqttUnlistenRef = useRef<Map<string, UnlistenFn>>(new Map());

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

  // Imports connections from an external source (e.g. a JSON file), assigning fresh
  // ids and de-duplicating names against what's already saved so nothing collides.
  const importConnections = useCallback(
    async (configs: ConnectionConfig[]) => {
      const existingNames = new Set(savedConnections.map((c) => c.name));
      const imported = configs.map((c) => {
        const base = c.name || "Imported connection";
        let name = base;
        let i = 2;
        while (existingNames.has(name)) name = `${base} (${i++})`;
        existingNames.add(name);
        return { ...c, id: uuidv4(), name };
      });
      const updated = [...savedConnections, ...imported];
      setSavedConnections(updated);
      await saveConnections(updated);
      return imported;
    },
    [savedConnections]
  );

  const connectDemoDb = useCallback(async () => {
    if (activeConnections.has("iceql-demo")) {
      setSelectedConnectionId("iceql-demo");
      setActiveDataSourceId("iceql-demo");
      return;
    }
    const [connectionId, config] = await invoke<[string, ConnectionConfig]>("connect_demo");
    const databases = await invoke<string[]>("get_databases", { connectionId });
    const ac: ActiveConnection = {
      connectionId,
      config,
      databases,
      expandedDbs: new Set(),
      dbTables: {},
      expandedTables: new Set(),
      dbColumns: {},
      dbErrors: {},
    };
    setSavedConnections((prev) => {
      if (prev.some((c) => c.id === config.id)) return prev;
      return [...prev, config];
    });
    setActiveConnections((prev) => {
      const next = new Map(prev);
      next.set(config.id, ac);
      return next;
    });
    setSelectedConnectionId(config.id);
    setActiveDataSourceId(config.id);
  }, [activeConnections]);

  // MQTT has no databases/tables to enumerate — connects, auto-subscribes to everything
  // backend-side, then wires up an event listener that grows the topic tree as messages arrive.
  const connectMqtt = useCallback(async (config: ConnectionConfig): Promise<string> => {
    // Guard against connecting twice to the same saved connection — without this, a second
    // call (e.g. from a stray re-render or a re-click) would leave the OLD backend connection
    // and its "mqtt-message" listener running forever alongside the new one, so every message
    // gets delivered twice in a row. That made "compare with previous message" always report
    // "no changes", since the two most recent entries were really just one message duplicated.
    const existing = activeConnections.get(config.id);
    if (existing) {
      setSelectedConnectionId(config.id);
      setActiveDataSourceId(config.id);
      return existing.connectionId;
    }
    const connectionId = await invoke<string>("mqtt_connect", { config });
    const ac: ActiveConnection = {
      connectionId,
      config,
      databases: [],
      expandedDbs: new Set(),
      dbTables: {},
      expandedTables: new Set(),
      dbColumns: {},
      dbErrors: {},
      mqttRoot: emptyMqttNode("", ""),
    };
    setActiveConnections((prev) => {
      const next = new Map(prev);
      next.set(config.id, ac);
      return next;
    });
    setSelectedConnectionId(config.id);
    setActiveDataSourceId(config.id);

    const unlisten = await listen<MqttMessageEvent>("mqtt-message", (event) => {
      const p = event.payload;
      if (p.connection_id !== connectionId) return;
      const msg: MqttMessage = {
        payload: base64ToUtf8(p.payload_base64),
        qos: p.qos,
        retain: p.retain,
        timestampMs: p.timestamp_ms,
      };
      setActiveConnections((prev) => {
        const conn = prev.get(config.id);
        if (!conn?.mqttRoot) return prev;
        const next = new Map(prev);
        next.set(config.id, { ...conn, mqttRoot: insertMqttMessage(conn.mqttRoot, p.topic, msg) });
        return next;
      });
    });
    // Belt-and-suspenders: if a listener from an earlier connection for this same id is
    // somehow still registered, drop it before installing the new one.
    mqttUnlistenRef.current.get(config.id)?.();
    mqttUnlistenRef.current.set(config.id, unlisten);

    return connectionId;
  }, [activeConnections]);

  const connectToDb = useCallback(
    async (config: ConnectionConfig): Promise<string> => {
      if (config.db_type === "mqtt") return connectMqtt(config);

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
        dbErrors: {},
      };
      setActiveConnections((prev) => {
        const next = new Map(prev);
        next.set(config.id, ac);
        return next;
      });
      setSelectedConnectionId(config.id);
      setActiveDataSourceId(config.id);
      return connectionId;
    },
    [connectMqtt]
  );

  const disconnectFromDb = useCallback(async (configId: string) => {
    let remainingDsIds: string[] = [];
    setActiveConnections((prev) => {
      const ac = prev.get(configId);
      if (ac) {
        if (ac.config.db_type === "mqtt") {
          invoke("mqtt_disconnect", { connectionId: ac.connectionId }).catch(console.error);
          mqttUnlistenRef.current.get(configId)?.();
          mqttUnlistenRef.current.delete(configId);
        } else {
          invoke("disconnect", { connectionId: ac.connectionId }).catch(
            console.error
          );
        }
      }
      const next = new Map(prev);
      next.delete(configId);
      remainingDsIds = [...next.keys()];
      return next;
    });
    setSelectedConnectionId((prev) => (prev === configId ? null : prev));
    setActiveTabByDs((m) => {
      const copy = { ...m };
      delete copy[configId];
      return copy;
    });
    setTabs((prev) => {
      const next = prev.filter((t) => t.connectionId !== configId);
      // If the disconnected source was active, move focus to another connected one.
      setActiveDataSourceId((curDs) => {
        if (curDs !== configId) return curDs;
        const nextDs = remainingDsIds[0] ?? null;
        const dsTabs = nextDs ? next.filter((t) => t.connectionId === nextDs) : [];
        setActiveTabId(dsTabs[dsTabs.length - 1]?.id ?? null);
        return nextDs;
      });
      return next;
    });
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
        try {
          console.log("[expandDatabase] invoking get_tables", { connectionId: ac.connectionId, database: dbName });
          const tables = await invoke<TableInfo[]>("get_tables", {
            connectionId: ac.connectionId,
            database: dbName,
          });
          console.log("[expandDatabase] got tables", tables);
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
        } catch (e) {
          console.error("expandDatabase error:", e);
          setActiveConnections((prev) => {
            const next = new Map(prev);
            const conn = next.get(configId)!;
            const newExpanded = new Set(conn.expandedDbs);
            newExpanded.add(dbName);
            next.set(configId, {
              ...conn,
              expandedDbs: newExpanded,
              dbErrors: { ...conn.dbErrors, [dbName]: String(e) },
            });
            return next;
          });
        }
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

  // Reveal a table in the sidebar tree: ensure its database is expanded (loading
  // tables if needed, without toggling a collapse), then publish a locate request.
  const locateTable = useCallback(
    async (configId: string, dbName: string, tableName: string) => {
      const ac = activeConnections.get(configId);
      if (!ac) return;

      if (!ac.expandedDbs.has(dbName)) {
        let tables = ac.dbTables[dbName];
        let dbError: string | null = null;
        if (!tables) {
          try {
            tables = await invoke<TableInfo[]>("get_tables", {
              connectionId: ac.connectionId,
              database: dbName,
            });
          } catch (e) {
            dbError = String(e);
          }
        }
        setActiveConnections((prev) => {
          const next = new Map(prev);
          const conn = next.get(configId);
          if (!conn) return prev;
          const newExpanded = new Set(conn.expandedDbs);
          newExpanded.add(dbName);
          next.set(configId, {
            ...conn,
            expandedDbs: newExpanded,
            ...(tables ? { dbTables: { ...conn.dbTables, [dbName]: tables } } : {}),
            ...(dbError ? { dbErrors: { ...conn.dbErrors, [dbName]: dbError } } : {}),
          });
          return next;
        });
      }

      setLocateTarget({ configId, dbName, tableName, nonce: Date.now() });
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
    (configId: string, dbName: string, tableName: string, preview = false) => {
      const tabId = `${configId}:${dbName}:${tableName}`;
      setTabs((prev) => {
        const existing = prev.find((t) => t.id === tabId);
        if (existing) {
          // Already open. Opening it permanently (double click) clears the preview flag.
          if (!preview && existing.preview) {
            return prev.map((t) => (t.id === tabId ? { ...t, preview: false } : t));
          }
          return prev;
        }
        const tab: Tab = {
          id: tabId,
          title: tableName,
          type: "table",
          connectionId: configId,
          database: dbName,
          table: tableName,
          preview,
        };
        // A single-click preview reuses the existing preview slot instead of stacking tabs.
        if (preview) {
          const previewIdx = prev.findIndex((t) => t.preview);
          if (previewIdx !== -1) {
            const next = [...prev];
            next[previewIdx] = tab;
            return next;
          }
        }
        return [...prev, tab];
      });
      setActiveTabId(tabId);
      setActiveDataSourceId(configId);
      setActiveTabByDs((m) => ({ ...m, [configId]: tabId }));
    },
    []
  );

  // Promote a preview tab to a permanent one (e.g. on double-click of the tab itself).
  const promoteTab = useCallback((tabId: string) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId && t.preview ? { ...t, preview: false } : t)));
  }, []);

  // Activate a tab and focus its owning data source.
  const selectTab = useCallback((tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    setActiveTabId(tabId);
    if (tab) {
      setActiveDataSourceId(tab.connectionId);
      setActiveTabByDs((m) => ({ ...m, [tab.connectionId]: tabId }));
    }
  }, [tabs]);

  // Switch the active data source, restoring its last-active tab (or its newest tab).
  const selectDataSource = useCallback((configId: string) => {
    setActiveDataSourceId(configId);
    const dsTabs = tabs.filter((t) => t.connectionId === configId);
    const remembered = dsTabs.find((t) => t.id === activeTabByDs[configId]);
    setActiveTabId(remembered?.id ?? dsTabs[dsTabs.length - 1]?.id ?? null);
  }, [tabs, activeTabByDs]);

  const openQueryTab = useCallback(
    (configId: string, dbName: string, initialQuery = "") => {
      const tabId = uuidv4();
      const tab: Tab = {
        id: tabId,
        title: "Query",
        type: "query",
        connectionId: configId,
        database: dbName,
        query: initialQuery,
      };
      setTabs((prev) => [...prev, tab]);
      setActiveTabId(tabId);
      setActiveDataSourceId(configId);
      setActiveTabByDs((m) => ({ ...m, [configId]: tabId }));
    },
    []
  );

  const openMqttTopicTab = useCallback((configId: string, topic: string) => {
    const tabId = `${configId}:mqtt:${topic}`;
    setTabs((prev) => {
      if (prev.some((t) => t.id === tabId)) return prev;
      const tab: Tab = {
        id: tabId,
        title: topic || "/",
        type: "mqtt-topic",
        connectionId: configId,
        database: "",
        topic,
      };
      return [...prev, tab];
    });
    setActiveTabId(tabId);
    setActiveDataSourceId(configId);
    setActiveTabByDs((m) => ({ ...m, [configId]: tabId }));
  }, []);

  const subscribeMqttTopic = useCallback(async (connectionId: string, topic: string, qos = 0) => {
    await invoke("mqtt_subscribe", { connectionId, topic, qos });
  }, []);

  const unsubscribeMqttTopic = useCallback(async (connectionId: string, topic: string) => {
    await invoke("mqtt_unsubscribe", { connectionId, topic });
  }, []);

  const publishMqtt = useCallback(
    async (connectionId: string, topic: string, payload: string, qos = 0, retain = false) => {
      await invoke("mqtt_publish", { connectionId, topic, payload, qos, retain });
    },
    []
  );

  // Local-only — just resets what's cached for this topic in the frontend, doesn't touch the
  // broker (a retained value there, if any, still comes back on the next matching subscribe).
  const clearMqttTopicHistory = useCallback((configId: string, topic: string) => {
    setActiveConnections((prev) => {
      const conn = prev.get(configId);
      if (!conn?.mqttRoot) return prev;
      const next = new Map(prev);
      next.set(configId, { ...conn, mqttRoot: clearMqttTopicNode(conn.mqttRoot, topic) });
      return next;
    });
  }, []);

  const closeTab = useCallback(
    (tabId: string) => {
      setTabs((prev) => {
        const closed = prev.find((t) => t.id === tabId);
        const next = prev.filter((t) => t.id !== tabId);
        if (closed) {
          const dsId = closed.connectionId;
          const dsIdx = prev.filter((t) => t.connectionId === dsId).findIndex((t) => t.id === tabId);
          const dsTabsAfter = next.filter((t) => t.connectionId === dsId);
          const fallback = dsTabsAfter[Math.min(dsIdx, dsTabsAfter.length - 1)]?.id ?? null;
          setActiveTabByDs((m) => {
            const copy = { ...m };
            if (fallback) copy[dsId] = fallback; else delete copy[dsId];
            return copy;
          });
          // If the closed tab was active, fall back within the same data source.
          if (activeTabId === tabId) {
            setActiveTabId(fallback);
            setActiveDataSourceId(dsId);
          }
        }
        return next;
      });
    },
    [activeTabId]
  );

  const reorderTabs = useCallback((connectionId: string, newOrder: string[]) => {
    setTabs((prev) => {
      const others = prev.filter((t) => t.connectionId !== connectionId);
      const reordered = newOrder.map((id) => prev.find((t) => t.id === id)!).filter(Boolean);
      return [...others, ...reordered];
    });
  }, []);

  const closeOtherTabs = useCallback((tabId: string, connectionId: string) => {
    setTabs((prev) => {
      const kept = prev.filter((t) => t.id === tabId || t.connectionId !== connectionId);
      setActiveTabByDs((m) => ({ ...m, [connectionId]: tabId }));
      setActiveTabId(tabId);
      return kept;
    });
  }, []);

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
    async (configId: string, database: string, query: string, queryId: string): Promise<QueryResult> => {
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
          queryId,
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

  const cancelQuery = useCallback(async (queryId: string) => {
    try {
      await invoke("cancel_query", { queryId });
    } catch (e) {
      console.error("Failed to cancel query:", e);
    }
  }, []);

  // Mongo documents have no SQL to run — edits go through these dedicated commands (matched
  // by _id) instead of executeQuery. Used by both the collection browse view and the Mongo
  // query tab's editable results.
  const mongoUpdateField = useCallback(
    async (configId: string, database: string, collection: string, idJson: string, field: string, valueJson: string) => {
      const ac = activeConnections.get(configId);
      if (!ac) throw new Error("Not connected");
      await invoke("mongo_update_field", {
        connectionId: ac.connectionId,
        database,
        collection,
        idJson,
        field,
        valueJson,
      });
    },
    [activeConnections]
  );

  const mongoDeleteDocuments = useCallback(
    async (configId: string, database: string, collection: string, idJsons: string[]): Promise<number> => {
      const ac = activeConnections.get(configId);
      if (!ac) throw new Error("Not connected");
      return await invoke<number>("mongo_delete_documents", {
        connectionId: ac.connectionId,
        database,
        collection,
        idJsons,
      });
    },
    [activeConnections]
  );

  const clearLogs = useCallback(() => setQueryLogs([]), []);

  // Used by the Query tab to build reliable UPDATE/DELETE WHERE clauses (primary key match
  // instead of an all-column match, which breaks the moment any other column goes stale).
  const getPrimaryKeys = useCallback(
    async (configId: string, database: string, table: string): Promise<string[]> => {
      const ac = activeConnections.get(configId);
      if (!ac) return [];
      try {
        return await invoke<string[]>("get_primary_keys", {
          connectionId: ac.connectionId,
          database,
          table,
        });
      } catch {
        return [];
      }
    },
    [activeConnections]
  );

  const beginTransaction = useCallback(
    async (configId: string, database: string): Promise<string> => {
      const ac = activeConnections.get(configId);
      if (!ac) throw new Error("Not connected");
      return await invoke<string>("begin_transaction", {
        connectionId: ac.connectionId,
        database,
      });
    },
    [activeConnections]
  );

  const executeInTransaction = useCallback(
    async (transactionId: string, query: string): Promise<QueryResult> => {
      return await invoke<QueryResult>("execute_in_transaction", {
        transactionId,
        query,
      });
    },
    []
  );

  const commitTransaction = useCallback(
    async (transactionId: string): Promise<QueryResult> => {
      return await invoke<QueryResult>("commit_transaction", { transactionId });
    },
    []
  );

  const rollbackTransaction = useCallback(
    async (transactionId: string): Promise<QueryResult> => {
      return await invoke<QueryResult>("rollback_transaction", { transactionId });
    },
    []
  );

  return {
    savedConnections,
    setSavedConnections,
    activeConnections,
    tabs,
    setTabs,
    activeTabId,
    setActiveTabId,
    activeDataSourceId,
    setActiveDataSourceId,
    selectTab,
    selectDataSource,
    selectedConnectionId,
    setSelectedConnectionId,
    addConnection,
    updateConnection,
    deleteConnection,
    importConnections,
    connectDemoDb,
    connectToDb,
    disconnectFromDb,
    expandDatabase,
    expandTable,
    locateTable,
    locateTarget,
    loadSchemaForDb,
    openTableTab,
    promoteTab,
    openQueryTab,
    openMqttTopicTab,
    subscribeMqttTopic,
    unsubscribeMqttTopic,
    publishMqtt,
    clearMqttTopicHistory,
    closeTab,
    reorderTabs,
    closeOtherTabs,
    updateTabQuery,
    updateTabDatabase,
    executeQuery,
    cancelQuery,
    mongoUpdateField,
    mongoDeleteDocuments,
    getPrimaryKeys,
    beginTransaction,
    executeInTransaction,
    commitTransaction,
    rollbackTransaction,
    addLog,
    queryLogs,
    clearLogs,
  };
}
