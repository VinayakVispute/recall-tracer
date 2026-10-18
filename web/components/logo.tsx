import type { SVGProps } from "react";

/** The Recall Tracer mark: an R whose leg is a trace ending at a red node (a store reached). Same shapes as app/icon.svg. */
export function Logo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 32 32" role="img" aria-label="Recall Tracer" {...props}>
      <rect width="32" height="32" rx="7" fill="#0a0a0a" />
      <path d="M10 25 V7 H16.5 A5 5 0 0 1 16.5 17 H10 M15.5 17 L21.5 23.5" fill="none" stroke="#fafafa" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="22.5" cy="24.5" r="3" fill="#f87171" />
    </svg>
  );
}
