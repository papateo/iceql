import { useState } from "react";
import { ChevronRight, ChevronDown, Hash } from "lucide-react";
import type { MqttTopicNode } from "../types";

// MQTT has no schema to browse up front — this tree is built entirely from topics the live
// message stream has actually seen (see insertMqttMessage in appStore.ts), so it grows on its
// own as messages arrive, the same way MQTT Explorer's topic tree does.
export default function MqttTopicTree({
  node,
  depth,
  configId,
  onOpenTopic,
}: {
  node: MqttTopicNode;
  depth: number;
  configId: string;
  onOpenTopic: (configId: string, topic: string) => void;
}) {
  const children = Object.values(node.children).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      {children.map((child) => (
        <MqttTopicRow key={child.fullPath} node={child} depth={depth} configId={configId} onOpenTopic={onOpenTopic} />
      ))}
    </>
  );
}

function MqttTopicRow({
  node,
  depth,
  configId,
  onOpenTopic,
}: {
  node: MqttTopicNode;
  depth: number;
  configId: string;
  onOpenTopic: (configId: string, topic: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = Object.keys(node.children).length > 0;

  return (
    <div>
      <div
        className="flex items-center gap-1 pr-2 py-1 hover:bg-accent/60 cursor-pointer group"
        style={{ paddingLeft: 12 + depth * 14 }}
        onClick={() => onOpenTopic(configId, node.fullPath)}
      >
        {hasChildren ? (
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
            className="flex-shrink-0 p-0.5 -ml-0.5 rounded hover:bg-accent text-text-muted transition-colors"
          >
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
        ) : (
          <span className="w-4 flex-shrink-0" />
        )}
        <Hash size={12} className="text-fuchsia-400 flex-shrink-0" />
        <span className="flex-1 text-xs text-text-secondary truncate min-w-0">{node.name}</span>
        {node.messageCount > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent text-text-muted flex-shrink-0">
            {node.messageCount}
          </span>
        )}
      </div>
      {hasChildren && expanded && (
        <MqttTopicTree node={node} depth={depth + 1} configId={configId} onOpenTopic={onOpenTopic} />
      )}
    </div>
  );
}
