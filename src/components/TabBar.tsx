import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import { X, Table, Code2, Plus, Crosshair } from "lucide-react";
import type { Tab } from "../types";

interface Props {
  tabs: Tab[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onReorder: (newOrder: string[]) => void;
  onPromote: (id: string) => void;
  onLocate: (tab: Tab) => void;
  onNewQuery: () => void;
  canNewQuery: boolean;
}

export default function TabBar({
  tabs, activeTabId, onSelect, onClose, onCloseOthers, onReorder,
  onPromote, onLocate, onNewQuery, canNewQuery,
}: Props) {
  const tabsRef = useRef(tabs);
  const onSelectRef = useRef(onSelect);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);

  // ── drag state ─────────────────────────────────────────────────────────────
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [insertIdx, setInsertIdx] = useState<number | null>(null);

  // id → DOM element (populated by ref callbacks on each tab)
  const tabEls = useRef(new Map<string, HTMLElement>());
  // id → offsetLeft snapshot taken BEFORE a state update (layout pos, no transform)
  const prevOffsets = useRef(new Map<string, number>());
  // The container must be `position:relative` so it becomes offsetParent for all tabs
  const containerRef = useRef<HTMLDivElement>(null);

  // Visual order during drag: insert dragged tab at the current insertIdx position
  const displayTabs = useMemo(() => {
    if (!draggedId || insertIdx === null) return tabs;
    const dragged = tabs.find(t => t.id === draggedId);
    if (!dragged) return tabs;
    const without = tabs.filter(t => t.id !== draggedId);
    const result = [...without];
    result.splice(Math.min(insertIdx, without.length), 0, dragged);
    return result;
  }, [tabs, draggedId, insertIdx]);

  // FLIP animation: runs after every displayTabs change while dragging
  useLayoutEffect(() => {
    if (!draggedId) {
      // Drag ended – wipe any leftover styles immediately
      tabEls.current.forEach(el => { el.style.transition = ""; el.style.transform = ""; });
      return;
    }

    tabEls.current.forEach((el, id) => {
      if (id === draggedId) return; // dragged tab uses its own opacity/scale style

      const prevLeft = prevOffsets.current.get(id);
      if (prevLeft === undefined) return;

      // 1. Cancel any ongoing animation and resolve the element to its true layout position.
      //    This all happens before paint (useLayoutEffect is synchronous), so no visible jump.
      el.style.transition = "none";
      el.style.transform = "";
      void el.offsetWidth; // force layout reflow so offsetLeft is accurate

      // 2. Compute how far the element has moved since the snapshot.
      const dx = prevLeft - el.offsetLeft;
      if (Math.abs(dx) < 0.5) return;

      // 3. FLIP: jump to where it was, then animate to where it is now.
      el.style.transform = `translateX(${dx}px)`;
      void el.offsetWidth; // flush so the browser registers the starting transform
      el.style.transition = "transform 160ms ease";
      el.style.transform = ""; // animate to layout position
    });
  }, [displayTabs, draggedId]);

  // Snapshot: record the current offsetLeft of every tab BEFORE a state update.
  // offsetLeft is unaffected by CSS transforms, so it always reflects the true layout pos.
  const snapshot = useCallback(() => {
    prevOffsets.current.clear();
    tabEls.current.forEach((el, id) => {
      prevOffsets.current.set(id, el.offsetLeft);
    });
  }, []);

