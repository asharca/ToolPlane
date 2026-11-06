"use client";
import { BouncyAccordion } from "@/components/motion/bouncy-accordion";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { SafeStreamdown } from "@/components/dashboard/SafeStreamdown";
import { displayMessagingUserText } from "@/lib/agents/messaging";
import { FormSelect } from "@/components/ui/FormSelect";
import { Switch } from "@/components/motion/switch";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { ChannelDetailPanel, ChannelPanelCancel } from "./ChannelDetailPanel";
import {
  DialogBody,
  DialogField,
  DialogFooter,
} from "@/components/dashboard/dialog";

import Image from "next/image";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslations } from "next-intl";
import {
  ArrowRightLeft,
  FileText,
  MessagesSquare,
  LoaderCircle,
  Pencil,
  Plus,
  QrCode,
  Radio,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import { CopyButton } from "@/components/dashboard/CopyButton";
import { QrPairingDisplay } from "@/components/dashboard/agents/QrPairingDisplay";
import { notify } from "@/components/dashboard/Toaster";
import {
  ChannelAccessPanel,
  type ChannelAccessCommand,
} from "./ChannelAccessPanel";
import type { AgentChannelConnectionClientView as Channel } from "@/lib/agents/channel-connection-client";
import type { AgentChannelLogEntry } from "@/lib/agents/channel-runtime-logs";
import { LiveControls } from "@/components/observability/LiveToggle";
import { RelativeTime } from "@/components/observability/LogPrimitives";
import {
  getMessagingPlatform,
  hasBuiltInPairingProvider,
  type MessagingCredential,
  type MessagingPlatformSlug,
} from "@/lib/agents/platforms";

const PLATFORMS: MessagingPlatformSlug[] = [
  "feishu",
  "telegram",
  "qqbot",
  "weixin",
  "discord",
  "slack",
];
const ICONS: Record<string, string> = {
  feishu: "feishu.jpeg",
  telegram: "telegram.png",
  qqbot: "qq.svg",
  weixin: "wechat.png",
  discord: "discord.svg",
  slack: "slack.svg",
};
const PRIMARY_FIELDS: Partial<Record<MessagingPlatformSlug, string[]>> = {
  feishu: [
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_ENCRYPT_KEY",
    "FEISHU_VERIFICATION_TOKEN",
    "FEISHU_DOMAIN",
    "FEISHU_ALLOWED_CHATS",
  ],
  telegram: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_CHATS"],
  qqbot: [
    "QQBOT_APP_ID",
    "QQBOT_SECRET",
    "QQBOT_ALLOWED_CHATS",
    "QQBOT_REQUIRE_MENTION",
  ],
  weixin: [],
  discord: ["DISCORD_BOT_TOKEN", "DISCORD_ALLOWED_CHANNELS"],
  slack: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_ALLOWED_CHANNELS"],
};
type Agent = { id: string; name: string };
type Sandbox = {
  id: string;
  name: string;
  agentId: string | null;
  agentName: string | null;
};
type Command = {
  action:
    | "create"
    | "update"
    | "delete"
    | "start"
    | "stop"
    | "pair"
    | "check"
    | "move"
    | "upgradeConversations"
    | ChannelAccessCommand["action"];
  connectionId?: string;
  platform?: string;
  name?: string;
  agentId?: string | null;
  sandboxId?: string;
  credentials?: Record<string, string>;
  access?: Partial<
    Pick<Channel["access"], "openToAll" | "unauthorizedDm" | "adminUserIds">
  >;
  sessions?: Partial<Channel["sessions"]>;
  requestId?: string;
  platformUserId?: string;
  userName?: string;
};
type ChannelResponse = {
  connections?: Channel[];
  agents?: Agent[];
  sandboxes?: Sandbox[];
  connectionId?: string;
  upgraded?: number;
  skipped?: number;
  error?: string;
};

function PlatformIcon({ platform }: { platform: string }) {
  return ICONS[platform] ? (
    // These small, local brand assets retain their intrinsic colors.
    <Image
      unoptimized
      src={`/images/channels/${ICONS[platform]}`}
      alt=""
      width={20}
      height={20}
      className="size-5 shrink-0 rounded-lg object-contain"
    />
  ) : (
    <Radio className="size-5 shrink-0 text-muted-foreground" />
  );
}

type ChannelHistoryMessage = {
  id: string;
  role: string;
  text: string;
  createdAt: string;
  conversation: { id: string; title: string | null };
};

function ChannelHistory({
  endpoint,
  channel,
  onClose,
}: {
  endpoint: string;
  channel: Channel;
  onClose: () => void;
}) {
  const t = useTranslations("console.agentMessaging");
  const [messages, setMessages] = useState<ChannelHistoryMessage[]>([]);
  const [error, setError] = useState("");
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const olderHeight = useRef<number | null>(null);
  const latest = useRef<string | null>(null);
  const merge = useCallback((incoming: ChannelHistoryMessage[]) => {
    if (!incoming.length) return;
    setMessages((current) =>
      [
        ...new Map([...current, ...incoming].map((m) => [m.id, m])).values(),
      ].sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      ),
    );
  }, []);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node || !messages.length) return;
    if (olderHeight.current !== null) {
      node.scrollTop += node.scrollHeight - olderHeight.current;
      olderHeight.current = null;
    } else if (pinned.current) node.scrollTop = node.scrollHeight;
  }, [messages]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let active = false;
    async function refresh() {
      if (active || controller.signal.aborted) return;
      clearTimeout(timer);
      active = true;
      try {
        if (!document.hidden) {
          const response = await fetch(
            `${endpoint}?history=${encodeURIComponent(channel.id)}${latest.current ? `&after=${encodeURIComponent(latest.current)}` : ""}`,
            { cache: "no-store", signal: controller.signal },
          );
          if (!response.ok) throw new Error(t("requestFailed"));
          const data = (await response.json()) as {
            messages: ChannelHistoryMessage[];
            hasMore: boolean;
          };
          if (!controller.signal.aborted) {
            if (!latest.current) setHasOlder(data.hasMore);
            latest.current = data.messages.at(-1)?.id ?? latest.current;
            merge(data.messages);
            setError("");
          }
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : t("requestFailed"));
      } finally {
        active = false;
        if (!controller.signal.aborted) timer = setTimeout(refresh, 1000);
      }
    }
    void refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [endpoint, channel.id, merge, t]);
  async function loadOlder() {
    if (!messages.length || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const response = await fetch(
        `${endpoint}?history=${encodeURIComponent(channel.id)}&before=${encodeURIComponent(messages[0].id)}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(t("requestFailed"));
      const data = (await response.json()) as {
        messages: ChannelHistoryMessage[];
        hasMore: boolean;
      };
      olderHeight.current = scroller.current?.scrollHeight ?? null;
      setHasOlder(data.hasMore);
      merge(data.messages);
      setError("");
    } catch (error) {
      setError(error instanceof Error ? error.message : t("requestFailed"));
    } finally {
      setLoadingOlder(false);
    }
  }
  return (
    <ChannelDetailPanel
      title={`${channel.name} · ${t("conversationHistory")}`}
      onClose={onClose}
    >
      <p className="px-6 pb-3 text-xs text-muted-foreground">
        {t("historyLiveReadOnly")}
      </p>
      {error ? (
        <p role="alert" className="px-6 pb-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div
        ref={scroller}
        role="log"
        aria-label={t("conversationHistory")}
        aria-live="polite"
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-6"
        onScroll={() => {
          const node = scroller.current;
          if (node)
            pinned.current =
              node.scrollHeight - node.scrollTop - node.clientHeight < 48;
        }}
      >
        {hasOlder ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={loadingOlder}
            onClick={loadOlder}
          >
            {t("historyLoadOlder")}
          </Button>
        ) : null}
        {!messages.length && !error ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("historyEmpty")}
          </p>
        ) : null}
        {messages.map((message) => (
          <article
            key={message.id}
            className="min-w-0 rounded-lg border border-border p-3"
          >
            <div className="mb-2 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
              <span>{message.conversation.title}</span>
              <span>
                {t(
                  message.role === "user" ? "historyUser" : "historyAssistant",
                )}
              </span>
              <RelativeTime value={message.createdAt} />
            </div>
            <div className="break-words text-sm [overflow-wrap:anywhere]">
              {message.role === "assistant" ? (
                <SafeStreamdown mode="static" parseIncompleteMarkdown={false}>
                  {message.text}
                </SafeStreamdown>
              ) : (
                <p className="whitespace-pre-wrap">
                  {displayMessagingUserText(message.text)}
                </p>
              )}
            </div>
          </article>
        ))}
      </div>
    </ChannelDetailPanel>
  );
}

function ChannelLogs({
  endpoint,
  channel,
  onClose,
}: {
  endpoint: string;
  channel: Channel;
  onClose: () => void;
}) {
  const t = useTranslations("console.agentMessaging");
  const viewer = useTranslations("console.observability.viewer");
  const levelId = useId();
  const searchId = useId();
  const [logs, setLogs] = useState<AgentChannelLogEntry[]>([]);
  const [error, setError] = useState("");
  const [level, setLevel] = useState("");
  const [search, setSearch] = useState("");
  const [paused, setPaused] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [connected, setConnected] = useState(false);
  const pausedRef = useRef(false);
  const displayed = useRef<AgentChannelLogEntry[]>([]);
  const latest = useRef<AgentChannelLogEntry[]>([]);
  const tail = useRef<HTMLDivElement>(null);
  const requestFailed = t("requestFailed");
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      try {
        const response = await fetch(
          `${endpoint}?logs=${encodeURIComponent(channel.id)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || requestFailed);
        if (!cancelled) {
          const snapshot = data.logs as AgentChannelLogEntry[];
          latest.current = snapshot;
          if (!pausedRef.current) {
            displayed.current = snapshot;
            setLogs(snapshot);
          } else {
            const previous = new Map<string, number>();
            for (const entry of displayed.current) {
              const key = JSON.stringify(entry);
              previous.set(key, (previous.get(key) ?? 0) + 1);
            }
            let count = 0;
            for (const entry of snapshot) {
              const key = JSON.stringify(entry);
              const remaining = previous.get(key) ?? 0;
              if (remaining) previous.set(key, remaining - 1);
              else count++;
            }
            setPendingCount(count);
          }
          setConnected(true);
          setError("");
        }
      } catch (cause) {
        if (!cancelled) {
          setConnected(false);
          setError(cause instanceof Error ? cause.message : requestFailed);
        }
      }
      if (!cancelled) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [endpoint, channel.id, requestFailed]);
  const lastTimestamp = logs.at(-1)?.timestamp;
  useEffect(() => {
    void lastTimestamp;
    if (!paused) tail.current?.scrollIntoView({ block: "nearest" });
  }, [lastTimestamp, paused]);
  const visible = logs.filter(
    (entry) =>
      (!level || entry.level === level) &&
      (!search ||
        entry.message.toLocaleLowerCase().includes(search.toLocaleLowerCase())),
  );
  const occurrences = new Map<string, number>();
  const keyedLogs = visible.map((entry) => {
    const identity = JSON.stringify(entry);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { entry, key: `${identity}:${occurrence}` };
  });
  const text = visible
    .map(
      (entry) =>
        `${new Date(entry.timestamp).toLocaleString()} [${entry.level.toUpperCase()}] ${entry.message}`,
    )
    .join("\n");
  return (
    <ChannelDetailPanel
      title={`${channel.name} · ${t("logs")}`}
      onClose={onClose}
    >
      <DialogBody>
        <div className="flex flex-wrap items-end gap-3">
          <DialogField
            label={t("logLevel")}
            htmlFor={levelId}
            className="w-full sm:w-40"
          >
            <FormSelect
              id={levelId}
              value={level}
              label={t("logLevel")}
              options={[
                { value: "", label: viewer("all") },
                { value: "info", label: t("logInfo") },
                { value: "error", label: t("logError") },
              ]}
              onValueChange={setLevel}
              className="w-full"
            />
          </DialogField>
          <DialogField
            label={viewer("search")}
            htmlFor={searchId}
            className="min-w-0 flex-1 basis-48"
          >
            <Input
              id={searchId}
              value={search}
              onChange={setSearch}
              className="w-full"
            />
          </DialogField>
          <div className="flex h-11 items-center gap-2">
            <LiveControls
              paused={paused}
              count={pendingCount}
              connected={connected}
              onToggle={() => {
                const next = !pausedRef.current;
                pausedRef.current = next;
                setPaused(next);
                if (!next) {
                  displayed.current = latest.current;
                  setLogs(latest.current);
                  setPendingCount(0);
                }
              }}
            />
            <CopyButton text={text} label={t("copyLogs")} iconOnly />
          </div>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div
          className="h-80 overflow-auto rounded-xl border border-border"
          role="log"
          aria-live={paused ? "off" : "polite"}
          aria-label={t("logs")}
        >
          {!visible.length && (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {t("noLogs")}
            </p>
          )}
          <ol className="divide-y divide-border">
            {keyedLogs.map(({ entry, key }) => (
              <li
                key={key}
                className="grid gap-2 p-3 text-xs sm:grid-cols-[9rem_4rem_minmax(0,1fr)]"
              >
                <RelativeTime value={new Date(entry.timestamp).toISOString()} />
                <span
                  className={
                    entry.level === "error"
                      ? "font-medium text-destructive"
                      : "text-muted-foreground"
                  }
                >
                  {t(entry.level === "error" ? "logError" : "logInfo")}
                </span>
                <p className="whitespace-pre-wrap break-words font-mono">
                  {entry.message}
                </p>
              </li>
            ))}
          </ol>
          <div ref={tail} />
        </div>
      </DialogBody>
    </ChannelDetailPanel>
  );
}

