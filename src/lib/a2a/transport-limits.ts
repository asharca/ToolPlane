import { A2AHttpError } from './principal';
/** Limits observers, not durable work. An HTTP disconnect only releases this slot. */
export class ObservationLimiter {
  private total = 0;
  private readonly owners = new Map<string, number>();
  constructor(private readonly perOwner = 8, private readonly capacity = 64) {}
  acquire(owner: string): () => void {
    const count = this.owners.get(owner) ?? 0;
    if (count >= this.perOwner || this.total >= this.capacity) throw new A2AHttpError(429, 'Too many active task observers.');
    this.total++; this.owners.set(owner, count + 1);
    let released = false;
    return () => {
      if (released) return; released = true; this.total--;
      const next = (this.owners.get(owner) ?? 1) - 1;
      if (next) this.owners.set(owner, next); else this.owners.delete(owner);
    };
  }
}

/** Bounded per-identity request admission; no credentials or message content in keys. */
export class WindowLimiter {
  private readonly entries = new Map<string, { count: number; until: number }>();
  constructor(private readonly perMinute: number, private readonly capacity: number) {}
  take(key: string, now = Date.now()) {
    if (this.entries.size >= this.capacity) {
      for (const [id, entry] of this.entries) if (entry.until <= now) this.entries.delete(id);
    }
    const current = this.entries.get(key);
    if (!current || current.until <= now) {
      if (!current && this.entries.size >= this.capacity) throw new A2AHttpError(429, 'Request admission is full.');
      this.entries.set(key, { count: 1, until: now + 60_000 }); return;
    }
    if (++current.count > this.perMinute) throw new A2AHttpError(429, 'Too many A2A requests.');
  }
}
