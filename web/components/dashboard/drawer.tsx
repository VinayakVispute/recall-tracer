"use client";

import { useEffect, useRef } from "react";

/**
 * A side panel over the dashboard. Escape or a click on the backdrop closes it; focus moves into the panel
 * and goes back to whatever opened it (a table row, a network node, a notice pip).
 */
export function Drawer({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    opener.current = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => { if (opener.current?.isConnected) opener.current.focus(); };
  }, []);
  // A different store in the same drawer starts at the top.
  useEffect(() => { panel.current?.scrollTo({ top: 0 }); }, [label]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="presentation">
      <div className="absolute inset-0 bg-background/60 backdrop-blur-[1px]" onClick={onClose} aria-hidden="true" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="relative h-full w-full max-w-xl overflow-y-auto border-l bg-background p-3 shadow-xl outline-none animate-in slide-in-from-right duration-200"
        style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))", paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        {children}
      </div>
    </div>
  );
}
