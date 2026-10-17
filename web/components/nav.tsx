"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/agent", label: "Agent" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-6 border-b bg-background px-4">
      <span className="font-semibold">Recall Tracer</span>
      <nav className="flex items-center gap-4 text-sm">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            aria-current={pathname === l.href ? "page" : undefined}
            className={cn("text-muted-foreground hover:text-foreground", pathname === l.href && "text-foreground")}
          >
            {l.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
