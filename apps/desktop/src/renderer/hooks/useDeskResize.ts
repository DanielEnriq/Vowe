import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { PANEL_RIGHT, PANEL_RIGHT_CLOSE_AT, PANEL_RIGHT_MAX, PANEL_RIGHT_MIN } from '../../shared/layout.js';

/** The same desk geometry in Project and Session rooms. */
export function useDeskResize(onClose: () => void) {
  const [width, setWidth] = useState(PANEL_RIGHT);
  const [resizing, setResizing] = useState(false);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  const startDeskResize = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    cleanup.current?.();
    setResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    let frame: number | null = null;
    const stop = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setResizing(false);
      cleanup.current = null;
    };
    const move = (moved: MouseEvent) => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const fromRight = window.innerWidth - moved.clientX;
        if (fromRight < PANEL_RIGHT_CLOSE_AT) {
          stop();
          setWidth(PANEL_RIGHT_MIN);
          onClose();
        } else setWidth(Math.max(PANEL_RIGHT_MIN, Math.min(PANEL_RIGHT_MAX, fromRight)));
      });
    };
    cleanup.current = stop;
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
  }, [onClose]);
  return { deskWidth: width, deskResizing: resizing, startDeskResize };
}
