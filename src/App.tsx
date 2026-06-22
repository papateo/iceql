import { useEffect, useState } from "react";
import { Database, Layers, ScrollText } from "lucide-react";
import ConnectionsPanel from "./components/ConnectionsPanel";
import TabBar from "./components/TabBar";
import TableDataView from "./components/TableDataView";
import QueryView from "./components/QueryView";
import SqlLogPanel from "./components/SqlLogPanel";
import { useAppStore, loadSavedConnections } from "./store/appStore";

export default function App() {
  const store = useAppStore();
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [dragging, setDragging] = useState(false);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [logPanelWidth, setLogPanelWidth] = useState(320);

  // Load saved connections on mount
  useEffect(() => {
    loadSavedConnections().then((conns) => {
      store.setSavedConnections(conns);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleConnect = async (config: typeof store.savedConnections[0]) => {
    setConnectingId(config.id);
    setConnectError(null);
    try {
      await store.connectToDb(config);
    } catch (e) {
      setConnectError(String(e));
    } finally {
      setConnectingId(null);
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

  const activeTab = store.tabs.find((t) => t.id === store.activeTabId);

  return (
    <div className="flex h-screen bg-bg text-text-primary overflow-hidden select-none">
      {/* Sidebar */}
      <div
        className="flex flex-col bg-sidebar border-r border-border flex-shrink-0 overflow-hidden"
        style={{ width: sidebarWidth }}
      >
        {/* Logo */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Layers size={18} className="text-highlight flex-shrink-0" />
          <div className="flex flex-col min-w-0">
            <span className="font-bold text-text-primary tracking-wide leading-tight">iceql.com</span>
            <span className="text-[10px] text-text-secondary leading-tight truncate">The cool way to manage your database</span>
          </div>
        </div>

        {/* Connection error banner */}
        {connectError && (
          <div className="mx-2 mt-2 px-2 py-1.5 bg-red-900/30 border border-red-800/50 rounded text-red-400 text-xs">
            {connectError}
            <button
              className="ml-2 underline"
              onClick={() => setConnectError(null)}
            >
              dismiss
            </button>
          </div>
        )}
        {connectingId && (
          <div className="mx-2 mt-2 px-2 py-1.5 bg-blue-900/30 border border-blue-800/50 rounded text-blue-300 text-xs flex items-center gap-2">
            <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            Connecting…
          </div>
        )}

        <ConnectionsPanel
          savedConnections={store.savedConnections}
          activeConnections={store.activeConnections}
          selectedConnectionId={store.selectedConnectionId}
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
          {/* Tab content */}
          <div className="flex-1 overflow-hidden">
            {!activeTab && (
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

            {activeTab?.type === "table" && (
              <TableDataView
                configId={activeTab.connectionId}
                database={activeTab.database}
                table={activeTab.table!}
                activeConnections={store.activeConnections}
                addLog={store.addLog}
              />
            )}

            {activeTab?.type === "query" && (
              <QueryView
                tabId={activeTab.id}
                query={activeTab.query ?? ""}
                onQueryChange={(q) => store.updateTabQuery(activeTab.id, q)}
                onRunQuery={(q) => store.executeQuery(activeTab.connectionId, q)}
              />
            )}
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
    </div>
  );
}
