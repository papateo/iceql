import { useState } from "react";
import { X, Trash2, CheckCircle2, XCircle, Clock, Copy, ChevronDown, ChevronRight } from "lucide-react";
import type { QueryLog } from "../types";

interface Props {
  logs: QueryLog[];
  onClose: () => void;
  onClear: () => void;
}

function formatTime(d: Date) {
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatMs(ms?: number) {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function LogEntry({ log }: { log: QueryLog }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(log.sql);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const isSuccess = log.status === "success";
  const shortSql = log.sql.replace(/\s+/g, " ").trim();

  return (
    <div className={`border-b border-border/50 ${isSuccess ? "" : "bg-red-950/20"}`}>
      <div
        className="flex items-start gap-2 px-3 py-2 hover:bg-accent/30 cursor-pointer group"
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Status icon */}
        <div className="flex-shrink-0 mt-0.5">
          {isSuccess
            ? <CheckCircle2 size={13} className="text-green-400" />
            : <XCircle size={13} className="text-red-400" />}
        </div>

        {/* SQL preview */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono text-text-primary truncate flex-1">
              {shortSql}
            </span>
            <button
              onClick={copy}
              className="opacity-0 group-hover:opacity-100 flex-shrink-0 text-text-muted hover:text-highlight transition-colors"
              title="Copy SQL"
            >
              {copied ? <CheckCircle2 size={11} className="text-green-400" /> : <Copy size={11} />}
            </button>
            {expanded
              ? <ChevronDown size={11} className="text-text-muted flex-shrink-0" />
              : <ChevronRight size={11} className="text-text-muted flex-shrink-0" />}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <Clock size={10} className="text-text-muted" />
            <span className="text-[10px] text-text-muted">{formatTime(log.timestamp)}</span>
            <span className="text-[10px] text-text-muted/60">·</span>
            <span className="text-[10px] text-text-secondary font-mono">{log.connectionName}</span>
            <span className="text-[10px] text-text-muted/60">·</span>
            <span className="text-[10px] text-text-muted">{log.database}</span>
            {log.executionTimeMs !== undefined && (
              <>
                <span className="text-[10px] text-text-muted/60">·</span>
                <span className="text-[10px] text-highlight">{formatMs(log.executionTimeMs)}</span>
              </>
            )}
            {isSuccess && log.rowsAffected !== undefined && (
              <>
                <span className="text-[10px] text-text-muted/60">·</span>
                <span className="text-[10px] text-text-muted">{log.rowsAffected.toLocaleString()} rows</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-3 pb-2">
          <pre className="text-[11px] font-mono text-text-primary bg-bg rounded p-2 overflow-x-auto whitespace-pre-wrap break-all border border-border/50">
            {log.sql}
          </pre>
          {!isSuccess && log.error && (
            <div className="mt-1.5 text-[11px] text-red-400 font-mono bg-red-950/30 rounded p-2 border border-red-900/50">
              {log.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function SqlLogPanel({ logs, onClose, onClear }: Props) {
  const [filter, setFilter] = useState<"all" | "success" | "error">("all");

  const filtered = logs.filter((l) =>
    filter === "all" ? true : l.status === filter
  );

  const errorCount = logs.filter((l) => l.status === "error").length;

  return (
    <div className="flex flex-col h-full bg-sidebar border-l border-border">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border flex-shrink-0">
        <span className="text-text-primary text-xs font-semibold flex-1">SQL Query Logs</span>
        <span className="text-[10px] text-text-muted bg-accent px-1.5 py-0.5 rounded">
          {logs.length}
        </span>
        {errorCount > 0 && (
          <span className="text-[10px] text-red-400 bg-red-950/40 px-1.5 py-0.5 rounded">
            {errorCount} err
          </span>
        )}
        <button
          onClick={onClear}
          disabled={logs.length === 0}
          className="p-1 rounded hover:bg-accent text-text-muted hover:text-text-primary disabled:opacity-30 transition-colors"
          title="Clear logs"
        >
          <Trash2 size={13} />
        </button>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-accent text-text-muted hover:text-text-primary transition-colors"
          title="Close"
        >
          <X size={13} />
        </button>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 px-3 py-1.5 border-b border-border flex-shrink-0">
        {(["all", "success", "error"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-2 py-0.5 rounded text-[11px] capitalize transition-colors ${
              filter === f
                ? "bg-highlight text-bg font-medium"
                : "text-text-muted hover:text-text-primary hover:bg-accent"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Log list */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-text-muted text-xs gap-2">
            <Clock size={20} className="opacity-30" />
            <span>{logs.length === 0 ? "No queries yet" : "No matching logs"}</span>
          </div>
        ) : (
          filtered.map((log) => <LogEntry key={log.id} log={log} />)
        )}
      </div>
    </div>
  );
}
