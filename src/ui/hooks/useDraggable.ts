import { useCallback, useRef, useState } from "react";

type Pos = { x: number; y: number };

/**
 * Makes a floating panel draggable by a handle element.
 * Attach `onMouseDown` to the drag handle (e.g. the header) and spread
 * `style` onto the panel. Until the user drags, `style` is undefined so the
 * panel keeps its CSS-defined default (centered) position.
 */
export function useDraggable(panelSelector = ".settings-panel") {
  const [pos, setPos] = useState<Pos | null>(null);
  const drag = useRef({ active: false, ox: 0, oy: 0 });

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Don't start a drag when grabbing the close button, etc.
      if ((e.target as HTMLElement).closest("button")) return;

      const panel = (e.currentTarget as HTMLElement).closest(
        panelSelector,
      ) as HTMLElement | null;
      if (!panel) return;

      const rect = panel.getBoundingClientRect();
      drag.current = {
        active: true,
        ox: e.clientX - rect.left,
        oy: e.clientY - rect.top,
      };

      const clamp = (v: number, max: number) => Math.max(8, Math.min(v, max));

      const move = (ev: MouseEvent) => {
        if (!drag.current.active) return;
        const x = clamp(ev.clientX - drag.current.ox, window.innerWidth - rect.width - 8);
        const y = clamp(ev.clientY - drag.current.oy, window.innerHeight - 48);
        setPos({ x, y });
      };
      const up = () => {
        drag.current.active = false;
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };

      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      e.preventDefault();
    },
    [panelSelector],
  );

  const style: React.CSSProperties | undefined = pos
    ? { left: pos.x, top: pos.y, transform: "none" }
    : undefined;

  return { onMouseDown, style, moved: pos !== null };
}
