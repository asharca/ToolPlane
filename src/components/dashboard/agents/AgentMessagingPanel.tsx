'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRightLeft, FileText, LoaderCircle, Pencil, Plus, QrCode, Radio, Trash2, X } from 'lucide-react';
import { IconButton } from '@asharca/ui';
import { Dialog, DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/Dialog';
import { CopyButton } from '@/components/dashboard/CopyButton';
import { QrPairingDisplay } from '@/components/dashboard/agents/QrPairingDisplay';
import type { AgentChannelConnectionClientView as Channel } from '@/lib/agents/channel-connection-client';
import type { AgentChannelLogEntry } from '@/lib/agents/channel-runtime-logs';
import { getMessagingPlatform, hasBuiltInPairingProvider, type MessagingCredential, type MessagingPlatformSlug } from '@/lib/agents/platforms';

const PLATFORMS: MessagingPlatformSlug[] = ['feishu', 'telegram', 'qqbot', 'weixin', 'discord', 'slack'];
const ICONS: Record<string, string> = {
  feishu: 'feishu.jpeg', telegram: 'telegram.png', qqbot: 'qq.svg',
  weixin: 'wechat.png', discord: 'discord.svg', slack: 'slack.svg',
};
const PRIMARY_FIELDS: Partial<Record<MessagingPlatformSlug, string[]>> = {
  feishu: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_ENCRYPT_KEY', 'FEISHU_VERIFICATION_TOKEN', 'FEISHU_DOMAIN', 'FEISHU_ALLOWED_CHATS'],
  telegram: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_CHATS'],
  qqbot: ['QQBOT_APP_ID', 'QQBOT_SECRET', 'QQBOT_ALLOWED_CHATS', 'QQBOT_REQUIRE_MENTION'],
  weixin: [],
  discord: ['DISCORD_BOT_TOKEN', 'DISCORD_ALLOWED_CHANNELS'],
  slack: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_ALLOWED_CHANNELS'],
};
type Agent = { id: string; name: string };
type Sandbox = { id: string; name: string; agentId: string | null; agentName: string | null };
type Command = {
  action: 'create' | 'update' | 'delete' | 'start' | 'stop' | 'pair' | 'check' | 'apply' | 'move';
  connectionId?: string;
  platform?: string;
  name?: string;
  agentId?: string | null;
  sandboxId?: string;
  credentials?: Record<string, string>;
  allowedUserIds?: string;
};
type ChannelResponse = { connections?: Channel[]; agents?: Agent[]; sandboxes?: Sandbox[]; connectionId?: string; error?: string };

function PlatformIcon({ platform }: { platform: string }) {
  return ICONS[platform]
    // These small, local brand assets retain their intrinsic colors.
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={`/images/channels/${ICONS[platform]}`} alt="" width={20} height={20} className="size-5 shrink-0 rounded-sm object-contain" />
    : <Radio className="size-5 shrink-0 text-muted-foreground" />;
}

function ChannelDialog({ title, onClose, children, wide = false }: {
  title: string; onClose: () => void; children: ReactNode; wide?: boolean;
}) {
  const t = useTranslations('console.agentMessaging');
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPortal>
        <DialogOverlay />
        <DialogContent aria-describedby={undefined} onPointerDownOutside={(event) => event.preventDefault()}
          className={`!w-[calc(100vw-2rem)] !max-h-[calc(100dvh-2rem)] !overflow-y-auto !rounded-lg !p-5 ${wide ? '!max-w-2xl' : '!max-w-lg'}`}>
          <header className="mb-4 flex min-w-0 items-center justify-between gap-3">
            <DialogTitle className="min-w-0 break-words !text-base !tracking-normal">{title}</DialogTitle>
            <DialogClose asChild><IconButton icon={<X className="size-4" />} label={t('close')} variant="ghost" size="sm" /></DialogClose>
          </header>
          {children}
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}

function ChannelLogs({ endpoint, channel, onClose }: { endpoint: string; channel: Channel; onClose: () => void }) {
  const t = useTranslations('console.agentMessaging');
  const [logs, setLogs] = useState<AgentChannelLogEntry[]>([]);
  const [error, setError] = useState('');
  const requestFailed = t('requestFailed');
  const tail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      try {
        const response = await fetch(`${endpoint}?logs=${encodeURIComponent(channel.id)}`, { cache: 'no-store', signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || requestFailed);
        if (!cancelled) { setLogs(data.logs); setError(''); }
      } catch (error) {
        if (!cancelled) setError(error instanceof Error ? error.message : requestFailed);
      }
      if (!cancelled) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
  }, [endpoint, channel.id, requestFailed]);
  const lastTimestamp = logs.at(-1)?.timestamp;
  useEffect(() => { tail.current?.scrollIntoView({ block: 'nearest' }); }, [lastTimestamp]);
  const text = logs.map((entry) => `${new Date(entry.timestamp).toLocaleTimeString()} [${entry.level.toUpperCase()}] ${entry.message}`).join('\n');
  return (
    <ChannelDialog title={`${channel.name} · ${t('logs')}`} onClose={onClose} wide>
      <div className="mb-2 flex justify-end"><CopyButton text={text} label={t('copyLogs')} iconOnly /></div>
      {error && <p role="alert" className="mb-2 text-sm text-red-600">{error}</p>}
      <div className="h-80 overflow-auto rounded-md bg-muted/50 p-3 font-mono text-xs leading-5" role="log" aria-label={t('logs')}>
        {!logs.length && <p className="py-12 text-center text-muted-foreground">{t('noLogs')}</p>}
        {logs.map((entry, index) => <div key={`${entry.timestamp}:${index}`} className={`whitespace-pre-wrap break-all ${entry.level === 'error' ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}>
          {new Date(entry.timestamp).toLocaleTimeString()} [{entry.level.toUpperCase()}] {entry.message}
        </div>)}
        <div ref={tail} />
      </div>
    </ChannelDialog>
  );
}

function ChannelCommands() {
  const t = useTranslations('console.agentMessaging');
  return <section className="border-t border-border pt-3" aria-label={t('supportedCommands')}>
    <h3 className="mb-2 text-xs font-medium">{t('supportedCommands')}</h3>
    <dl className="space-y-2 text-xs">
      {(['new', 'compact', 'help', 'whoami'] as const).map((command) => <div key={command} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
        <dt className="font-mono">/{command}</dt><dd className="break-words text-muted-foreground">{t({ new: 'commandsNew', compact: 'commandsCompact', help: 'commandsHelp', whoami: 'commandsWhoami' }[command])}</dd>
      </div>)}
    </dl>
  </section>;
}

function ChannelEditor({ channel, agents, pending, error, send, onClose }: {
  channel: Channel; agents: Agent[]; pending: boolean; error: string;
  send: (command: Command) => Promise<ChannelResponse | null>; onClose: () => void;
}) {
  const t = useTranslations('console.agentMessaging');
  const platform = getMessagingPlatform(channel.platform)!;
  const [name, setName] = useState(channel.name);
  const [agentId, setAgentId] = useState(channel.agentId ?? '');
  const [values, setValues] = useState<Record<string, string>>({});
  const [allowedUsers, setAllowedUsers] = useState<string | null>(null);
  const pairing = channel.pairing;
  const waiting = pairing?.status === 'waiting' || pairing?.status === 'scanned';
  const needsApply = pairing?.provider === 'telegram_managed_bot' && pairing.status === 'ready' && !pairing.extra?.allowedUserIds;
  const credentialValue = (key: string, fallback = '') => values[key] ?? channel.credentialValues[key] ?? fallback;
  const update = (changes: Omit<Command, 'action' | 'connectionId'>) => send({ action: 'update', connectionId: channel.id, ...changes });
  const saveCredentials = async (credentials: Record<string, string>) => {
    if (!await update({ credentials })) return;
    setValues((current) => {
      const next = { ...current };
      for (const [key, value] of Object.entries(credentials)) {
        if (next[key] === value) delete next[key];
      }
      return next;
    });
  };
  const saveField = (key: string) => {
    if (values[key] !== undefined && values[key] !== (channel.credentialValues[key] ?? '')) {
      void saveCredentials({ [key]: values[key] });
    }
  };
  const primary = PRIMARY_FIELDS[channel.platform];
  const fields = platform.credentials.filter((field) => !primary || primary.includes(field.name));
  const advanced = platform.credentials.filter((field) => primary && !primary.includes(field.name));
  const renderField = (field: MessagingCredential) => {
    const label = t.has?.(`fields.${field.name}`) ? t(`fields.${field.name}`) : field.label;
    const value = credentialValue(field.name, field.defaultValue);
    const boolean = field.inputType === 'boolean';
    return <label key={field.name} className={`block space-y-1.5 text-xs ${boolean || field.secret || field.name.includes('ALLOWED') ? 'sm:col-span-2' : ''}`}>
      <span className="font-medium">{label}</span>
      {boolean ? <input type="checkbox" role="switch" aria-label={label} checked={value === 'true'} className="ml-3 accent-brand"
        onChange={(event) => { setValues((current) => ({ ...current, [field.name]: String(event.target.checked) })); void saveCredentials({ [field.name]: String(event.target.checked) }); }} />
        : field.options ? <select aria-label={label} className="ui-input h-9 w-full text-sm" value={value} onChange={(event) => {
          setValues((current) => ({ ...current, [field.name]: event.target.value }));
          void saveCredentials({ [field.name]: event.target.value });
        }}>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        : <input type={field.secret ? 'password' : 'text'} autoComplete={field.secret ? 'new-password' : 'off'} value={value}
          maxLength={8000} className="ui-input h-9 w-full text-sm" aria-label={label}
          placeholder={field.secret && channel.credentialNames.includes(field.name) ? t('secretSaved') : field.placeholder}
          onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))} onBlur={() => saveField(field.name)} />}
    </label>;
  };
  return (
    <ChannelDialog title={channel.name} onClose={onClose}>
      <form className="space-y-4" onSubmit={async (event) => {
        event.preventDefault();
        if (await update({ name: name.trim(), ...(!channel.sandboxId ? { agentId: agentId || null } : {}), credentials: values })) onClose();
      }}>
        <label className="block space-y-1.5 text-xs font-medium">
          <span>{t('connectionName')}</span>
          <input autoFocus required maxLength={120} value={name} onChange={(event) => setName(event.target.value)}
            onBlur={() => { if (name.trim() && name.trim() !== channel.name) void update({ name: name.trim() }); }}
            className="ui-input h-9 w-full text-sm" />
        </label>
        <label className="block space-y-1.5 text-xs font-medium">
          <span>{t('bindAgent')}</span>
          <select aria-label={t('bindAgent')} disabled={Boolean(channel.sandboxId)} className="ui-input h-9 w-full text-sm disabled:opacity-60" value={channel.sandboxId ? channel.agentId ?? '' : agentId} onChange={(event) => {
            setAgentId(event.target.value);
            void update({ agentId: event.target.value || null });
          }}>
            <option value="">{t('noAgent')}</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </label>
        {hasBuiltInPairingProvider(platform) && <section className="space-y-3 border-y border-border py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{waiting ? t(pairing.status === 'scanned' ? 'statusScanned' : 'statusWaiting') : channel.missingStartCredentialNames.length ? t('qrSetup') : t('setupComplete')}</span>
            <button type="button" disabled={pending} className="ui-button-secondary h-8 gap-2 px-2.5 text-xs"
              onClick={() => void send({ action: 'pair', connectionId: channel.id })}>
              {pending ? <LoaderCircle className="size-3.5 animate-spin" /> : <QrCode className="size-3.5" />}
              {pairing ? t('reauthenticate') : t('requestQr')}
            </button>
          </div>
          {waiting && pairing.qrPayload && <div className="mx-auto w-56 max-w-full">
            <QrPairingDisplay payload={pairing.qrPayload} label={t(`platforms.${channel.platform}`)} emptyLabel={t('requestQr')} errorLabel={t('qrRenderFailed')} />
          </div>}
          {pairing?.status === 'expired' && <p role="status" className="text-xs text-amber-700 dark:text-amber-400">{t('statusExpired')}</p>}
          {pairing?.error && <p role="alert" className="break-words text-xs text-red-600">{pairing.error}</p>}
          {needsApply && <div className="space-y-2">
            <label className="block space-y-1 text-xs"><span>{t('allowedTelegramUserIdsOptional')}</span>
              <input className="ui-input h-9 w-full" value={allowedUsers ?? pairing.extra?.ownerUserId ?? ''} onChange={(event) => setAllowedUsers(event.target.value)} />
            </label>
            <button type="button" className="ui-button-secondary text-xs" disabled={pending}
              onClick={() => void send({ action: 'apply', connectionId: channel.id, allowedUserIds: allowedUsers ?? pairing.extra?.ownerUserId ?? '' })}>{t('saveTelegramSetup')}</button>
          </div>}
        </section>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {fields.map(renderField)}
        </div>
        <ChannelCommands />
        {advanced.length > 0 && <details className="border-t border-border pt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground">{t('advanced')}</summary>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">{advanced.map(renderField)}</div>
        </details>}
        {error && <p role="alert" className="break-words text-sm text-red-600">{error}</p>}
        <div className="flex justify-end border-t border-border pt-3">
          <button type="submit" className="ui-button-primary h-9 gap-2 px-4 text-sm" aria-busy={pending}>
            {pending && <LoaderCircle className="size-4 animate-spin" />}{t('saveCredentials')}
          </button>
        </div>
      </form>
    </ChannelDialog>
  );
}

export function AgentMessagingPanel({ slug, agentId, sandboxId, connections: initialConnections, ready = true }: {
  slug: string; agentId?: string; sandboxId?: string; connections: Channel[]; ready?: boolean;
}) {
  const t = useTranslations('console.agentMessaging');
  const endpoint = `/api/v1/workspaces/${encodeURIComponent(slug)}/agent-channels`;
  const requestFailed = t('requestFailed');
  const [selected, setSelected] = useState<MessagingPlatformSlug>('feishu');
  const [connections, setConnections] = useState(initialConnections);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([]);
  const [moveId, setMoveId] = useState<string | null>(null);
  const [targetSandboxId, setTargetSandboxId] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [logId, setLogId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState('');
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const revision = useRef(0);
  const busy = useRef(0);
  const send = useCallback(async (command: Command): Promise<ChannelResponse | null> => {
    revision.current += 1;
    busy.current += 1;
    setPending((count) => count + 1);
    setError('');
    const operation = queue.current.then(async () => {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
      });
      const data: ChannelResponse = await response.json();
      if (data.connections) setConnections(data.connections);
      if (!response.ok) throw new Error(data.error || requestFailed);
      return data;
    });
    queue.current = operation.catch(() => {});
    try { return await operation; }
    catch (error) { setError(error instanceof Error ? error.message : requestFailed); return null; }
    finally { busy.current -= 1; setPending((count) => count - 1); }
  }, [endpoint, requestFailed]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function refresh() {
      const version = revision.current;
      try {
        if (!busy.current && !document.hidden) {
          const query = sandboxId ? `?sandboxId=${encodeURIComponent(sandboxId)}` : '';
          const response = await fetch(`${endpoint}${query}`, { cache: 'no-store', signal: controller.signal });
          const data: ChannelResponse = await response.json();
          if (!response.ok) throw new Error(data.error || requestFailed);
          if (!cancelled) {
            if (data.connections && version === revision.current) setConnections(data.connections);
            if (data.agents) setAgents(data.agents);
            if (data.sandboxes) setSandboxes(data.sandboxes);
          }
        }
      } catch (error) { if (!cancelled) setError(error instanceof Error ? error.message : requestFailed); }
      if (!cancelled) timer = setTimeout(refresh, 3000);
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
  }, [endpoint, requestFailed, sandboxId]);

  const editing = connections.find((channel) => channel.id === editingId);
  const pairingStatus = editing?.pairing?.status;
  const pairingInterval = Math.max(3, Number(editing?.pairing?.extra?.interval) || 3);
  useEffect(() => {
    if (!editingId || !['waiting', 'scanned'].includes(pairingStatus ?? '')) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      if (!busy.current && !document.hidden) await send({ action: 'check', connectionId: editingId! });
      if (!cancelled) timer = setTimeout(check, pairingInterval * 1000);
    }
    timer = setTimeout(check, pairingInterval * 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [editingId, pairingStatus, pairingInterval, send]);

  const visible = connections.filter((channel) => (!agentId || channel.agentId === agentId) && (!sandboxId || channel.sandboxId === sandboxId));
  const platforms = [...PLATFORMS, ...new Set(visible.map((channel) => channel.platform).filter((platform) => !PLATFORMS.includes(platform)))];
  const selectedChannels = visible.filter((channel) => channel.platform === selected);
  const statusText = (status: string) => t({
    running: 'statusRunning', starting: 'statusStarting', error: 'statusError',
    setup_required: 'statusSetupRequired', waiting_callback: 'statusWaitingCallback',
  }[status] ?? 'statusStopped');
  const platformName = (platform: string) => PLATFORMS.includes(platform as MessagingPlatformSlug) ? t(`platforms.${platform}`) : getMessagingPlatform(platform)?.label ?? platform;
  const deleteChannel = connections.find((channel) => channel.id === deleteId);
  const logChannel = connections.find((channel) => channel.id === logId);
  const moveChannel = connections.find((channel) => channel.id === moveId);
  const targetSandbox = sandboxes.find((sandbox) => sandbox.id === targetSandboxId);
  async function add() {
    const names = new Set(visible.filter((channel) => channel.platform === selected).map((channel) => channel.name));
    let name = platformName(selected);
    for (let i = 2; names.has(name); i += 1) name = `${platformName(selected)} ${i}`;
    const platform = getMessagingPlatform(selected)!;
    const created = await send({ action: 'create', platform: selected, name, agentId: agentId ?? null, sandboxId,
      credentials: Object.fromEntries(platform.credentials.filter((field) => field.defaultValue).map((field) => [field.name, field.defaultValue!])),
    });
    if (created?.connectionId) {
      setEditingId(created.connectionId);
      if (['feishu', 'weixin'].includes(selected)) await send({ action: 'pair', connectionId: created.connectionId });
    }
  }
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col sm:flex-row">
      <nav aria-label={t('platformNavigation')} className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/60 p-3 sm:w-40 sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r">
        {platforms.map((platform) => <button key={platform} type="button" aria-current={selected === platform ? 'page' : undefined}
          className={`flex h-9 shrink-0 items-center gap-2 rounded-md px-2.5 text-left text-sm ${selected === platform ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60'}`}
          onClick={() => setSelected(platform)}><PlatformIcon platform={platform} /><span className="whitespace-nowrap">{platformName(platform)}</span></button>)}
      </nav>
      <section className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <header className="mb-2 flex items-center justify-between gap-3 border-b border-border pb-4">
          <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold"><PlatformIcon platform={selected} />{platformName(selected)}</h2>
          <button type="button" disabled={Boolean(pending) || !PLATFORMS.includes(selected)} onClick={() => void add()} className="ui-button-secondary h-8 shrink-0 gap-1.5 px-3 text-xs">
            <Plus className="size-4" />{t('add')}
          </button>
        </header>
        {!ready && <p className="py-2 text-xs text-amber-700 dark:text-amber-400">{t('configureAModelProviderBeforeExternalMessagesCanReceiveAgentReplies')}</p>}
        {error && !editing && <p role="alert" className="py-2 text-sm text-red-600">{error}</p>}
        {!selectedChannels.length && <div className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
          <Radio className="size-7 opacity-50" /><p className="text-sm">{t('noInstances', { platform: platformName(selected) })}</p>
        </div>}
        <div className="divide-y divide-border/60">
          {selectedChannels.map((channel) => {
            const active = ['running', 'starting'].includes(channel.status);
            return <div key={channel.id} className="flex flex-wrap items-center gap-x-2 gap-y-2 py-3">
              <span className={`size-2 shrink-0 rounded-full ${channel.status === 'running' ? 'bg-emerald-500' : channel.status === 'error' ? 'bg-red-500' : channel.status === 'starting' ? 'animate-pulse bg-amber-500' : 'bg-muted-foreground/40'}`} />
              <div className="min-w-0 flex-1 basis-32">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="min-w-0 max-w-full break-words text-sm font-medium">{channel.name}</span><span className="text-[11px] text-muted-foreground">{statusText(channel.status)}</span></div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{sandboxes.find((sandbox) => sandbox.id === channel.sandboxId)?.name ?? t('noSandbox')} / {agents.find((agent) => agent.id === channel.agentId)?.name ?? t('noAgent')}</p>
                {channel.lastError && <p className="mt-1 break-words text-xs text-red-600 dark:text-red-400">{channel.lastError}</p>}
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-0.5">
                <IconButton icon={<FileText className="size-4" />} label={t('logs')} variant="ghost" size="sm" onClick={() => setLogId(channel.id)} />
                <IconButton icon={<Pencil className="size-4" />} label={t('edit')} variant="ghost" size="sm" onClick={() => { setError(''); setEditingId(channel.id); }} />
                <IconButton icon={<ArrowRightLeft className="size-4" />} label={t('migrate')} variant="ghost" size="sm" onClick={() => { setError(''); setTargetSandboxId(''); setMoveId(channel.id); }} />
                <IconButton icon={<Trash2 className="size-4" />} label={t('delete')} variant="ghost" size="sm" onClick={() => setDeleteId(channel.id)} />
                <label className="relative ml-2 inline-flex h-7 w-9 items-center">
                  <input type="checkbox" role="switch" aria-label={`${t(active ? 'stop' : 'start')} ${channel.name}`} checked={active} disabled={Boolean(pending)} className="peer sr-only"
                    onChange={() => void send({ action: active ? 'stop' : 'start', connectionId: channel.id })} />
                  <span className="h-5 w-9 rounded-full bg-muted-foreground/30 transition-colors peer-checked:bg-emerald-600 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand peer-disabled:opacity-50" />
                  <span className="pointer-events-none absolute left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4" />
                </label>
              </div>
            </div>;
          })}
        </div>
      </section>
      {editing && <ChannelEditor key={editing.id} channel={editing} agents={agents} pending={Boolean(pending)} error={error} send={send} onClose={() => setEditingId(null)} />}
      {logChannel && <ChannelLogs endpoint={endpoint} channel={logChannel} onClose={() => setLogId(null)} />}
      {moveChannel && <ChannelDialog title={t('migrateTitle', { name: moveChannel.name })} onClose={() => { if (!pending) setMoveId(null); }}>
        <label className="block space-y-2 text-sm"><span>{t('targetSandbox')}</span>
          <select aria-label={t('targetSandbox')} className="ui-input h-9 w-full" value={targetSandboxId} disabled={Boolean(pending)} onChange={(event) => setTargetSandboxId(event.target.value)}>
            <option value="">{t('selectSandbox')}</option>
            {sandboxes.filter((sandbox) => sandbox.id !== moveChannel.sandboxId).map((sandbox) => <option key={sandbox.id} value={sandbox.id}>{sandbox.name} / {sandbox.agentName ?? t('noAgent')}</option>)}
          </select>
        </label>
        <p className="mt-3 text-sm text-muted-foreground">{t('migrateConfirmation')}</p>
        {targetSandbox && !targetSandbox.agentId && <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">{t('targetHasNoAgent')}</p>}
        {error && <p role="alert" className="mt-2 break-words text-sm text-red-600">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="ui-button-secondary" disabled={Boolean(pending)} onClick={() => setMoveId(null)}>{t('cancel')}</button>
          <button type="button" className="ui-button-primary gap-2" disabled={Boolean(pending) || !targetSandbox} onClick={async () => {
            if (await send({ action: 'move', connectionId: moveChannel.id, sandboxId: targetSandboxId })) setMoveId(null);
          }}><ArrowRightLeft className="size-4" />{t('migrate')}</button>
        </div>
      </ChannelDialog>}
      {deleteChannel && <ChannelDialog title={t('deleteTitle', { name: deleteChannel.name })} onClose={() => setDeleteId(null)}>
        <p className="text-sm text-muted-foreground">{t('deleteConfirmation')}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="ui-button-secondary" disabled={Boolean(pending)} onClick={() => setDeleteId(null)}>{t('cancel')}</button>
          <button type="button" className="ui-button-danger" disabled={Boolean(pending)} onClick={async () => {
            if (await send({ action: 'delete', connectionId: deleteChannel.id })) setDeleteId(null);
          }}>{t('delete')}</button>
        </div>
      </ChannelDialog>}
    </div>
  );
}