function ChannelCommands() {
  const t = useTranslations("console.agentMessaging");
  return (
    <section
      className="border-t border-border pt-4"
      aria-label={t("supportedCommands")}
    >
      <h3 className="mb-2 text-sm font-medium">{t("supportedCommands")}</h3>
      <dl className="space-y-2 text-xs">
        {(
          [
            "help",
            "whoami",
            "status",
            "new",
            "resume",
            "compact",
            "model",
            "upgrade",
          ] as const
        ).map((command) => (
          <div
            key={command}
            className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2"
          >
            <dt className="font-mono">/{command}</dt>
            <dd className="break-words text-muted-foreground">
              {t(
                {
                  new: "commandsNew",
                  compact: "commandsCompact",
                  help: "commandsHelp",
                  whoami: "commandsWhoami",
                  status: "commandsStatus",
                  resume: "commandsResume",
                  model: "commandsModel",
                  upgrade: "commandsUpgrade",
                }[command],
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ChannelEditor({
  channel,
  agents,
  pending,
  error,
  send,
  onClose,
}: {
  channel: Channel;
  agents: Agent[];
  pending: boolean;
  error: string;
  send: (command: Command) => Promise<ChannelResponse | null>;
  onClose: () => void;
}) {
  const t = useTranslations("console.agentMessaging");
  const platform = getMessagingPlatform(channel.platform);
  const [name, setName] = useState(channel.name);
  const [agentId, setAgentId] = useState(channel.agentId ?? "");
  const [values, setValues] = useState<Record<string, string>>({});
  const [adminIds, setAdminIds] = useState<string | null>(null);
  const idPrefix = useId();
  const pairing = channel.pairing;
  const waiting =
    pairing?.status === "waiting" || pairing?.status === "scanned";
  const credentialValue = (key: string, fallback = "") =>
    values[key] ?? channel.credentialValues[key] ?? fallback;
  const update = (changes: Omit<Command, "action" | "connectionId">) =>
    send({ action: "update", connectionId: channel.id, ...changes });
  const saveCredentials = async (credentials: Record<string, string>) => {
    if (!(await update({ credentials }))) return;
    setValues((current) => {
      const next = { ...current };
      for (const [key, value] of Object.entries(credentials)) {
        if (next[key] === value) delete next[key];
      }
      return next;
    });
  };
  const saveField = (key: string) => {
    if (
      values[key] !== undefined &&
      values[key] !== (channel.credentialValues[key] ?? "")
    ) {
      void saveCredentials({ [key]: values[key] });
    }
  };
  const saveAdminIds = async () => {
    if (adminIds === null) return;
    const value = adminIds;
    const adminUserIds = [
      ...new Set(
        value
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ];
    if (await update({ access: { adminUserIds } }))
      setAdminIds((current) => (current === value ? null : current));
  };
  if (!platform)
    throw new Error(`Unsupported messaging platform: ${channel.platform}`);
  const primary = PRIMARY_FIELDS[channel.platform];
  const fields = platform.credentials.filter(
    (field) => !primary || primary.includes(field.name),
  );
  const advanced = platform.credentials.filter(
    (field) => primary && !primary.includes(field.name),
  );
  const renderField = (field: MessagingCredential) => {
    const label = t.has?.(`fields.${field.name}`)
      ? t(`fields.${field.name}`)
      : field.label;
    const value = credentialValue(field.name, field.defaultValue);
    const boolean = field.inputType === "boolean";
    const id = `${idPrefix}-${field.name}`;
    const dirty =
      values[field.name] !== undefined &&
      values[field.name] !==
        (channel.credentialValues[field.name] ?? field.defaultValue ?? "");
    return (
      <DialogField
        key={field.name}
        label={label}
        htmlFor={boolean ? undefined : id}
        dirty={dirty}
        className={
          boolean || field.secret || field.name.includes("ALLOWED")
            ? "sm:col-span-2"
            : undefined
        }
      >
        {boolean ? (
          <Switch
            checked={value === "true"}
            ariaLabel={label}
            onCheckedChange={(checked) => {
              setValues((current) => ({
                ...current,
                [field.name]: String(checked),
              }));
              void saveCredentials({ [field.name]: String(checked) });
            }}
          />
        ) : field.options ? (
          <FormSelect
            id={id}
            value={value}
            label={label}
            options={[
              field.options.map((option) => ({
                value: option.value,
                label: option.label,
              })),
            ]
              .flat()
              .filter((option) => option != null)}
            onValueChange={(value) => {
              setValues((current) => ({ ...current, [field.name]: value }));
              void saveCredentials({ [field.name]: value });
            }}
            className="w-full"
          />
        ) : (
          <Input
            id={id}
            type={field.secret ? "password" : "text"}
            autoComplete={field.secret ? "new-password" : "off"}
            maxLength={8000}
            placeholder={
              field.secret && channel.credentialNames.includes(field.name)
                ? t("secretSaved")
                : field.placeholder
            }
            onBlur={() => saveField(field.name)}
            value={String(value)}
            className="w-full"
            onChange={(value) =>
              setValues((current) => ({ ...current, [field.name]: value }))
            }
          />
        )}
      </DialogField>
    );
  };
  return (
    <ChannelDetailPanel title={channel.name} onClose={onClose}>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={async (event) => {
          event.preventDefault();
          if (
            await update({
              name: name.trim(),
              ...(!channel.sandboxId ? { agentId: agentId || null } : {}),
              credentials: values,
              ...(adminIds !== null
                ? {
                    access: {
                      adminUserIds: [
                        ...new Set(
                          adminIds
                            .split(",")
                            .map((id) => id.trim())
                            .filter(Boolean),
                        ),
                      ],
                    },
                  }
                : {}),
            })
          )
            onClose();
        }}
      >
        <DialogBody>
          <DialogField
            label={t("connectionName")}
            htmlFor={`${idPrefix}-name`}
            dirty={name.trim() !== channel.name}
          >
            <Input
              id={`${idPrefix}-name`}
              autoFocus
              required
              maxLength={120}
              onBlur={() => {
                if (name.trim() && name.trim() !== channel.name)
                  void update({ name: name.trim() });
              }}
              value={String(name)}
              className="w-full"
              onChange={(value) => setName(value)}
            />
          </DialogField>
          <DialogField
            label={t("bindAgent")}
            htmlFor={`${idPrefix}-agent`}
            dirty={!channel.sandboxId && agentId !== (channel.agentId ?? "")}
          >
            <FormSelect
              id={`${idPrefix}-agent`}
              disabled={Boolean(channel.sandboxId)}
              value={channel.sandboxId ? (channel.agentId ?? "") : agentId}
              label={t("bindAgent")}
              options={[
                { value: "", label: t("noAgent") },
                agents.map((agent) => ({ value: agent.id, label: agent.name })),
              ]
                .flat()
                .filter((option) => option != null)}
              onValueChange={(value) => {
                setAgentId(value);
                void update({ agentId: value || null });
              }}
              className="w-full"
            />
          </DialogField>
          {hasBuiltInPairingProvider(platform) && (
            <section className="space-y-3 border-y border-border py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {waiting
                    ? t(
                        pairing.status === "scanned"
                          ? "statusScanned"
                          : "statusWaiting",
                      )
                    : channel.missingStartCredentialNames.length
                      ? t("qrSetup")
                      : t("setupComplete")}
                </span>
                <Button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    void send({ action: "pair", connectionId: channel.id })
                  }
                  variant={"secondary"}
                  size={"sm"}
                >
                  {pending ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <QrCode className="size-3.5" />
                  )}
                  {pairing ? t("reauthenticate") : t("requestQr")}
                </Button>
              </div>
              {waiting && pairing.qrPayload && (
                <div className="mx-auto w-56 max-w-full">
                  <QrPairingDisplay
                    payload={pairing.qrPayload}
                    label={t(`platforms.${channel.platform}`)}
                    emptyLabel={t("requestQr")}
                    errorLabel={t("qrRenderFailed")}
                  />
                </div>
              )}
              {pairing?.status === "expired" && (
                <p
                  role="status"
                  className="text-xs text-muted-foreground text-muted-foreground"
                >
                  {t("statusExpired")}
                </p>
              )}
              {pairing?.error && (
                <p
                  role="alert"
                  className="break-words text-xs text-destructive"
                >
                  {pairing.error}
                </p>
              )}
            </section>
          )}
          <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
            {fields.map(renderField)}
          </div>
          <section
            className="space-y-4 border-t border-border pt-4"
            aria-labelledby={`${idPrefix}-access`}
          >
            <h3 id={`${idPrefix}-access`} className="text-sm font-medium">
              {t("access")}
            </h3>
            <div
              className={
                channel.access.openToAll
                  ? "space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3"
                  : "space-y-3"
              }
            >
              <DialogField label={t("openToAll")}>
                <Switch
                  checked={channel.access.openToAll}
                  disabled={pending}
                  ariaLabel={t("openToAll")}
                  onCheckedChange={(openToAll) =>
                    void update({ access: { openToAll } })
                  }
                />
              </DialogField>
              {channel.access.openToAll && (
                <p
                  role="status"
                  className="text-xs text-amber-700 dark:text-amber-400"
                >
                  {t("openToAllWarning")}
                </p>
              )}
            </div>
            <DialogField
              label={t("unauthorizedDm")}
              htmlFor={`${idPrefix}-unauthorized-dm`}
            >
              <FormSelect
                id={`${idPrefix}-unauthorized-dm`}
                value={channel.access.unauthorizedDm}
                disabled={pending}
                label={t("unauthorizedDm")}
                options={(["pair", "ignore", "decline"] as const).map(
                  (value) => ({
                    value,
                    label: t(`unauthorizedDmOptions.${value}`),
                  }),
                )}
                onValueChange={(value) =>
                  void update({
                    access: {
                      unauthorizedDm:
                        value as Channel["access"]["unauthorizedDm"],
                    },
                  })
                }
                className="w-full"
              />
            </DialogField>
            <DialogField
              label={t("adminUserIds")}
              htmlFor={`${idPrefix}-admins`}
              dirty={
                adminIds !== null &&
                adminIds !== channel.access.adminUserIds.join(", ")
              }
            >
              <Input
                id={`${idPrefix}-admins`}
                value={adminIds ?? channel.access.adminUserIds.join(", ")}
                placeholder={t("adminUserIdsPlaceholder")}
                onChange={setAdminIds}
                onBlur={() => void saveAdminIds()}
                className="w-full"
              />
            </DialogField>
          </section>
          <section
            className="space-y-4 border-t border-border pt-4"
            aria-labelledby={`${idPrefix}-sessions`}
          >
            <h3 id={`${idPrefix}-sessions`} className="text-sm font-medium">
              {t("sessions")}
            </h3>
            {(["groupSessionsPerUser", "threadSessionsPerUser"] as const).map(
              (key) => (
                <DialogField key={key} label={t(key)}>
                  <Switch
                    checked={channel.sessions[key]}
                    disabled={pending}
                    ariaLabel={t(key)}
                    onCheckedChange={(value) =>
                      void update({ sessions: { [key]: value } })
                    }
                  />
                </DialogField>
              ),
            )}
          </section>
          <ChannelCommands />
          {advanced.length > 0 && (
            <BouncyAccordion
              items={[
                {
                  id: "details",
                  title: <>{t("advanced")}</>,
                  description: (
                    <>
                      <div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
                        {advanced.map(renderField)}
                      </div>
                    </>
                  ),
                },
              ]}
            />
          )}
          {error && (
            <p role="alert" className="break-words text-sm text-destructive">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter cancel={<ChannelPanelCancel onClick={onClose} />}>
          <Button type="submit" aria-busy={pending} variant="primary" size="md">
            {pending && <LoaderCircle className="size-4 animate-spin" />}
            {t("saveCredentials")}
          </Button>
        </DialogFooter>
      </form>
    </ChannelDetailPanel>
  );
}

export function AgentMessagingPanel({
  slug,
  agentId,
  sandboxId,
  connections: initialConnections,
  ready = true,
}: {
  slug: string;
  agentId?: string;
  sandboxId?: string;
  connections: Channel[];
  ready?: boolean;
}) {
  const t = useTranslations("console.agentMessaging");
  const endpoint = `/api/v1/workspaces/${encodeURIComponent(slug)}/agent-channels`;
  const requestFailed = t("requestFailed");
  const [selected, setSelected] = useState<MessagingPlatformSlug>("feishu");
  const [connections, setConnections] = useState(initialConnections);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([]);
  const [moveId, setMoveId] = useState<string | null>(null);
  const [targetSandboxId, setTargetSandboxId] = useState("");
  const targetSandboxFieldId = useId();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [logId, setLogId] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [accessId, setAccessId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState("");
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const revision = useRef(0);
  const busy = useRef(0);
  const send = useCallback(
    async (command: Command): Promise<ChannelResponse | null> => {
      revision.current += 1;
      busy.current += 1;
      setPending((count) => count + 1);
      setError("");
      const operation = queue.current.then(async () => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
        });
        const data: ChannelResponse = await response.json();
        if (data.connections) setConnections(data.connections);
        if (!response.ok) throw new Error(data.error || requestFailed);
        return data;
      });
      queue.current = operation.catch(() => {});
      try {
        return await operation;
      } catch (error) {
        setError(error instanceof Error ? error.message : requestFailed);
        return null;
      } finally {
        busy.current -= 1;
        setPending((count) => count - 1);
      }
    },
    [endpoint, requestFailed],
  );

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function refresh() {
      const version = revision.current;
      try {
        if (!busy.current && !document.hidden) {
          const query = sandboxId
            ? `?sandboxId=${encodeURIComponent(sandboxId)}`
            : "";
          const response = await fetch(`${endpoint}${query}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          const data: ChannelResponse = await response.json();
          if (!response.ok) throw new Error(data.error || requestFailed);
          if (!cancelled) {
            if (data.connections && version === revision.current)
              setConnections(data.connections);
            if (data.agents) setAgents(data.agents);
            if (data.sandboxes) setSandboxes(data.sandboxes);
          }
        }
      } catch (error) {
        if (!cancelled)
          setError(error instanceof Error ? error.message : requestFailed);
      }
      if (!cancelled) timer = setTimeout(refresh, 3000);
    }
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [endpoint, requestFailed, sandboxId]);

  const editing = connections.find((channel) => channel.id === editingId);
  const pairingStatus = editing?.pairing?.status;
  const pairingInterval = Math.max(
    3,
    Number(editing?.pairing?.extra?.interval) || 3,
  );
  useEffect(() => {
    if (!editingId || !["waiting", "scanned"].includes(pairingStatus ?? ""))
      return;
    const connectionId = editingId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      if (!busy.current && !document.hidden)
        await send({ action: "check", connectionId });
      if (!cancelled) timer = setTimeout(check, pairingInterval * 1000);
    }
    timer = setTimeout(check, pairingInterval * 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [editingId, pairingStatus, pairingInterval, send]);

  const visible = connections.filter(
    (channel) =>
      (!agentId || channel.agentId === agentId) &&
      (!sandboxId || channel.sandboxId === sandboxId),
  );
  const platforms = [
    ...PLATFORMS,
    ...new Set(
      visible
        .map((channel) => channel.platform)
        .filter((platform) => !PLATFORMS.includes(platform)),
    ),
  ];
  const selectedChannels = visible.filter(
    (channel) => channel.platform === selected,
  );
  const statusText = (status: string) =>
    t(
      {
        running: "statusRunning",
        starting: "statusStarting",
        error: "statusError",
        setup_required: "statusSetupRequired",
        waiting_callback: "statusWaitingCallback",
      }[status] ?? "statusStopped",
    );
  const platformName = (platform: string) =>
    PLATFORMS.includes(platform as MessagingPlatformSlug)
      ? t(`platforms.${platform}`)
      : (getMessagingPlatform(platform)?.label ?? platform);
  const deleteChannel = connections.find((channel) => channel.id === deleteId);
  const logChannel = connections.find((channel) => channel.id === logId);
  const accessChannel = connections.find((channel) => channel.id === accessId);
  const historyChannel = connections.find(
    (channel) => channel.id === historyId,
  );
  const moveChannel = connections.find((channel) => channel.id === moveId);
  const targetSandbox = sandboxes.find(
    (sandbox) => sandbox.id === targetSandboxId,
  );
  async function add() {
    const names = new Set(
      visible
        .filter((channel) => channel.platform === selected)
        .map((channel) => channel.name),
    );
    let name = platformName(selected);
    for (let i = 2; names.has(name); i += 1)
      name = `${platformName(selected)} ${i}`;
    const platform = getMessagingPlatform(selected);
    if (!platform)
      throw new Error(`Unsupported messaging platform: ${selected}`);
    const created = await send({
      action: "create",
      platform: selected,
      name,
      agentId: agentId ?? null,
      sandboxId,
      credentials: Object.fromEntries(
        platform.credentials.flatMap((field) =>
          field.defaultValue ? [[field.name, field.defaultValue]] : [],
        ),
      ),
    });
    if (created?.connectionId) {
      setEditingId(created.connectionId);
      if (["feishu", "weixin"].includes(selected))
        await send({ action: "pair", connectionId: created.connectionId });
    }
  }
  const detailOpen = Boolean(
    editing ||
      accessChannel ||
      logChannel ||
      historyChannel ||
      moveChannel ||
      deleteChannel,
  );
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div hidden={detailOpen} className={detailOpen ? "hidden" : "contents"}>
        <nav
          aria-label={t("platformNavigation")}
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/60 bg-muted/15 p-3"
        >
          {platforms.map((platform) => (
            <Button
              key={platform}
              type="button"
              aria-current={selected === platform ? "page" : undefined}
              onClick={() => setSelected(platform)}
              variant={selected === platform ? "secondary" : "ghost"}
              size="sm"
              className="shrink-0 justify-start rounded-xl text-left"
            >
              <PlatformIcon platform={platform} />
              <span className="whitespace-nowrap">
                {platformName(platform)}
              </span>
            </Button>
          ))}
        </nav>
        <section className="min-h-0 w-full min-w-0 flex-1 overflow-y-auto px-6 py-5">
          <header className="mb-6 flex items-center justify-between gap-3 border-b border-border/60 pb-5">
            <h2 className="flex min-w-0 items-center gap-2 text-lg font-semibold tracking-tight">
              <PlatformIcon platform={selected} />
              {platformName(selected)}
            </h2>
            <Button
              type="button"
              disabled={Boolean(pending) || !PLATFORMS.includes(selected)}
              onClick={() => void add()}
              variant={"secondary"}
              size={"sm"}
              className="shrink-0"
            >
              <Plus className="size-4" />
              {t("add")}
            </Button>
          </header>
          {!ready && (
            <p className="py-2 text-xs text-muted-foreground text-muted-foreground">
              {t(
                "configureAModelProviderBeforeExternalMessagesCanReceiveAgentReplies",
              )}
            </p>
          )}
          {error && !editing && (
            <p role="alert" className="py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          {!selectedChannels.length && (
            <div className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
              <Radio className="size-7 opacity-50" />
              <p className="text-sm">
                {t("noInstances", { platform: platformName(selected) })}
              </p>
            </div>
          )}
          <div className="divide-y divide-border/60">
            {selectedChannels.map((channel) => {
              const active = ["running", "starting"].includes(channel.status);
              return (
                <div
                  key={channel.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-2 py-3"
                >
                  <div className="min-w-0 flex-1 basis-32">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="min-w-0 max-w-full break-words text-sm font-medium">
                        {channel.name}
                      </span>
                      <AnimatedBadge
                        status={
                          channel.status === "running"
                            ? "success"
                            : channel.status === "error"
                              ? "danger"
                              : channel.status === "starting"
                                ? "loading"
                                : "neutral"
                        }
                      >
                        {statusText(channel.status)}
                      </AnimatedBadge>
                      {channel.access.openToAll && (
                        <AnimatedBadge status="warning">
                          {t("openToAll")}
                        </AnimatedBadge>
                      )}
                      {channel.access.pendingCount > 0 && (
                        <AnimatedBadge status="info">
                          {t("pendingPairingCount", {
                            count: channel.access.pendingCount,
                          })}
                        </AnimatedBadge>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {sandboxes.find(
                        (sandbox) => sandbox.id === channel.sandboxId,
                      )?.name ?? t("noSandbox")}{" "}
                      /{" "}
                      {agents.find((agent) => agent.id === channel.agentId)
                        ?.name ?? t("noAgent")}
                    </p>
                    {channel.lastError && (
                      <p className="mt-1 break-words text-xs text-destructive text-destructive">
                        {channel.lastError}
                      </p>
                    )}
                    {channel.revisions.outdatedConversations > 0 && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                        <p className="text-muted-foreground">
                          {t("outdatedConversations", {
                            count: channel.revisions.outdatedConversations,
                          })}
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={Boolean(pending)}
                          onClick={async () => {
                            const result = await send({
                              action: "upgradeConversations",
                              connectionId: channel.id,
                            });
                            if (
                              result &&
                              result.upgraded !== undefined &&
                              result.skipped !== undefined
                            )
                              notify(
                                t("conversationsUpgraded", {
                                  upgraded: result.upgraded,
                                  skipped: result.skipped,
                                }),
                              );
                            else if (!result)
                              notify(requestFailed, { severity: "error" });
                          }}
                        >
                          {t("upgradeAll")}
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-0.5">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setError("");
                        setAccessId(channel.id);
                      }}
                      size="icon"
                      aria-label={t("access")}
                    >
                      <ShieldCheck className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setHistoryId(channel.id)}
                      size="icon"
                      aria-label={t("conversationHistory")}
                    >
                      <MessagesSquare className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setLogId(channel.id)}
                      size="icon"
                      aria-label={t("logs")}
                    >
                      {<FileText className="size-4" />}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setError("");
                        setEditingId(channel.id);
                      }}
                      size="icon"
                      aria-label={t("edit")}
                    >
                      {<Pencil className="size-4" />}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setError("");
                        setTargetSandboxId("");
                        setMoveId(channel.id);
                      }}
                      size="icon"
                      aria-label={t("migrate")}
                    >
                      {<ArrowRightLeft className="size-4" />}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setDeleteId(channel.id)}
                      size="icon"
                      aria-label={t("delete")}
                    >
                      {<Trash2 className="size-4" />}
                    </Button>
                    <Switch
                      checked={active}
                      disabled={Boolean(pending)}
                      ariaLabel={`${t(active ? "stop" : "start")} ${channel.name}`}
                      onCheckedChange={() =>
                        void send({
                          action: active ? "stop" : "start",
                          connectionId: channel.id,
                        })
                      }
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
      {editing && (
        <ChannelEditor
          key={editing.id}
          channel={editing}
          agents={agents}
          pending={Boolean(pending)}
          error={error}
          send={send}
          onClose={() => setEditingId(null)}
        />
      )}
      {accessChannel && (
        <ChannelAccessPanel
          key={accessChannel.id}
          endpoint={endpoint}
          connectionId={accessChannel.id}
          name={accessChannel.name}
          pending={Boolean(pending)}
          mutationError={error}
          send={send}
          onClose={() => setAccessId(null)}
        />
      )}
      {logChannel && (
        <ChannelLogs
          endpoint={endpoint}
          channel={logChannel}
          onClose={() => setLogId(null)}
        />
      )}
      {historyChannel && (
        <ChannelHistory
          key={historyChannel.id}
          endpoint={endpoint}
          channel={historyChannel}
          onClose={() => setHistoryId(null)}
        />
      )}
      {moveChannel && (
        <ChannelDetailPanel
          title={t("migrateTitle", { name: moveChannel.name })}
          onClose={() => {
            if (!pending) setMoveId(null);
          }}
        >
          <DialogBody>
            <DialogField
              label={t("targetSandbox")}
              htmlFor={targetSandboxFieldId}
              dirty={targetSandboxId !== ""}
            >
              <FormSelect
                id={targetSandboxFieldId}
                value={targetSandboxId}
                disabled={Boolean(pending)}
                label={t("targetSandbox")}
                options={[
                  { value: "", label: t("selectSandbox") },
                  sandboxes
                    .filter((sandbox) => sandbox.id !== moveChannel.sandboxId)
                    .map((sandbox) => ({
                      value: sandbox.id,
                      label: [
                        sandbox.name,
                        "/",
                        sandbox.agentName ?? t("noAgent"),
                      ].join(" "),
                    })),
                ]
                  .flat()
                  .filter((option) => option != null)}
                onValueChange={(value) => setTargetSandboxId(value)}
                className="w-full"
              />
            </DialogField>
            <p className="text-sm text-muted-foreground">
              {t("migrateConfirmation")}
            </p>
            {targetSandbox && !targetSandbox.agentId && (
              <p className="text-sm text-muted-foreground">
                {t("targetHasNoAgent")}
              </p>
            )}
            {error && (
              <p role="alert" className="break-words text-sm text-destructive">
                {error}
              </p>
            )}
          </DialogBody>
          <DialogFooter
            cancel={
              <ChannelPanelCancel
                disabled={Boolean(pending)}
                onClick={() => setMoveId(null)}
              />
            }
          >
            <Button
              type="button"
              disabled={Boolean(pending) || !targetSandbox}
              onClick={async () => {
                if (
                  await send({
                    action: "move",
                    connectionId: moveChannel.id,
                    sandboxId: targetSandboxId,
                  })
                )
                  setMoveId(null);
              }}
              variant="primary"
              size="md"
            >
              <ArrowRightLeft className="size-4" />
              {t("migrate")}
            </Button>
          </DialogFooter>
        </ChannelDetailPanel>
      )}
      {deleteChannel && (
        <ChannelDetailPanel
          title={t("deleteTitle", { name: deleteChannel.name })}
          onClose={() => setDeleteId(null)}
        >
          <DialogBody>
            <p className="text-sm text-muted-foreground">
              {t("deleteConfirmation")}
            </p>
            {error && (
              <p role="alert" className="break-words text-sm text-destructive">
                {error}
              </p>
            )}
          </DialogBody>
          <DialogFooter
            cancel={
              <ChannelPanelCancel
                disabled={Boolean(pending)}
                onClick={() => setDeleteId(null)}
              />
            }
          >
            <Button
              type="button"
              disabled={Boolean(pending)}
              onClick={async () => {
                if (
                  await send({
                    action: "delete",
                    connectionId: deleteChannel.id,
                  })
                )
                  setDeleteId(null);
              }}
              variant="primary"
              size="md"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              <Trash2 className="size-4" />
              {t("delete")}
            </Button>
          </DialogFooter>
        </ChannelDetailPanel>
      )}
    </div>
  );
}
