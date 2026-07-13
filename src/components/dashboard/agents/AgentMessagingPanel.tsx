import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import {
  Bot,
  Clock3,
  ExternalLink,
  KeyRound,
  Play,
  Plus,
  Power,
  QrCode,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { CopyButton } from '@/components/dashboard/CopyButton';
import { QrPairingDisplay } from '@/components/dashboard/agents/QrPairingDisplay';
import type { AgentChannelConnectionClientView } from '@/lib/agents/channel-connection-client';
import {
  applyAgentChannelPairingAction,
  checkAgentChannelPairingAction,
  createAgentChannelConnectionAction,
  deleteAgentChannelConnectionAction,
  requestAgentChannelPairingAction,
  startAgentChannelConnectionAction,
  stopAgentChannelConnectionAction,
  updateAgentChannelConnectionCredentialsAction,
} from '@/lib/agents/actions';
import { hostedRunnerSpec } from '@/lib/agents/platform-runner';
import { formatInTimeZone } from '@/lib/timezone';
import { useUserTimeZone } from '@/components/timezone/UserTimeZoneContext';
import {
  MESSAGING_PLATFORMS,
  credentialRequiredAtCreate,
  hasBuiltInPairingProvider,
  type MessagingCredential,
  type MessagingPlatform,
  type MessagingPlatformSlug,
} from '@/lib/agents/platforms';

type ChannelConnection = AgentChannelConnectionClientView;

function isTelegramPairingReadyToApply(pairing: ChannelConnection['pairing']) {
  return Boolean(
    pairing?.provider === 'telegram_managed_bot'
    && pairing.status === 'ready'
    && pairing.message
    && !pairing.message.startsWith('Telegram setup saved.'),
  );
}

function hasActivePairing(connection: ChannelConnection) {
  const pairing = connection.pairing;
  return Boolean(pairing && (pairing.status !== 'ready' || isTelegramPairingReadyToApply(pairing)));
}

function canReauthenticate(connection: ChannelConnection, platform: MessagingPlatform | undefined) {
  return Boolean(platform?.pairing && connection.missingStartCredentialNames.length === 0 && !hasActivePairing(connection));
}

const SUPPORTED_CHANNEL_SLUGS = [
  'wecom',
  'weixin',
  'discord',
  'telegram',
  'dingtalk',
] satisfies MessagingPlatformSlug[];

const SUPPORTED_CHANNEL_SET = new Set<MessagingPlatformSlug>(SUPPORTED_CHANNEL_SLUGS);

function statusTone(status: string) {
  if (status === 'running') return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (status === 'error') return 'bg-red-500/10 text-red-700 dark:text-red-300';
  if (status === 'waiting_callback' || status === 'setup_required') return 'bg-amber-500/10 text-amber-700 dark:text-amber-300';
  return 'bg-muted text-muted-foreground';
}

function statusLabel(status: string) {
  return status.replace(/_/g, ' ');
}

function CredentialInput({
  credential,
  required,
}: {
  credential: MessagingCredential;
  required: boolean;
}) {
  const t = useTranslations('console.agentMessaging');
  return (
    <label className="block">
      <span className="flex flex-wrap items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {credential.name}
        {required ? <span className="text-red-500">*</span> : null}
        {credential.required && credential.requiredAt === 'start' ? (
          <span className="inline-flex h-6 items-center rounded-md bg-amber-500/10 px-2 text-[11px] text-amber-700 dark:text-amber-300">
            {t('requiredToStart')}
          </span>
        ) : null}
      </span>
      {credential.multiline ? (
        <textarea
          name={`credential:${credential.name}`}
          required={required}
          placeholder={credential.placeholder ?? credential.label}
          className="ui-input mt-1 min-h-20 w-full resize-y py-2 text-xs"
        />
      ) : (
        <input
          name={`credential:${credential.name}`}
          required={required}
          type={credential.secret ? 'password' : 'text'}
          placeholder={credential.placeholder ?? credential.label}
          className="ui-input mt-1 h-9 w-full"
        />
      )}
      {credential.help ? <span className="mt-1 block text-[11px] text-muted-foreground">{credential.help}</span> : null}
    </label>
  );
}

function ActivePairingPanel({
  slug,
  agentId,
  connection,
  platform,
}: {
  slug: string;
  agentId: string;
  connection: ChannelConnection;
  platform: MessagingPlatform;
}) {
  const locale = useLocale();
  const { timeZone } = useUserTimeZone();
  if (!platform.pairing) return null;

  const pairing = connection.pairing;
  const canCheck = Boolean(pairing?.qrPayload || pairing?.status === 'waiting' || pairing?.status === 'scanned');
  const isReady = pairing?.status === 'ready';
  const isTelegramManaged = pairing?.provider === 'telegram_managed_bot';
  const authenticated = connection.missingStartCredentialNames.length === 0;
  const activePairing = hasActivePairing(connection);
  const telegramAllowedDefault = pairing?.extra?.ownerUserId ?? pairing?.extra?.allowedUserIds ?? '';

  if (authenticated && !activePairing) return null;

  return (
    <div className="mt-4 grid gap-3 rounded-md border border-border bg-muted/20 p-3 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <QrPairingDisplay
        payload={pairing?.qrPayload}
        label={platform.pairing.label}
        emptyLabel={isReady ? 'Setup complete' : 'Request QR'}
      />
      <div className="min-w-0 space-y-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <QrCode className="size-[18px] shrink-0 text-foreground" />
            <div className="text-sm font-semibold text-foreground">{platform.pairing.label}</div>
            {pairing?.status ? (
              <span className={`inline-flex h-6 items-center rounded-md px-2 text-[11px] font-medium uppercase tracking-wide ${statusTone(pairing.status)}`}>
                {statusLabel(pairing.status)}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{platform.pairing.description}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <form action={requestAgentChannelPairingAction}>
            <input type="hidden" name="workspace" value={slug} />
            <input type="hidden" name="agentId" value={agentId} />
            <input type="hidden" name="connectionId" value={connection.id} />
            <button className="ui-button-primary h-9 px-3 text-xs" type="submit">
              {platform.pairing.requestLabel ?? 'Request QR'}
            </button>
          </form>
          {canCheck ? (
            <form action={checkAgentChannelPairingAction}>
              <input type="hidden" name="workspace" value={slug} />
              <input type="hidden" name="agentId" value={agentId} />
              <input type="hidden" name="connectionId" value={connection.id} />
              <button className="ui-button-secondary h-9 px-3 text-xs" type="submit">
                {platform.pairing.checkLabel ?? 'Check setup'}
              </button>
            </form>
          ) : null}
          {pairing?.scanUrl && !isReady ? <CopyButton text={pairing.scanUrl} label="Copy URL" /> : null}
          {pairing?.scanUrl && !isReady ? (
            <Link href={pairing.scanUrl} target="_blank" rel="noreferrer" className="ui-button-secondary h-9 gap-2 px-3 text-xs">
              <ExternalLink className="size-4 shrink-0" />
              Open
            </Link>
          ) : null}
        </div>

        <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
          Scan with {platform.pairing.scanTarget}. {platform.pairing.completion}
        </div>

        {isTelegramManaged && pairing?.status === 'ready' ? (
          <form action={applyAgentChannelPairingAction} className="space-y-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 p-3">
            <input type="hidden" name="workspace" value={slug} />
            <input type="hidden" name="agentId" value={agentId} />
            <input type="hidden" name="connectionId" value={connection.id} />
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-foreground">Telegram bot is ready</span>
              {pairing.extra?.botUsername ? (
                <code className="inline-flex h-6 items-center rounded-md border border-border bg-background px-2 text-[11px] text-muted-foreground">
                  @{pairing.extra.botUsername}
                </code>
              ) : null}
            </div>
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Allowed Telegram user IDs (optional)
              </span>
              <input
                name="allowedUserIds"
                defaultValue={telegramAllowedDefault}
                placeholder="blank means everyone"
                className="ui-input mt-1 h-9 w-full"
              />
            </label>
            <button className="ui-button-primary h-9 px-3 text-xs" type="submit">Save Telegram setup</button>
          </form>
        ) : null}

        {pairing?.message ? <p className="text-xs text-muted-foreground">{pairing.message}</p> : null}
        {pairing?.expiresAt ? (
          <p className="text-[11px] text-muted-foreground">
            Expires:{' '}
            {formatInTimeZone(
              pairing.expiresAt,
              timeZone,
              { dateStyle: 'medium', timeStyle: 'short' },
              locale,
            )}
          </p>
        ) : null}
        {pairing?.error ? (
          <div className="rounded-md border border-red-500/20 bg-red-500/10 px-2 py-1.5 text-xs text-red-700 dark:text-red-300">
            {pairing.error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ChannelConnectionCard({
  slug,
  agentId,
  connection,
}: {
  slug: string;
  agentId: string;
  connection: ChannelConnection;
}) {
  const runner = hostedRunnerSpec(connection.platform);
  const t = useTranslations('console.agentMessaging');
  const platform = MESSAGING_PLATFORMS.find((item) => item.slug === connection.platform);
  const missingCredentialDefs = platform
    ? platform.credentials.filter((credential) => connection.missingStartCredentialNames.includes(credential.name))
    : [];
  const canStart = connection.missingStartCredentialNames.length === 0;
  const showReauthenticate = canReauthenticate(connection, platform);

  return (
    <div className="rounded-md border border-border bg-background px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h3 className="text-sm font-semibold text-foreground">{connection.name}</h3>
            <span className="inline-flex h-6 items-center rounded-md border border-border bg-muted/20 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {connection.platformLabel}
            </span>
            <span className={`inline-flex h-6 items-center rounded-md px-2 text-[11px] font-medium uppercase tracking-wide ${statusTone(connection.status)}`}>
              {statusLabel(connection.status)}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{connection.connectionMode}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {connection.credentialNames.length ? (
              connection.credentialNames.map((name) => (
                <code key={name} className="inline-flex h-6 items-center rounded-md border border-border bg-muted/25 px-2 text-[11px] text-muted-foreground">
                  {name}
                </code>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">{t('noCredentialsSavedYet')}</span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2.5">
          {showReauthenticate ? (
            <form action={requestAgentChannelPairingAction}>
              <input type="hidden" name="workspace" value={slug} />
              <input type="hidden" name="agentId" value={agentId} />
              <input type="hidden" name="connectionId" value={connection.id} />
              <button className="ui-button-secondary h-9 gap-2 px-3 text-xs" type="submit">
                <QrCode className="size-4 shrink-0" />
                {t('reauthenticate')}
              </button>
            </form>
          ) : null}
          {runner ? (
            connection.status === 'running' ? (
              <form action={stopAgentChannelConnectionAction}>
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="agentId" value={agentId} />
                <input type="hidden" name="connectionId" value={connection.id} />
                <button className="ui-button-secondary h-9 gap-2 px-3 text-xs" type="submit">
                  <Power className="size-4 shrink-0" />
                  {t('stop')}
                </button>
              </form>
            ) : canStart ? (
              <form action={startAgentChannelConnectionAction}>
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="agentId" value={agentId} />
                <input type="hidden" name="connectionId" value={connection.id} />
                <button className="ui-button-primary h-9 gap-2 px-3 text-xs" type="submit">
                  <Play className="size-4 shrink-0" />
                  {t('start')}
                </button>
              </form>
            ) : null
          ) : null}
          <form action={deleteAgentChannelConnectionAction}>
            <input type="hidden" name="workspace" value={slug} />
            <input type="hidden" name="agentId" value={agentId} />
            <input type="hidden" name="connectionId" value={connection.id} />
            <button className="ui-button-secondary h-9 gap-2 px-3 text-xs text-red-600 dark:text-red-300" type="submit">
              <Trash2 className="size-4 shrink-0" />
              {t('delete')}
            </button>
          </form>
        </div>
      </div>

      {connection.lastError ? (
        <div className="mt-3 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          {connection.lastError}
        </div>
      ) : null}

      {platform ? (
        <ActivePairingPanel slug={slug} agentId={agentId} connection={connection} platform={platform} />
      ) : null}

      {platform ? (
        <details className="mt-4 rounded-md border border-border bg-muted/15">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-foreground">
            <span className="inline-flex items-center gap-2">
              <KeyRound className="size-4 shrink-0" />
              Credentials and policy
            </span>
            {missingCredentialDefs.length ? (
              <span className="inline-flex h-6 items-center rounded-md bg-amber-500/10 px-2 text-[11px] uppercase tracking-wide text-amber-700 dark:text-amber-300">
                missing {missingCredentialDefs.length}
              </span>
            ) : null}
          </summary>
          <form action={updateAgentChannelConnectionCredentialsAction} className="space-y-3 border-t border-border px-3 py-3">
            <input type="hidden" name="workspace" value={slug} />
            <input type="hidden" name="agentId" value={agentId} />
            <input type="hidden" name="connectionId" value={connection.id} />
            <input type="hidden" name="platform" value={platform.slug} />
            <div className="grid gap-2 md:grid-cols-2">
              {platform.credentials.map((credential) => (
                <CredentialInput
                  key={credential.name}
                  credential={credential}
                  required={connection.missingStartCredentialNames.includes(credential.name)}
                />
              ))}
            </div>
            <button className="ui-button-primary h-9 px-3 text-xs" type="submit">Save credentials</button>
          </form>
        </details>
      ) : null}
    </div>
  );
}

function CreateChannelCard({
  slug,
  agentId,
  platform,
}: {
  slug: string;
  agentId: string;
  platform: MessagingPlatform;
}) {
  const runner = hostedRunnerSpec(platform.slug);
  const t = useTranslations('console.agentMessaging');
  const autoRequestsQr = hasBuiltInPairingProvider(platform);
  const createCredentials = platform.credentials.filter(credentialRequiredAtCreate);
  const startCredentials = platform.credentials.filter((credential) => credential.required && credential.requiredAt === 'start');
  const showStartCredentialsInline = !platform.pairing || platform.slug === 'telegram';
  const primaryCredentials = showStartCredentialsInline
    ? [...createCredentials, ...startCredentials]
    : createCredentials;
  const advancedStartCredentials = showStartCredentialsInline ? [] : startCredentials;
  const primaryCredentialNames = new Set(primaryCredentials.map((credential) => credential.name));
  const optionalCredentials = platform.credentials.filter((credential) => !primaryCredentialNames.has(credential.name) && !credential.required);

  return (
    <details className="rounded-md border border-border bg-background">
      <summary className="cursor-pointer list-none px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h3 className="text-sm font-semibold text-foreground">{platform.label}</h3>
              <span className="inline-flex h-6 items-center rounded-md bg-muted px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {platform.pairing ? t('qrSetup') : platform.slug === 'discord' ? t('botToken') : t('hostedRunner')}
              </span>
              {runner ? (
                <span className="inline-flex h-6 items-center rounded-md bg-emerald-500/10 px-2 text-[11px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                  {t('hosted')}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{platform.summary}</p>
          </div>
          <span className="inline-flex h-7 shrink-0 items-center rounded-md border border-border bg-muted/25 px-2.5 text-[11px] font-medium text-foreground">
            {t('select')}
          </span>
        </div>
      </summary>

      <form action={createAgentChannelConnectionAction} className="space-y-4 border-t border-border px-4 py-4">
        <input type="hidden" name="workspace" value={slug} />
        <input type="hidden" name="agentId" value={agentId} />
        <input type="hidden" name="platform" value={platform.slug} />

        <div className="grid gap-3 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <div className="rounded-md border border-border bg-muted/20 px-3 py-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('setupFlow')}</div>
            <p className="mt-1 text-sm font-medium text-foreground">{platform.primaryAction}</p>
            <p className="mt-1 text-xs text-muted-foreground">{platform.connectionMode}</p>
            {platform.docsUrl ? (
              <Link
                href={platform.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-2 text-xs font-medium text-foreground hover:underline"
              >
                {t('platformDocs')}
                <ExternalLink className="size-4 shrink-0" />
              </Link>
            ) : null}
          </div>
          <ol className="space-y-1.5 text-xs text-muted-foreground">
            {platform.setupSteps.map((step, index) => (
              <li key={step} className="flex gap-2">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-foreground">
                  {index + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </div>

        <label className="block">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('connectionName')}</span>
          <input name="name" defaultValue={platform.label} className="ui-input mt-1 h-9 w-full" />
        </label>

        {platform.pairing ? (
          <div className="rounded-md border border-teal-500/20 bg-teal-500/10 px-3 py-2 text-xs text-teal-800 dark:text-teal-200">
            {platform.slug === 'telegram'
              ? t('telegramSetupHint')
              : t('qrSetupHint')}
          </div>
        ) : null}

        {primaryCredentials.length ? (
          <div className="grid gap-2 md:grid-cols-2">
            {primaryCredentials.map((credential) => (
              <CredentialInput
                key={credential.name}
                credential={credential}
                required={credentialRequiredAtCreate(credential)}
              />
            ))}
          </div>
        ) : null}

        {advancedStartCredentials.length || optionalCredentials.length ? (
          <details className="rounded-md border border-border bg-muted/15">
            <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-foreground">
              {t('manualCredentialsAndPolicy')}
            </summary>
            <div className="grid gap-2 border-t border-border px-3 py-3 md:grid-cols-2">
              {advancedStartCredentials.map((credential) => (
                <CredentialInput key={credential.name} credential={credential} required={false} />
              ))}
              {optionalCredentials.map((credential) => (
                <CredentialInput key={credential.name} credential={credential} required={false} />
              ))}
            </div>
          </details>
        ) : null}

        <button className="ui-button-primary h-10 px-4" type="submit">
          {autoRequestsQr ? t('createAndRequestQr') : t('createChannel', { platform: platform.label })}
        </button>
      </form>
    </details>
  );
}

export function AgentMessagingPanel({
  slug,
  agentId,
  connections,
  ready,
}: {
  slug: string;
  agentId: string;
  connections: ChannelConnection[];
  ready: boolean;
}) {
  const t = useTranslations('console.agentMessaging');
  const supportedPlatforms = SUPPORTED_CHANNEL_SLUGS
    .map((platformSlug) => MESSAGING_PLATFORMS.find((platform) => platform.slug === platformSlug))
    .filter((platform): platform is MessagingPlatform => Boolean(platform));
  const visibleConnections = connections.filter((connection) => SUPPORTED_CHANNEL_SET.has(connection.platform));
  const hiddenConnectionCount = connections.length - visibleConnections.length;

  return (
    <div className="space-y-4 px-5 py-5">
      {!ready ? (
        <div className="flex gap-2.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <TriangleAlert className="mt-0.5 size-[18px] shrink-0" />
          {t('configureAModelProviderBeforeExternalMessagesCanReceiveAgentReplies')}
        </div>
      ) : null}

      <details className="overflow-hidden rounded-md border border-border bg-background">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">{t('addChannel')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('chooseOnePlatformAndFollowItsNativeSetupFlow')}</p>
          </div>
          <span className="ui-button-primary h-10 gap-2 px-4 text-sm">
            <Plus className="size-[18px] shrink-0" />
            {t('add')}
          </span>
        </summary>
        <div className="grid gap-3 px-4 py-4 xl:grid-cols-2">
          {supportedPlatforms.map((platform) => (
            <CreateChannelCard
              key={platform.slug}
              slug={slug}
              agentId={agentId}
              platform={platform}
            />
          ))}
        </div>
      </details>

      <section className="overflow-hidden rounded-md border border-border bg-background">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">{t('connectedChannels')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('nativeChannelsAttachedToThisAgent')}</p>
        </div>
        <div className="px-4 py-4">
        {visibleConnections.length ? (
          <div className="space-y-3">
            {visibleConnections.map((connection) => (
              <ChannelConnectionCard
                key={connection.id}
                slug={slug}
                agentId={agentId}
                connection={connection}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-border bg-muted/20 px-4 py-8 text-center">
            <Bot className="mx-auto mb-3 size-8 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">{t('noChannelsConnected')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t('useAddToConnectWecomWeixinDiscordTelegramOrDingtalk')}</p>
          </div>
        )}
        {hiddenConnectionCount > 0 ? (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            <Clock3 className="size-4 shrink-0" />
            {t('legacyChannelCount', {
              count: hiddenConnectionCount,
              suffix: hiddenConnectionCount > 1 ? t('legacyChannelsAre') : t('legacyChannelIs'),
            })}{' '}
            {t('hiddenBecauseThisViewNowSupportsOnlyTheSelectedFivePlatforms')}
          </div>
        ) : null}
        </div>
      </section>

    </div>
  );
}