  const startDrag = useCallback((e: React.MouseEvent, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();

    const ts = tabsRef.current;
    const originalIdx = ts.findIndex(t => t.id === id);
    // insertIdx lives in the "without dragged" index space.
    // Keeping it at originalIdx keeps the display order unchanged initially.
    let curInsertIdx = originalIdx;
    let didMove = false;
    const startX = e.clientX;

    snapshot();
    setDraggedId(id);
    setInsertIdx(curInsertIdx);

    const onMove = (ev: MouseEvent) => {
      if (Math.abs(ev.clientX - startX) > 4) didMove = true;

      const container = containerRef.current;
      if (!container) return;

      // cursorX in the container's scroll coordinate space.
      // container is position:relative, so el.offsetLeft is relative to container.
      const rect = container.getBoundingClientRect();
      const cursorX = ev.clientX - rect.left + container.scrollLeft;

      // Non-dragged tabs are always laid out in their original relative order inside
      // displayTabs, so their offsetLeft values are monotonically increasing.
      const withoutDragged = tabsRef.current.filter(t => t.id !== id);
      let newIdx = withoutDragged.length; // default: end
      for (let i = 0; i < withoutDragged.length; i++) {
        const el = tabEls.current.get(withoutDragged[i].id);
        if (!el) continue;
        if (cursorX < el.offsetLeft + el.offsetWidth / 2) {
          newIdx = i;
          break;
        }
      }

      if (newIdx !== curInsertIdx) {
        curInsertIdx = newIdx;
        snapshot(); // snapshot BEFORE the state update that triggers re-render
        setInsertIdx(newIdx);
      }
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);

      // Clear styles before committing so there's no leftover transform during re-render
      tabEls.current.forEach(el => { el.style.transform = ""; el.style.transition = ""; });

      if (didMove) {
        const without = tabsRef.current.filter(t => t.id !== id).map(t => t.id);
        without.splice(Math.min(curInsertIdx, without.length), 0, id);
        onReorder(without);
      } else {
        onSelectRef.current(id);
      }

      setDraggedId(null);
      setInsertIdx(null);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [onReorder, snapshot]);

  // ── context menu ────────────────────────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const ctxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtxMenu(null);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setCtxMenu(null); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [ctxMenu]);

  if (tabs.length === 0 && !canNewQuery) return null;

  return (
    // position:relative makes this the offsetParent for all direct children,
    // so el.offsetLeft is always relative to this container's padding edge.
    <div
      ref={containerRef}
      className="relative flex items-center gap-1 bg-sidebar border-b border-border overflow-x-auto flex-shrink-0 px-2 py-1.5"
    >
      {displayTabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const isDragging = tab.id === draggedId;

        return (
          <div
            key={tab.id}
            ref={(el) => {
              if (el) tabEls.current.set(tab.id, el);
              else tabEls.current.delete(tab.id);
            }}
            onMouseDown={(e) => {
              if (e.button === 1) { e.preventDefault(); return; }
              if (e.button === 0) startDrag(e, tab.id);
            }}
            onMouseUp={(e) => { if (e.button === 1) onClose(tab.id); }}
            onDoubleClick={() => { if (!draggedId) onPromote(tab.id); }}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
            }}
            className={[
              "flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5 rounded-lg flex-shrink-0 group select-none",
              "cursor-grab active:cursor-grabbing",
              isDragging
                ? "opacity-40 scale-95 ring-1 ring-highlight/40"
                : "transition-colors",
              isActive && !isDragging
                ? "bg-highlight/15 text-text-primary ring-1 ring-inset ring-highlight/30"
                : !isActive && !isDragging
                ? "text-text-muted hover:text-text-secondary hover:bg-accent/50"
                : "",
            ].join(" ")}
            title={tab.preview ? "Preview tab — double-click to keep open" : undefined}
          >
            {tab.type === "table" ? (
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onLocate(tab); }}
                title="Show in structure"
                className="relative flex-shrink-0 -ml-0.5 p-0.5 rounded leading-none"
              >
                <Table size={13} className={`block group-hover:hidden ${isActive ? "text-blue-300" : "text-text-muted"}`} />
                <Crosshair size={13} className={`hidden group-hover:block ${isActive ? "text-blue-300" : "text-text-muted"} hover:text-highlight transition-colors`} />
              </button>
            ) : (
              <Code2 size={13} className={isActive ? "text-highlight" : "text-text-muted"} />
            )}
            <span className={`text-xs max-w-[140px] truncate ${tab.preview ? "italic" : ""}`}>{tab.title}</span>
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
              className="ml-0.5 rounded-md hover:bg-border p-0.5 text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <X size={11} />
            </button>
          </div>
        );
      })}

      {canNewQuery && (
        <button
          onClick={onNewQuery}
          title="New query editor"
          className="flex items-center justify-center p-1.5 rounded-lg flex-shrink-0 text-text-muted hover:text-highlight hover:bg-accent/50 transition-colors"
        >
          <Plus size={15} />
        </button>
      )}

      {ctxMenu && (
        <div
          ref={ctxRef}
          style={{ position: "fixed", left: ctxMenu.x, top: ctxMenu.y, zIndex: 9999, minWidth: 160 }}
          className="bg-sidebar border border-border rounded-lg shadow-2xl py-1"
        >
          <button
            onClick={() => { onClose(ctxMenu.tabId); setCtxMenu(null); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text-primary hover:bg-accent transition-colors text-left"
          >
            <X size={12} className="text-text-muted" /> Close
          </button>
          {tabs.length > 1 && (
            <button
              onClick={() => { onCloseOthers(ctxMenu.tabId); setCtxMenu(null); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text-primary hover:bg-accent transition-colors text-left"
            >
              <X size={12} className="text-text-muted" /> Close Other Tabs
            </button>
          )}
        </div>
      )}
    </div>
  );
}
