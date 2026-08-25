import { useState, useRef, useEffect, useMemo } from "react";
import { Hash, Send, Copy, Check, AlignLeft, GitCompare, Trash2 } from "lucide-react";
import type { MqttMessage, MqttTopicNode } from "../types";
import { highlightJson } from "./TableDataView";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Pretty-printed JSON (matching what MessagePayload displays) diffs far more usefully line by
// line than the raw payload string would — a single changed number shouldn't blow up the whole
// object onto one changed "line". Falls back to the raw payload split on newlines for anything
// that isn't a JSON object/array.
//
// Returns both a plain-text version (used to decide what changed) and a syntax-highlighted HTML
// version at the same line indices (used for display) — highlightJson only wraps matched tokens
// in <span>s and never touches "\n", so the two arrays always line up 1:1.
function toDiffLines(payload: string): { plain: string[]; html: string[] } {
  try {
    const parsed = JSON.parse(payload);
    if (typeof parsed === "object" && parsed !== null) {
      return {
        plain: JSON.stringify(parsed, null, 2).split("\n"),
        html: highlightJson(parsed).split("\n"),
      };
    }
  } catch {
    // Not JSON — diff the raw text as-is, HTML-escaped so it's still safe to render as HTML.
  }
  const plain = payload.split("\n");
  return { plain, html: plain.map(escapeHtml) };
}

type DiffLine = { type: "same" | "add" | "remove"; html: string };

// Standard LCS-based line diff — payloads here are single MQTT messages (typically tens of
// lines once pretty-printed), so the O(n*m) table is negligible. Alignment is decided from the
// plain-text lines; the *displayed* line is always the syntax-highlighted HTML version of
// whichever side (old for a removal, new for an addition/unchanged line) it came from.
function diffLines(oldLines: { plain: string[]; html: string[] }, newLines: { plain: string[]; html: string[] }): DiffLine[] {
  const { plain: oldPlain, html: oldHtml } = oldLines;
  const { plain: newPlain, html: newHtml } = newLines;
  const n = oldPlain.length;
  const m = newPlain.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldPlain[i] === newPlain[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldPlain[i] === newPlain[j]) {
      result.push({ type: "same", html: newHtml[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: "remove", html: oldHtml[i] });
      i++;
    } else {
      result.push({ type: "add", html: newHtml[j] });
      j++;
    }
  }
  while (i < n) { result.push({ type: "remove", html: oldHtml[i] }); i++; }
  while (j < m) { result.push({ type: "add", html: newHtml[j] }); j++; }
  return result;
}

