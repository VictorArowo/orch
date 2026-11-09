"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

const MIN = 300;
const maxWidth = () => Math.max(MIN, Math.round(window.innerWidth * 0.7));

function stored(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v >= MIN ? v : fallback;
  } catch {
    return fallback;
  }
}

// The panel on the right of the editor and the run view. Drag its left edge
// (or focus the edge and use the arrow keys) to resize; the width is kept.
export function SidePanel({ storageKey, defaultWidth, children }: { storageKey: string; defaultWidth: number; children: ReactNode }) {
  const [width, setWidth] = useState(defaultWidth);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => setWidth(stored(storageKey, defaultWidth)), [storageKey, defaultWidth]);

  const commit = useCallback(
    (w: number) => {
      const clamped = Math.min(maxWidth(), Math.max(MIN, Math.round(w)));
      setWidth(clamped);
      try {
        localStorage.setItem(storageKey, String(clamped));
      } catch {
        // Not remembered, which is fine.
      }
    },
    [storageKey],
  );

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const right = ref.current?.getBoundingClientRect().right ?? window.innerWidth;
      commit(right - e.clientX);
    };
    const up = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging, commit]);

  return (
    <aside ref={ref} style={{ width }} className="relative shrink-0 border-t border-l border-rule bg-sheet">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the side panel"
        aria-valuenow={width}
        aria-valuemin={MIN}
        tabIndex={0}
        onPointerDown={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDoubleClick={() => commit(defaultWidth)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") commit(width + 24);
          if (e.key === "ArrowRight") commit(width - 24);
        }}
        className={`group absolute inset-y-0 -left-1.5 z-10 w-3 cursor-col-resize focus:outline-none`}
        title="Drag to resize; double-click to reset"
      >
        <div className={`mx-auto h-full w-px transition-colors ${dragging ? "bg-blue" : "bg-transparent group-hover:bg-blue/60 group-focus-visible:bg-blue"}`} />
      </div>
      <div className="scroll-thin h-full overflow-y-auto px-5 py-5">{children}</div>
    </aside>
  );
}
