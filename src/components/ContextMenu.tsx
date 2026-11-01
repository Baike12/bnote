import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  danger?: boolean;
  action: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - rect.width - 8),
      y: Math.min(y, window.innerHeight - rect.height - 8),
    });
  }, [x, y]);

  useEffect(() => {
    // A click inside the menu (picking "rename" for instance) must not trigger
    // the outside-click close: unmounting the menu during the mousedown phase
    // would skip the item's handler, and the stray mouseup/click would land on
    // the element below the menu.
    const close = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="context-menu" style={{ left: pos.x, top: pos.y }}>
      {items.map((item) => (
        <button
          key={item.label}
          className={`context-menu-item${item.danger ? " danger" : ""}`}
          // preventDefault keeps the existing focus (no stealing from the
          // tree/editor); the action runs on the full click, so it has
          // finished before the menu unmounts.
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            item.action();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
