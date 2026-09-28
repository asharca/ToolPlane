'use client';
import { BouncyAccordion } from '@/components/motion/bouncy-accordion';
import { Button } from '@/components/motion/button/base';
import { Input } from '@/components/motion/input';
import { FormSelect } from '@/components/ui/FormSelect';
import { Switch } from '@/components/motion/switch';
import { AnimatedBadge } from '@/components/motion/animated-badge';
import { CenterMorphModal, CenterMorphModalClose, CenterMorphModalContent } from '@/components/motion/center-morph-modal';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRightLeft, FileText, LoaderCircle, Pencil, Plus, QrCode, Radio, Trash2 } from 'lucide-react';

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
    <CenterMorphModal open onOpenChange={(open) => { if (!open) onClose(); }}>
      <>
        
        <CenterMorphModalContent ariaLabel={title} closeButtonLabel={t('close')} className={wide ? 'max-w-2xl' : 'max-w-lg'}>
          <header className="mb-4 flex min-h-16 min-w-0 items-center gap-3 pl-5 pr-16">
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
          </header>
          {children}
        </CenterMorphModalContent>
      </>
    </CenterMorphModal>
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
      {error && <p role="alert" className="mb-2 text-sm text-destructive">{error}</p>}
      <div className="h-80 overflow-auto rounded-md bg-muted/50 p-3 font-mono text-xs leading-5" role="log" aria-label={t('logs')}>
        {!logs.length && <p className="py-12 text-center text-muted-foreground">{t('noLogs')}</p>}
        {logs.map((entry, index) => <div key={`${entry.timestamp}:${index}`} className={`whitespace-pre-wrap break-all ${entry.level === 'error' ? 'text-destructive text-destructive' : 'text-muted-foreground'}`}>
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
    return <div key={field.name} className={`block space-y-1.5 text-xs ${boolean || field.secret || field.name.includes('ALLOWED') ? 'sm:col-span-2' : ''}`}>
      <span className="font-medium">{label}</span>
      {boolean ? <Switch checked={value === 'true'} ariaLabel={label} onCheckedChange={(checked) => { setValues((current) => ({ ...current, [field.name]: String(checked) })); void saveCredentials({ [field.name]: String(checked) }); }} />
        : field.options ? <FormSelect value={value} label={label} options={[field.options.map((option) => ({ value: option.value, label: option.label }))].flat().filter((option) => option != null)} onValueChange={(value) => {
          setValues((current) => ({ ...current, [field.name]: value }));
          void saveCredentials({ [field.name]: value });
        }} className="w-full" />
        : <Input type={field.secret ? 'password' : 'text'} autoComplete={field.secret ? 'new-password' : 'off'} maxLength={8000} aria-label={label} placeholder={field.secret && channel.credentialNames.includes(field.name) ? t('secretSaved') : field.placeholder} onBlur={() => saveField(field.name)} value={String(value)} className="w-full" onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))} />}
    </div>;
  };
  return (
    <ChannelDialog title={channel.name} onClose={onClose}>
      <form className="space-y-4" onSubmit={async (event) => {
        event.preventDefault();
        if (await update({ name: name.trim(), ...(!channel.sandboxId ? { agentId: agentId || null } : {}), credentials: values })) onClose();
      }}>
        <div className="block space-y-1.5 text-xs font-medium">
          
          <Input label={t('connectionName')} autoFocus required maxLength={120} onBlur={() => { if (name.trim() && name.trim() !== channel.name) void update({ name: name.trim() }); }} value={String(name)} className="w-full" onChange={(value) => setName(value)} />
        </div>
        <div className="block space-y-1.5 text-xs font-medium">
          <span>{t('bindAgent')}</span>
          <FormSelect disabled={Boolean(channel.sandboxId)} value={channel.sandboxId ? channel.agentId ?? '' : agentId} label={t('bindAgent')} options={[({ value: "", label: t('noAgent') }), agents.map((agent) => ({ value: agent.id, label: agent.name }))].flat().filter((option) => option != null)} onValueChange={(value) => {
            setAgentId(value);
            void update({ agentId: value || null });
          }} className="w-full" />
        </div>
        {hasBuiltInPairingProvider(platform) && <section className="space-y-3 border-y border-border py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{waiting ? t(pairing.status === 'scanned' ? 'statusScanned' : 'statusWaiting') : channel.missingStartCredentialNames.length ? t('qrSetup') : t('setupComplete')}</span>
            <Button type="button" disabled={pending} onClick={() => void send({ action: 'pair', connectionId: channel.id })} variant={"secondary"} size={"sm"}>
              {pending ? <LoaderCircle className="size-3.5 animate-spin" /> : <QrCode className="size-3.5" />}
              {pairing ? t('reauthenticate') : t('requestQr')}
            </Button>
          </div>
          {waiting && pairing.qrPayload && <div className="mx-auto w-56 max-w-full">
            <QrPairingDisplay payload={pairing.qrPayload} label={t(`platforms.${channel.platform}`)} emptyLabel={t('requestQr')} errorLabel={t('qrRenderFailed')} />
          </div>}
          {pairing?.status === 'expired' && <p role="status" className="text-xs text-muted-foreground text-muted-foreground">{t('statusExpired')}</p>}
          {pairing?.error && <p role="alert" className="break-words text-xs text-destructive">{pairing.error}</p>}
          {needsApply && <div className="space-y-2">
            <div className="block space-y-1 text-xs">
              <Input label={t('allowedTelegramUserIdsOptional')} value={String(allowedUsers ?? pairing.extra?.ownerUserId ?? '')} className="w-full" onChange={(value) => setAllowedUsers(value)} />
            </div>
            <Button type="button" disabled={pending} onClick={() => void send({ action: 'apply', connectionId: channel.id, allowedUserIds: allowedUsers ?? pairing.extra?.ownerUserId ?? '' })} variant={"secondary"} size={"sm"}>{t('saveTelegramSetup')}</Button>
          </div>}
        </section>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {fields.map(renderField)}
        </div>
        <ChannelCommands />
        {advanced.length > 0 && <BouncyAccordion items={[{ id: 'details', title: <>{t('advanced')}</>, description: <>
          
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">{advanced.map(renderField)}</div>
        </> }]} />}
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
        <div className="flex justify-end border-t border-border pt-3">
          <Button type="submit" aria-busy={pending} variant={"primary"} size={"sm"}>
            {pending && <LoaderCircle className="size-4 animate-spin" />}{t('saveCredentials')}
          </Button>
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
        {platforms.map((platform) => <Button key={platform} type="button" aria-current={selected === platform ? 'page' : undefined} onClick={() => setSelected(platform)} variant={selected === platform ? 'secondary' : 'ghost'} size="sm" className="justify-start text-left"><PlatformIcon platform={platform} /><span className="whitespace-nowrap">{platformName(platform)}</span></Button>)}
      </nav>
      <section className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <header className="mb-2 flex items-center justify-between gap-3 border-b border-border pb-4">
          <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold"><PlatformIcon platform={selected} />{platformName(selected)}</h2>
          <Button type="button" disabled={Boolean(pending) || !PLATFORMS.includes(selected)} onClick={() => void add()} variant={"secondary"} size={"sm"} className="shrink-0">
            <Plus className="size-4" />{t('add')}
          </Button>
        </header>
        {!ready && <p className="py-2 text-xs text-muted-foreground text-muted-foreground">{t('configureAModelProviderBeforeExternalMessagesCanReceiveAgentReplies')}</p>}
        {error && !editing && <p role="alert" className="py-2 text-sm text-destructive">{error}</p>}
        {!selectedChannels.length && <div className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
          <Radio className="size-7 opacity-50" /><p className="text-sm">{t('noInstances', { platform: platformName(selected) })}</p>
        </div>}
        <div className="divide-y divide-border/60">
          {selectedChannels.map((channel) => {
            const active = ['running', 'starting'].includes(channel.status);
            return <div key={channel.id} className="flex flex-wrap items-center gap-x-2 gap-y-2 py-3">

              <div className="min-w-0 flex-1 basis-32">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="min-w-0 max-w-full break-words text-sm font-medium">{channel.name}</span><AnimatedBadge status={channel.status === 'running' ? 'success' : channel.status === 'error' ? 'danger' : channel.status === 'starting' ? 'loading' : 'neutral'}>{statusText(channel.status)}</AnimatedBadge></div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{sandboxes.find((sandbox) => sandbox.id === channel.sandboxId)?.name ?? t('noSandbox')} / {agents.find((agent) => agent.id === channel.agentId)?.name ?? t('noAgent')}</p>
                {channel.lastError && <p className="mt-1 break-words text-xs text-destructive text-destructive">{channel.lastError}</p>}
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-0.5">
                <Button variant="ghost" onClick={() => setLogId(channel.id)} size="icon" aria-label={t('logs')}>{<FileText className="size-4" />}</Button>
                <Button variant="ghost" onClick={() => { setError(''); setEditingId(channel.id); }} size="icon" aria-label={t('edit')}>{<Pencil className="size-4" />}</Button>
                <Button variant="ghost" onClick={() => { setError(''); setTargetSandboxId(''); setMoveId(channel.id); }} size="icon" aria-label={t('migrate')}>{<ArrowRightLeft className="size-4" />}</Button>
                <Button variant="ghost" onClick={() => setDeleteId(channel.id)} size="icon" aria-label={t('delete')}>{<Trash2 className="size-4" />}</Button>
                <Switch checked={active} disabled={Boolean(pending)} ariaLabel={`${t(active ? 'stop' : 'start')} ${channel.name}`} onCheckedChange={() => void send({ action: active ? 'stop' : 'start', connectionId: channel.id })} />
              </div>
            </div>;
          })}
        </div>
      </section>
      {editing && <ChannelEditor key={editing.id} channel={editing} agents={agents} pending={Boolean(pending)} error={error} send={send} onClose={() => setEditingId(null)} />}
      {logChannel && <ChannelLogs endpoint={endpoint} channel={logChannel} onClose={() => setLogId(null)} />}
      {moveChannel && <ChannelDialog title={t('migrateTitle', { name: moveChannel.name })} onClose={() => { if (!pending) setMoveId(null); }}>
        <div className="block space-y-2 text-sm"><span>{t('targetSandbox')}</span>
          <FormSelect value={targetSandboxId} disabled={Boolean(pending)} label={t('targetSandbox')} options={[({ value: "", label: t('selectSandbox') }), sandboxes.filter((sandbox) => sandbox.id !== moveChannel.sandboxId).map((sandbox) => ({ value: sandbox.id, label: [sandbox.name, "/", sandbox.agentName ?? t('noAgent')].join(' ') }))].flat().filter((option) => option != null)} onValueChange={(value) => setTargetSandboxId(value)} className="w-full" />
        </div>
        <p className="mt-3 text-sm text-muted-foreground">{t('migrateConfirmation')}</p>
        {targetSandbox && !targetSandbox.agentId && <p className="mt-2 text-sm text-muted-foreground text-muted-foreground">{t('targetHasNoAgent')}</p>}
        {error && <p role="alert" className="mt-2 break-words text-sm text-destructive">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <CenterMorphModalClose><Button type="button" disabled={Boolean(pending)} variant={"secondary"}>{t('cancel')}</Button></CenterMorphModalClose>
          <Button type="button" disabled={Boolean(pending) || !targetSandbox} onClick={async () => {
            if (await send({ action: 'move', connectionId: moveChannel.id, sandboxId: targetSandboxId })) setMoveId(null);
          }} variant={"primary"}><ArrowRightLeft className="size-4" />{t('migrate')}</Button>
        </div>
      </ChannelDialog>}
      {deleteChannel && <ChannelDialog title={t('deleteTitle', { name: deleteChannel.name })} onClose={() => setDeleteId(null)}>
        <p className="text-sm text-muted-foreground">{t('deleteConfirmation')}</p>
        <div className="mt-5 flex justify-end gap-2">
          <CenterMorphModalClose><Button type="button" disabled={Boolean(pending)} variant={"secondary"}>{t('cancel')}</Button></CenterMorphModalClose>
          <Button type="button" disabled={Boolean(pending)} onClick={async () => {
            if (await send({ action: 'delete', connectionId: deleteChannel.id })) setDeleteId(null);
          }} variant={"secondary"}>{t('delete')}</Button>
        </div>
      </ChannelDialog>}
    </div>
  );
}
