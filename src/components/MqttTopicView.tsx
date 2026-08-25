import { useState, useRef, useEffect } from "react";
import { Hash, Send } from "lucide-react";
import type { MqttTopicNode } from "../types";

function findNode(root: MqttTopicNode | undefined, topic: string): MqttTopicNode | undefined {
  if (!root) return undefined;
  if (!topic) return root;
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
}

export default function MqttTopicView({ connectionId, topic, mqttRoot, onPublish }: Props) {
  const node = findNode(mqttRoot, topic);
  const messages = node?.messages ?? [];
  const [payload, setPayload] = useState("");
  const [qos, setQos] = useState(0);
  const [retain, setRetain] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageCount = messages.length;

  // New messages arrive live via the mqtt-message event — keep the log pinned to the bottom.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
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
        <span className="text-sm font-mono text-text-primary truncate">{topic || "/"}</span>
        <span className="text-xs text-text-muted ml-auto flex-shrink-0">
          {(node?.messageCount ?? 0).toLocaleString()} message{node?.messageCount === 1 ? "" : "s"}
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-text-muted text-sm">
            No messages yet on this topic
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className="border border-border rounded-lg px-3 py-2 bg-accent/30">
              <div className="flex items-center gap-2 text-[10px] text-text-muted mb-1">
                <span>{new Date(m.timestampMs).toLocaleTimeString()}</span>
                <span>QoS {m.qos}</span>
                {m.retain && <span className="text-yellow-400">retained</span>}
              </div>
              <pre className="text-xs font-mono text-text-primary whitespace-pre-wrap break-all">{m.payload}</pre>
            </div>
          ))
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
