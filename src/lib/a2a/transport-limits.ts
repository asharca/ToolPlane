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
