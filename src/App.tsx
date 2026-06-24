import { useEffect, useRef, useState } from "react";
import { Database, ScrollText, Settings } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import ConnectionsPanel from "./components/ConnectionsPanel";
import TabBar from "./components/TabBar";
import TableDataView from "./components/TableDataView";
import QueryView from "./components/QueryView";
import SqlLogPanel from "./components/SqlLogPanel";
import { useAppStore, loadSavedConnections, loadSession, saveSession } from "./store/appStore";
import type { ActiveConnection } from "./types";
import SettingsModal, { type AppSettings } from "./components/SettingsModal";

// Build a CodeMirror SQL schema ({ table: [columns] }) from the cached metadata of a connection.
function buildSqlSchema(
  ac: ActiveConnection | undefined,
  database: string
): Record<string, string[]> {
  if (!ac || !database) return {};
  const schema: Record<string, string[]> = {};
  for (const t of ac.dbTables[database] ?? []) {
    const cols = ac.dbColumns[`${database}.${t.name}`];
    schema[t.name] = cols ? cols.map((c) => c.name) : [];
  }
  return schema;
}

export default function App() {
  const store = useAppStore();
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(() => {
    try { return JSON.parse(localStorage.getItem("iceql-settings") ?? "{}"); } catch { return {}; }
  });

  const DARK_THEMES = new Set(["charcoal", "ocean", "midnight", "nord"]);
  const isDark = DARK_THEMES.has(settings.theme ?? "charcoal");

  useEffect(() => {
    const { theme = "charcoal", fontSize = "md" } = settings;
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    const px: Record<string, string> = { sm: "12px", md: "14px", lg: "16px", xl: "18px" };
    root.style.fontSize = px[fontSize] ?? "14px";
    localStorage.setItem("iceql-settings", JSON.stringify(settings));
  }, [settings]);
  const [dragging, setDragging] = useState(false);
  const [connectingIds, setConnectingIds] = useState<Set<string>>(new Set());
  const [connectError, setConnectError] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [logPanelWidth, setLogPanelWidth] = useState(320);
  const [tableSettings, setTableSettings] = useState<
    Record<string, { pageSize: number; infiniteScroll: boolean }>
  >({});

  const updateTableSetting = (
    tabId: string,
    patch: Partial<{ pageSize: number; infiniteScroll: boolean }>
  ) => {
    setTableSettings((prev) => ({
      ...prev,
      [tabId]: {
        ...{ pageSize: 100, infiniteScroll: false },
        ...prev[tabId],
        ...patch,
      },
    }));
  };

  // Flag: skip saving during restore to avoid overwriting saved session
  const isRestoringRef = useRef(true);

  // Load saved connections + restore previous session on mount
  useEffect(() => {
    loadSavedConnections().then(async (conns) => {
      store.setSavedConnections(conns);

      const session = loadSession();
      if (!session) {
        isRestoringRef.current = false;
        return;
      }

      // Re-connect previously active connections, then restore tabs
      const reconnected = new Set<string>();
      await Promise.all(
        (session.activeConnectionIds ?? []).map(async (configId) => {
          const config = conns.find((c) => c.id === configId);
          if (!config) return;
          try {
            await store.connectToDb(config);
            reconnected.add(configId);
          } catch { /* skip silently if reconnect fails */ }
        })
      );

      // Restore tabs that belong to successfully reconnected connections
      const restoredTabs = (session.tabs ?? []).filter(
        (t) => reconnected.has(t.connectionId)
      );
      if (restoredTabs.length > 0) {
        store.setTabs(restoredTabs);
        const restoredActive = restoredTabs.find((t) => t.id === session.activeTabId);
        store.setActiveTabId(restoredActive?.id ?? restoredTabs[0].id);
      }

      // Allow saving from now on
      isRestoringRef.current = false;
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist session whenever tabs or active connections change (skip during restore)
  useEffect(() => {
    if (isRestoringRef.current) return;
    saveSession(
      store.tabs,
      store.activeTabId,
      [...store.activeConnections.keys()]
    );
  }, [store.tabs, store.activeTabId, store.activeConnections]);

  const handleConnect = async (config: typeof store.savedConnections[0]) => {
    setConnectingIds((prev) => new Set(prev).add(config.id));
    setConnectError(null);
    try {
      await store.connectToDb(config);
    } catch (e) {
      setConnectError(String(e));
    } finally {
      setConnectingIds((prev) => { const next = new Set(prev); next.delete(config.id); return next; });
    }
  };

  const handleNewQuery = () => {
    // Prefer the active tab's connection/database, else fall back to the first active connection.
    const active = store.tabs.find((t) => t.id === store.activeTabId);
    if (active) {
      store.openQueryTab(active.connectionId, active.database);
      return;
    }
    const first = store.activeConnections.values().next().value;
    if (first) {
      store.openQueryTab(first.config.id, first.databases[0] ?? "");
    }
  };

  const handleDividerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      setSidebarWidth(Math.max(180, Math.min(480, startW + (ev.clientX - startX))));
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div className="flex h-screen bg-bg text-text-primary overflow-hidden select-none">
      {/* Sidebar */}
      <div
        className="flex flex-col bg-sidebar border-r border-border flex-shrink-0 overflow-hidden"
        style={{ width: sidebarWidth }}
      >
        {/* Logo */}
        <div className="flex items-center border-b border-border">
          <div
            className="flex items-center gap-2 px-4 py-3 cursor-pointer hover:bg-accent/40 transition-colors group flex-1 min-w-0"
            onClick={() => openUrl("https://iceql.com")}
            title="iceql.com"
          >
            <img src="/icon.png" alt="iceql" className="w-9 h-9 flex-shrink-0 rounded-lg" />
            <div className="flex flex-col min-w-0">
              <span className="font-bold text-text-primary tracking-wide leading-tight group-hover:text-highlight transition-colors">IceQL</span>
              <span className="text-[10px] text-text-secondary leading-tight truncate">The cool way to manage your database</span>
            </div>
          </div>
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 mr-2 rounded hover:bg-accent text-text-muted hover:text-highlight transition-colors flex-shrink-0"
            title="Settings"
          >
            <Settings size={15} />
          </button>
        </div>

        {/* Connection error banner */}
        {connectError && (
          <div className="error-banner mx-2 mt-2 flex items-center gap-1">
            <span className="flex-1">{connectError}</span>
            <button className="underline opacity-70 hover:opacity-100" onClick={() => setConnectError(null)}>dismiss</button>
          </div>
        )}
        <ConnectionsPanel
          savedConnections={store.savedConnections}
          activeConnections={store.activeConnections}
          selectedConnectionId={store.selectedConnectionId}
          connectingIds={connectingIds}
          onConnect={handleConnect}
          onDisconnect={store.disconnectFromDb}
          onAdd={store.addConnection}
          onUpdate={store.updateConnection}
          onDelete={store.deleteConnection}
          onExpandDb={store.expandDatabase}
          onExpandTable={store.expandTable}
          onOpenTable={store.openTableTab}
          onOpenQuery={store.openQueryTab}
        />
      </div>

      {/* Resize divider */}
      <div
        className={`w-1 cursor-col-resize hover:bg-highlight/40 transition-colors flex-shrink-0 ${
          dragging ? "bg-highlight/40" : "bg-border"
        }`}
        onMouseDown={handleDividerMouseDown}
      />

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Tab bar + log button */}
        <div className="flex items-center border-b border-border flex-shrink-0">
          <div className="flex-1 overflow-hidden">
            <TabBar
              tabs={store.tabs}
              activeTabId={store.activeTabId}
              onSelect={store.setActiveTabId}
              onClose={store.closeTab}
              onNewQuery={handleNewQuery}
              canNewQuery={store.activeConnections.size > 0}
            />
          </div>
          <button
            onClick={() => setShowLogs((v) => !v)}
            title="SQL Query Logs"
            className={`flex items-center gap-1.5 px-3 py-2 text-xs border-l border-border flex-shrink-0 transition-colors ${
              showLogs
                ? "bg-accent text-highlight"
                : "text-text-muted hover:text-text-primary hover:bg-accent/50"
            }`}
          >
            <ScrollText size={14} />
            <span className="font-medium">Logs</span>
            {store.queryLogs.filter((l) => l.status === "error").length > 0 && (
              <span className="bg-red-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                {store.queryLogs.filter((l) => l.status === "error").length > 9
                  ? "9+"
                  : store.queryLogs.filter((l) => l.status === "error").length}
              </span>
            )}
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Tab content — all open tabs stay mounted so switching back doesn't refetch */}
          <div className="flex-1 overflow-hidden relative">
            {store.tabs.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-text-muted gap-4">
                <Database size={48} className="opacity-20" />
                <div className="text-center">
                  <p className="text-text-secondary text-sm">No tab open</p>
                  <p className="text-xs mt-1">
                    Connect to a database and open a table or start a new query
                  </p>
                </div>
              </div>
            )}

            {store.tabs.map((tab) => (
              <div
                key={tab.id}
                className={`absolute inset-0 ${tab.id === store.activeTabId ? "" : "hidden"}`}
              >
                {tab.type === "table" ? (
                  <TableDataView
                    configId={tab.connectionId}
                    database={tab.database}
                    table={tab.table!}
                    activeConnections={store.activeConnections}
                    addLog={store.addLog}
                    pageSize={tableSettings[tab.id]?.pageSize ?? 100}
                    onPageSizeChange={(size) => updateTableSetting(tab.id, { pageSize: size })}
                    infiniteScroll={tableSettings[tab.id]?.infiniteScroll ?? false}
                    onInfiniteScrollChange={(value) => updateTableSetting(tab.id, { infiniteScroll: value })}
                  />
                ) : (
                  <QueryView
                    tabId={tab.id}
                    query={tab.query ?? ""}
                    database={tab.database}
                    databases={store.activeConnections.get(tab.connectionId)?.databases ?? []}
                    dbType={store.activeConnections.get(tab.connectionId)?.config.db_type ?? "mysql"}
                    schema={buildSqlSchema(store.activeConnections.get(tab.connectionId), tab.database)}
                    isDark={isDark}
                    onLoadSchema={() => store.loadSchemaForDb(tab.connectionId, tab.database)}
                    onDatabaseChange={(db) => store.updateTabDatabase(tab.id, db)}
                    onQueryChange={(q) => store.updateTabQuery(tab.id, q)}
                    onRunQuery={(q) => store.executeQuery(tab.connectionId, tab.database, q)}
                  />
                )}
              </div>
            ))}
          </div>

          {/* SQL Log Panel */}
          {showLogs && (
            <>
              {/* Drag handle */}
              <div
                className="w-1 flex-shrink-0 cursor-col-resize hover:bg-highlight/40 transition-colors bg-border"
                onMouseDown={(e) => {
                  e.preventDefault();
                  const startX = e.clientX;
                  const startW = logPanelWidth;
                  const onMove = (ev: MouseEvent) => {
                    setLogPanelWidth(Math.max(220, Math.min(640, startW - (ev.clientX - startX))));
                  };
                  const onUp = () => {
                    window.removeEventListener("mousemove", onMove);
                    window.removeEventListener("mouseup", onUp);
                  };
                  window.addEventListener("mousemove", onMove);
                  window.addEventListener("mouseup", onUp);
                }}
              />
              <div className="flex-shrink-0 overflow-hidden" style={{ width: logPanelWidth }}>
                <SqlLogPanel
                  logs={store.queryLogs}
                  onClose={() => setShowLogs(false)}
                  onClear={store.clearLogs}
                />
              </div>
            </>
          )}
        </div>
      </div>
      {showSettings && (
        <SettingsModal
          settings={{ theme: settings.theme ?? "dark", fontSize: settings.fontSize ?? "md" }}
          onChange={setSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
