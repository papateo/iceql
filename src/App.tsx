import { useEffect, useRef, useState } from "react";
import { Database, ScrollText, Settings, Plus, Unplug, Trash2, Scissors, Copy, Clipboard } from "lucide-react";
import ConnectionsPanel from "./components/ConnectionsPanel";
import ContextMenu from "./components/ContextMenu";
import ConnectionManager from "./components/ConnectionManager";
import TabBar from "./components/TabBar";
import TableDataView from "./components/TableDataView";
import QueryView from "./components/QueryView";
import SqlLogPanel from "./components/SqlLogPanel";
import { useAppStore, loadSavedConnections, loadSession, saveSession } from "./store/appStore";
import type { ActiveConnection } from "./types";
import SettingsModal, { type AppSettings } from "./components/SettingsModal";
import EditTableModal, { type EditTableTarget } from "./components/EditTableModal";

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
  const [editTableTarget, setEditTableTarget] = useState<EditTableTarget | null>(null);
  const [connectingIds, setConnectingIds] = useState<Set<string>>(new Set());
  const [connectError, setConnectError] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [showConnManager, setShowConnManager] = useState(false);
  const [railCtx, setRailCtx] = useState<{ x: number; y: number; configId: string } | null>(null);
  const [logPanelWidth, setLogPanelWidth] = useState(320);
  const [tableSettings, setTableSettings] = useState<
    Record<string, { pageSize: number; infiniteScroll: boolean }>
  >({});

  // Global right-click context menu for input / textarea elements
  const [inputCtx, setInputCtx] = useState<{
    x: number; y: number; el: HTMLInputElement | HTMLTextAreaElement;
  } | null>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        e.preventDefault();
        setInputCtx({ x: e.clientX, y: e.clientY, el: el as HTMLInputElement | HTMLTextAreaElement });
      }
    };
    window.addEventListener("contextmenu", handler);
    return () => window.removeEventListener("contextmenu", handler);
  }, []);

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
        const restoredActive = restoredTabs.find((t) => t.id === session.activeTabId) ?? restoredTabs[0];
        store.setActiveTabId(restoredActive.id);
        store.setActiveDataSourceId(restoredActive.connectionId);
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
    // New queries belong to the active data source. Reuse the active tab's database
    // when it lives in that data source, otherwise fall back to the first database.
    const dsId = store.activeDataSourceId;
    const ac = dsId ? store.activeConnections.get(dsId) : undefined;
    const target = ac ?? store.activeConnections.values().next().value;
    if (!target) return;
    const active = store.tabs.find((t) => t.id === store.activeTabId && t.connectionId === target.config.id);
    store.openQueryTab(target.config.id, active?.database ?? target.databases[0] ?? "");
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

  const dsColor = (t: string) =>
    t === "postgresql" ? "text-blue-400"
    : t === "mysql" ? "text-orange-400"
    : t === "sqlite" ? "text-green-400"
    : t === "csv" ? "text-yellow-400"
    : "text-text-secondary";

  const dsBadgeLabel = (t: string) =>
    t === "postgresql" ? "PG"
    : t === "mysql" ? "MY"
    : t === "sqlite" ? "SL"
    : t === "csv" ? "CSV"
    : "DB";

  const dsBadgeClass = (t: string) =>
    t === "postgresql" ? "bg-blue-500 text-white"
    : t === "mysql" ? "bg-orange-500 text-white"
    : t === "sqlite" ? "bg-green-600 text-white"
    : t === "csv" ? "bg-yellow-500 text-black"
    : "bg-border text-text-muted";

  return (
    <div className="flex h-screen bg-bg text-text-primary overflow-hidden">
      {/* Data source rail — one icon per connected data source, each with its own tabs */}
      <div className="flex flex-col items-center gap-1 py-2 px-1.5 bg-bg border-r border-border flex-shrink-0">
        {store.savedConnections
          .filter((c) => store.activeConnections.has(c.id))
          .map((c) => {
            const isActive = store.activeDataSourceId === c.id;
            return (
              <button
                key={c.id}
                onClick={() => store.selectDataSource(c.id)}
                onContextMenu={(e) => { e.preventDefault(); setRailCtx({ x: e.clientX, y: e.clientY, configId: c.id }); }}
                title={c.name}
                className={`w-10 h-10 flex items-center justify-center rounded-lg transition-colors ${isActive ? "bg-accent" : "hover:bg-accent/50"}`}
              >
                <div className="relative">
                  <Database size={17} className={dsColor(c.db_type)} />
                  <span className={`absolute -bottom-1 -right-1.5 text-[7px] font-bold leading-none px-0.5 py-px rounded ${dsBadgeClass(c.db_type)}`}>
                    {dsBadgeLabel(c.db_type)}
                  </span>
                </div>
              </button>
            );
          })}
        {store.activeConnections.size > 0 && <div className="w-6 h-px bg-border my-0.5" />}
        <button
          onClick={() => setShowConnManager(true)}
          title="Manage connections"
          className="w-10 h-10 flex items-center justify-center rounded-lg text-text-muted hover:text-highlight hover:bg-accent/50 transition-colors"
        >
          <Plus size={18} />
        </button>

        {/* Settings pinned to the bottom of the rail */}
        <button
          onClick={() => setShowSettings(true)}
          title="Settings"
          className="mt-auto w-10 h-10 flex items-center justify-center rounded-lg text-text-muted hover:text-highlight hover:bg-accent/50 transition-colors"
        >
          <Settings size={18} />
        </button>
      </div>

      {railCtx && (
        <ContextMenu
          x={railCtx.x}
          y={railCtx.y}
          onClose={() => setRailCtx(null)}
          items={[
            ...(store.activeConnections.has(railCtx.configId) ? [{
              label: "Disconnect",
              icon: <Unplug size={12} />,
              onClick: () => store.disconnectFromDb(railCtx.configId),
            }] : []),
            {
              label: "Delete Connection",
              icon: <Trash2 size={12} />,
              danger: true as const,
              onClick: () => store.deleteConnection(railCtx.configId),
            },
          ]}
        />
      )}

      {/* Sidebar */}
      <div
        className="flex flex-col bg-sidebar border-r border-border flex-shrink-0 overflow-hidden select-none"
        style={{ width: sidebarWidth }}
      >
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
          activeDataSourceId={store.activeDataSourceId}
          onExpandDb={store.expandDatabase}
          onExpandTable={store.expandTable}
          locateTarget={store.locateTarget}
          onOpenTable={store.openTableTab}
          onOpenQuery={store.openQueryTab}
          onEditTable={(configId, dbName, tableName, dbType) => {
            const ac = store.activeConnections.get(configId);
            if (!ac) return;
            setEditTableTarget({ connectionId: ac.connectionId, dbType, database: dbName, tableName });
          }}
          onDisconnect={store.disconnectFromDb}
          onDeleteConnection={store.deleteConnection}
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
        <div className="flex items-center bg-sidebar border-b border-border flex-shrink-0 select-none">
          <div className="flex-1 overflow-hidden">
            <TabBar
              tabs={store.tabs.filter((t) => t.connectionId === store.activeDataSourceId)}
              activeTabId={store.activeTabId}
              onSelect={store.selectTab}
              onClose={store.closeTab}
              onCloseOthers={(id) => { if (store.activeDataSourceId) store.closeOtherTabs(id, store.activeDataSourceId); }}
              onReorder={(newOrder) => { if (store.activeDataSourceId) store.reorderTabs(store.activeDataSourceId, newOrder); }}
              onPromote={store.promoteTab}
              onLocate={(tab) => { if (tab.type === "table" && tab.table) store.locateTable(tab.connectionId, tab.database, tab.table); }}
              onNewQuery={handleNewQuery}
              canNewQuery={!!store.activeDataSourceId && store.activeConnections.has(store.activeDataSourceId)}
            />
          </div>
          <button
            onClick={() => setShowLogs((v) => !v)}
            title="SQL Query Logs"
            className={`flex items-center gap-1.5 px-3 py-1.5 my-1.5 mr-2 text-xs rounded-lg flex-shrink-0 transition-colors ${
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
            {!store.tabs.some((t) => t.id === store.activeTabId) && (
              <div className="flex flex-col items-center justify-center h-full text-text-muted gap-4">
                <Database size={48} className="opacity-20" />
                <div className="text-center">
                  <p className="text-text-secondary text-sm">No tab open</p>
                  <p className="text-xs mt-1">
                    {store.activeDataSourceId
                      ? "Open a table or start a new query for this data source"
                      : "Connect to a database and open a table or start a new query"}
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
                    onBeginTransaction={(db) => store.beginTransaction(tab.connectionId, db)}
                    onExecuteInTransaction={(txId, q) => store.executeInTransaction(txId, q)}
                    onCommitTransaction={(txId) => store.commitTransaction(txId)}
                    onRollbackTransaction={(txId) => store.rollbackTransaction(txId)}
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
      {editTableTarget && (
        <EditTableModal
          target={editTableTarget}
          onClose={() => setEditTableTarget(null)}
        />
      )}
      {inputCtx && (() => {
        const { x, y, el } = inputCtx;
        const hasSelection = el.selectionStart !== el.selectionEnd;
        const isPassword = (el as HTMLInputElement).type === "password";
        const isReadOnly = el.readOnly;
        return (
          <ContextMenu
            x={x}
            y={y}
            onClose={() => setInputCtx(null)}
            items={[
              {
                label: "Cut",
                icon: <Scissors size={12} />,
                disabled: !hasSelection || isReadOnly || isPassword,
                onClick: () => { el.focus(); document.execCommand("cut"); },
              },
              {
                label: "Copy",
                icon: <Copy size={12} />,
                disabled: !hasSelection || isPassword,
                onClick: () => { el.focus(); document.execCommand("copy"); },
              },
              {
                label: "Paste",
                icon: <Clipboard size={12} />,
                disabled: isReadOnly,
                onClick: () => {
                  el.focus();
                  document.execCommand("paste");
                },
              },
              { separator: true },
              {
                label: "Select All",
                disabled: false,
                onClick: () => { el.focus(); el.select(); },
              },
            ]}
          />
        );
      })()}

      {showConnManager && (
        <ConnectionManager
          savedConnections={store.savedConnections}
          activeConnections={store.activeConnections}
          connectingIds={connectingIds}
          onConnect={handleConnect}
          onDisconnect={store.disconnectFromDb}
          onAdd={store.addConnection}
          onUpdate={store.updateConnection}
          onDelete={store.deleteConnection}
          onSelectDataSource={store.selectDataSource}
          onConnectDemo={store.connectDemoDb}
          onClose={() => setShowConnManager(false)}
        />
      )}
    </div>
  );
}
