import { useRef, useEffect } from "react";
import { Copy, Scissors, Clipboard, Eraser, RotateCcw } from "lucide-react";

interface Props {
  x: number;
  y: number;
  onClose: () => void;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  onSetNull: () => void;
  onSetDefault?: () => void;
  hasDefault?: boolean;
}

export default function EditCellCtxMenu({ x, y, onClose, onCopy, onCut, onPaste, onSetNull, onSetDefault, hasDefault }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); };
  }, [onClose]);

  const menuW = 200;
  const menuH = hasDefault ? 150 : 120;
  const left = x + menuW > window.innerWidth ? x - menuW : x;
  const top = y + menuH > window.innerHeight ? y - menuH : y;

  const btn = (label: string, icon: React.ReactNode, onClick: () => void, danger = false) => (
    <button
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => { onClick(); onClose(); }}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors ${danger ? "text-red-400 hover:bg-red-500/10" : "text-text-primary hover:bg-accent"}`}
    >
      <span className="text-text-muted w-3.5 flex-shrink-0">{icon}</span>{label}
    </button>
  );

  return (
    <div ref={ref} style={{ position: "fixed", left, top, zIndex: 9999, minWidth: menuW }} className="bg-sidebar border border-border rounded-lg shadow-2xl py-1">
      {btn("Copy", <Copy size={12} />, onCopy)}
      {btn("Cut", <Scissors size={12} />, onCut)}
      {btn("Paste", <Clipboard size={12} />, onPaste)}
      <div className="my-1 border-t border-border" />
      {btn("Set NULL", <Eraser size={12} />, onSetNull)}
      {hasDefault && onSetDefault && btn("Set Default", <RotateCcw size={12} />, onSetDefault)}
    </div>
  );
}
