'use client';

import { useState } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';

export function AnnouncementBar() {
  const [open, setOpen] = useState(true);
  if (!open) return null;

  return (
    <div className="relative bg-neutral-950 text-neutral-100">
      <div className="mx-auto flex max-w-screen-xl items-center justify-center gap-2 px-10 py-2 text-center text-xs sm:text-sm">
        <span className="rounded-sm bg-white px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-neutral-950">
          New
        </span>
        <Link href="/hub" className="font-semibold hover:underline">
          MCP Market Hub
        </Link>
        <span className="hidden text-neutral-400 sm:inline">
          — Manage the skills and tools your agents use
        </span>
      </div>
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label="Dismiss banner"
        className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 transition-colors hover:text-neutral-100"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
