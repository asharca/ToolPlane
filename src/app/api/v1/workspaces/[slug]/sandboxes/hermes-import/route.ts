import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Hermes archive imports were removed with the Hermes runtime. The path is
// kept as an explicit tombstone so older dashboards and scripts get a clear
// 410 instead of a 404 or a silently ignored upload.
export function POST() {
  return NextResponse.json(
    {
      error:
        "Hermes archive import has been removed. Create a sandbox from an image or connect a machine instead.",
    },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
