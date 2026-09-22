import 'server-only';
import { Client } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { ownership } from './ownership-state';

type OwnershipClient = Pick<Client, 'connect' | 'query' | 'end' | 'on'>;
const OWNER_LOCK_NAMESPACE = 0x54504c4e;
export class RuntimeOwnerLease {
  private connected = false;
  private locked = false;
  private stopping = false;
  private lost = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private probing = false;
  readonly id = randomUUID();
  readonly markerKey: string;
  readonly domainKey: number;
  constructor(private readonly client: OwnershipClient, domain = 'default', private readonly acknowledge?: string,
    private readonly onLost: () => void = () => ownership.lose()) {
    this.domainKey = createHash('sha256').update(domain).digest().readInt32BE();
    this.markerKey = `runtime.owner.${this.domainKey}`;
  }
  private lose() {
    if (this.stopping || this.lost) return;
    this.lost = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.onLost();
  }
  private async probe() {
    if (this.stopping || this.lost || this.probing) return;
    this.probing = true;
    try { await this.client.query('SELECT 1'); } catch { this.lose(); }
    finally { this.probing = false; }
  }
  async acquire() {
    this.client.on('error', () => this.lose());
    this.client.on('end', () => { if (this.locked) this.lose(); });
    await this.client.connect(); this.connected = true;
    const lock = await this.client.query('SELECT pg_try_advisory_lock($1, $2) AS locked', [OWNER_LOCK_NAMESPACE, this.domainKey]);
    if (!lock.rows[0]?.locked) throw new Error('Another ToolPlane process owns this runtime domain.');
    this.locked = true;
    const prior = await this.client.query('SELECT value FROM "SystemSetting" WHERE key = $1', [this.markerKey]);
    const previousOwner = prior.rows[0]?.value;
    if (previousOwner && (typeof previousOwner !== 'string' || !/^[0-9a-f-]{36}$/i.test(previousOwner))) {
      throw new Error('Invalid runtime owner recovery marker. Inspect the runtime domain before recovery.');
    }
    if (previousOwner && previousOwner !== this.acknowledge) {
      throw new Error(`Unclean runtime shutdown. Stop the previous owner and confirm external operations have ended, then set TOOLPLANE_RUNTIME_RECOVERY_ACK=${previousOwner} for one restart.`);
    }
    await this.client.query('INSERT INTO "SystemSetting" (key, value, "updatedAt") VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()', [this.markerKey, this.id]);
    // A silent network partition may not emit an error immediately. Each probe
    // uses this dedicated connection's query_timeout; never queue probes.
    this.heartbeat = setInterval(() => { void this.probe(); }, 5000);
    this.heartbeat.unref?.();
  }
  async release(clean: boolean) {
    this.stopping = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.connected) {
      try {
        if (clean && this.locked) await this.client.query('DELETE FROM "SystemSetting" WHERE key = $1 AND value = $2', [this.markerKey, this.id]);
        // The advisory lock is session-scoped and released only by this same dedicated connection.
      } finally { await this.client.end().catch(() => undefined); this.connected = false; this.locked = false; }
    }
  }
}
const g = globalThis as typeof globalThis & { __toolplaneOwnerLease?: RuntimeOwnerLease; __toolplaneShutdown?: () => Promise<boolean>; __toolplaneStopTimers?: () => void };
let shutdownPromise: Promise<boolean> | undefined;
export async function startRuntimeOwner(recover: () => Promise<void>) {
  if (g.__toolplaneOwnerLease) return;
  ownership.status = 'acquiring';
  const lease = new RuntimeOwnerLease(new Client({ connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000, query_timeout: 5000, application_name: 'toolplane-runtime-owner' }),
  process.env.TOOLPLANE_RUNTIME_DOMAIN || 'default', process.env.TOOLPLANE_RUNTIME_RECOVERY_ACK, () => {
    ownership.lose(); g.__toolplaneStopTimers?.(); void shutdownRuntimeOwner();
  });
  g.__toolplaneOwnerLease = lease;
  g.__toolplaneShutdown = shutdownRuntimeOwner;
  try {
    await lease.acquire();
    if (ownership.status !== 'acquiring') throw new Error('Runtime ownership connection was lost.');
    ownership.status = 'recovering';
    await ownership.maintenance.run(true, recover);
    ownership.ready();
  } catch (error) {
    if (!ownership.abort.signal.aborted) ownership.status = 'blocked';
    g.__toolplaneStopTimers?.();
    // Never clear an unclean marker or pretend partial recovery succeeded.
    ownership.uncertain = true;
    await shutdownRuntimeOwner();
    ownership.status = 'blocked';
    throw error;
  }
}
export function shutdownRuntimeOwner(): Promise<boolean> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const lost = ownership.status === 'lost';
    if (!lost) ownership.status = 'draining';
    g.__toolplaneStopTimers?.();
    const stop = async () => {
      const work = await import('@/lib/work/coordinator'); work.stopWorkCoordinator();
      (await import('@/lib/a2a/worker')).stopA2AWorker();
      const channels = await import('@/lib/agents/channel-runtime');
      const connectors = await import('@/lib/sandboxes/connector-broker');
      const dashboard = await import('@/lib/agents/hermes/dashboard-broker');
      const results = await Promise.allSettled([channels.shutdownAgentChannelRunners(), connectors.shutdownConnectorBroker(), dashboard.closeHermesDashboardBroker()]);
      if (results.some((result) => result.status === 'rejected')) ownership.uncertain = true;
      // Stops only children held by this process; no takeover of external container state.
      await (await import('@/lib/process/supervisor')).shutdownOwnedProcesses();
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    try {
      stopped = await Promise.race([
        ownership.maintenance.run(true, stop).then(() => true),
        new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), 40_000); }),
      ]);
    } catch { ownership.uncertain = true; }
    finally { if (timeout) clearTimeout(timeout); }
    if (!stopped) { ownership.uncertain = true; ownership.abort.abort(); }
    const drained = await ownership.drain(5000);
    const clean = !lost && stopped && drained;
    await g.__toolplaneOwnerLease?.release(clean);
    ownership.status = 'stopped';
    return clean;
  })();
  return shutdownPromise;
}