// Most MQTT payloads on real-world brokers are JSON — syntax-highlight them (reusing the same
// highlighter as the Mongo JSON view) instead of showing a flat wall of monospace text. Falls
// back to plain text for anything that isn't valid JSON (or is a JSON scalar, not worth the
// highlighting machinery).
function MessagePayload({ payload }: { payload: string }) {
  const html = useMemo(() => {
    try {
      const parsed = JSON.parse(payload);
      if (typeof parsed === "object" && parsed !== null) return highlightJson(parsed);
    } catch {
      // Not JSON — render as plain text below.
    }
    return null;
  }, [payload]);

  if (html !== null) {
    return (
      <pre
        className="text-xs font-mono whitespace-pre-wrap break-all"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return <pre className="text-xs font-mono text-text-primary whitespace-pre-wrap break-all">{payload}</pre>;
}

function MessageMeta({ message, onCopy, copied }: { message: MqttMessage; onCopy: () => void; copied: boolean }) {
  return (
    <div className="flex items-center gap-2 text-[10px] text-text-muted mb-1">
      <span>{new Date(message.timestampMs).toLocaleTimeString()}</span>
      <span>QoS {message.qos}</span>
      {message.retain && <span className="text-yellow-400">retained</span>}
      <div className="flex-1" />
      <button
        onClick={onCopy}
        title="Copy payload"
        className={`flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors ${
          copied
            ? "text-green-400"
            : "text-text-muted opacity-0 group-hover:opacity-100 hover:text-text-primary hover:bg-accent"
        }`}
      >
        {copied ? (
          <>
            <Check size={11} /> Copied
          </>
        ) : (
          <Copy size={11} />
        )}
      </button>
    </div>
  );
}

function useCopyPayload(payload: string) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(payload);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return { copied, handleCopy };
}

function MessageCard({ message }: { message: MqttMessage }) {
  const { copied, handleCopy } = useCopyPayload(message.payload);
  return (
    <div className="group border border-border rounded-lg px-3 py-2 bg-accent/30">
      <MessageMeta message={message} onCopy={handleCopy} copied={copied} />
      <MessagePayload payload={message.payload} />
    </div>
  );
}

// Shows the full current message, same as "Full" view, but with whatever changed since the
// previous message on this topic highlighted in place — unchanged lines stay as plain context
// (so the structure still reads naturally), changed lines are colored red (old value) / green
// (new value), git-diff style. The very first message has nothing to compare against, so it's
// just shown in full with no highlighting.
function DiffMessageCard({ message, prevPayload }: { message: MqttMessage; prevPayload: string | null }) {
  const { copied, handleCopy } = useCopyPayload(message.payload);
  const diff = useMemo(
    () => (prevPayload === null ? null : diffLines(toDiffLines(prevPayload), toDiffLines(message.payload))),
    [prevPayload, message.payload]
  );

  if (!diff) {
    return (
      <div className="group border border-border rounded-lg px-3 py-2 bg-accent/30">
        <MessageMeta message={message} onCopy={handleCopy} copied={copied} />
        <MessagePayload payload={message.payload} />
      </div>
    );
  }

  const added = diff.filter((l) => l.type === "add").length;
  const removed = diff.filter((l) => l.type === "remove").length;

  return (
    <div className="group border border-border rounded-lg px-3 py-2 bg-accent/30">
      <MessageMeta message={message} onCopy={handleCopy} copied={copied} />
      <pre className="text-xs font-mono whitespace-pre-wrap break-all">
        {diff.map((line, idx) => (
          <div
            key={idx}
            className={line.type === "add" ? "bg-green-500/15" : line.type === "remove" ? "bg-red-500/15" : undefined}
            dangerouslySetInnerHTML={{ __html: line.html || "&nbsp;" }}
          />
        ))}
      </pre>
      <p className="text-[10px] text-text-muted mt-1.5">
        {added === 0 && removed === 0 ? (
          "No changes from previous message"
        ) : (
          <>
            Comparing with previous message: <span className="text-green-400">+{added} lines</span>,{" "}
            <span className="text-red-400">-{removed} lines</span>
          </>
        )}
      </p>
    </div>
  );
}

function findNode(root: MqttTopicNode | undefined, topic: string): MqttTopicNode | undefined {
  if (!root) return undefined;
  // No early-return for an empty `topic` here: a topic that starts with "/" (e.g.
  // "/mobis/upload") has "" as its real first segment, and "".split("/") is legitimately
  // [""] — that must still walk into root.children[""], not short-circuit to root itself.
  let node = root;
  for (const seg of topic.split("/")) {
    const child = node.children[seg];
    if (!child) return undefined;
    node = child;
  }
  return node;
}

interface Props {
  connectionId: string;
  topic: string;
  mqttRoot: MqttTopicNode | undefined;
  onPublish: (connectionId: string, topic: string, payload: string, qos: number, retain: boolean) => Promise<void>;
  onClear: () => void;
}

export default function MqttTopicView({ connectionId, topic, mqttRoot, onPublish, onClear }: Props) {
  const node = findNode(mqttRoot, topic);
  const messages = node?.messages ?? [];
  // Newest first, so the latest reading is always right at the top without having to scroll.
  const messagesNewestFirst = useMemo(() => [...messages].reverse(), [messages]);
  const [payload, setPayload] = useState("");
  const [qos, setQos] = useState(0);
  const [retain, setRetain] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"full" | "diff">("full");
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageCount = messages.length;

  // New messages arrive live via the mqtt-message event and appear at the top — keep the log
  // scrolled there so the newest one is always immediately visible.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [messageCount]);

  const handlePublish = async () => {
    if (!payload.trim()) return;
    setPublishing(true);
    setPublishError(null);
    try {
      await onPublish(connectionId, topic, payload, qos, retain);
    } catch (e) {
      setPublishError(String(e));
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-sidebar flex-shrink-0">
        <Hash size={13} className="text-fuchsia-400 flex-shrink-0" />
        <span className="text-sm font-mono text-text-primary truncate flex-1 min-w-0">{topic || "/"}</span>
        <div className="flex items-center bg-accent/60 border border-border rounded-lg p-0.5 flex-shrink-0">
          <button
            onClick={() => setViewMode("full")}
            title="Show full message history"
            className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${
              viewMode === "full" ? "bg-highlight text-white" : "text-text-muted hover:text-text-primary"
            }`}
          >
            <AlignLeft size={12} /> Full
          </button>
          <button
            onClick={() => setViewMode("diff")}
            title="Show the latest message, highlighting what changed since the previous one"
            className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${
              viewMode === "diff" ? "bg-highlight text-white" : "text-text-muted hover:text-text-primary"
            }`}
          >
            <GitCompare size={12} /> Last
          </button>
        </div>
        <span className="text-xs text-text-muted flex-shrink-0">
          {(node?.messageCount ?? 0).toLocaleString()} message{node?.messageCount === 1 ? "" : "s"}
        </span>
        <button
          onClick={onClear}
          disabled={messages.length === 0}
          title="Clear message history for this topic"
          className="p-1 rounded hover:bg-accent text-text-muted hover:text-text-primary disabled:opacity-30 transition-colors flex-shrink-0"
        >
          <Trash2 size={13} />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-text-muted text-sm">
            No messages yet on this topic
          </div>
        ) : viewMode === "full" ? (
          messagesNewestFirst.map((m, i) => <MessageCard key={messages.length - 1 - i} message={m} />)
        ) : (
          // A single live card, not a growing history — it just re-renders in place against
          // the latest message as new ones arrive, showing "what just changed" rather than a
          // scrolling diff-per-message log.
          <DiffMessageCard
            key={messages.length}
            message={messages[messages.length - 1]}
            prevPayload={messages.length > 1 ? messages[messages.length - 2].payload : null}
          />
        )}
      </div>

      <div className="border-t border-border p-3 flex-shrink-0 space-y-2">
        {publishError && (
          <div className="rounded-lg px-3 py-1.5 text-xs bg-red-900/40 text-red-400 border border-red-800">
            {publishError}
          </div>
        )}
        <textarea
          className="w-full bg-accent border border-border rounded-lg px-3 py-2 text-text-primary text-xs font-mono focus:outline-none focus:border-highlight resize-none"
          rows={2}
          placeholder="Payload to publish..."
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handlePublish(); }
          }}
        />
        <div className="flex items-center gap-2">
          <select
            value={qos}
            onChange={(e) => setQos(Number(e.target.value))}
            className="bg-accent border border-border rounded-lg px-2 py-1.5 text-xs text-text-secondary focus:outline-none"
          >
            <option value={0}>QoS 0</option>
            <option value={1}>QoS 1</option>
            <option value={2}>QoS 2</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs text-text-secondary">
            <input type="checkbox" checked={retain} onChange={(e) => setRetain(e.target.checked)} />
            Retain
          </label>
          <div className="flex-1" />
          <button
            onClick={handlePublish}
            disabled={publishing || !payload.trim()}
            title="Publish (Cmd+Enter)"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-highlight text-white hover:bg-highlight/90 transition-colors disabled:opacity-50"
          >
            <Send size={12} /> Publish
          </button>
        </div>
      </div>
    </div>
  );
}
