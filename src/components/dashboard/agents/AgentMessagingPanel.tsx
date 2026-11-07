"use client";
import { BouncyAccordion } from "@/components/motion/bouncy-accordion";
import { Button } from "@/components/motion/button/base";
import { ButtonLink } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { FormSelect } from "@/components/ui/FormSelect";
import { Switch } from "@/components/motion/switch";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import {
  ChannelDetailPanel,
  ChannelPanelCancel,
  ChannelInlineDetails,
} from "./ChannelDetailPanel";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import {
  MorphPopover,
  MorphPopoverTrigger,
  MorphPopoverContent,
} from "@/components/motion/popover-morph";
import {
  DialogBody,
  DialogField,
  DialogFooter,
} from "@/components/dashboard/dialog";

import Image from "next/image";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ArrowRightLeft,
  ChevronDown,
  ChevronUp,
  MoreHorizontal,
  LoaderCircle,
  Plus,
  QrCode,
  Radio,
  Trash2,
} from "lucide-react";

import { QrPairingDisplay } from "@/components/dashboard/agents/QrPairingDisplay";
import { notify } from "@/components/dashboard/Toaster";
import {
  ChannelAccessPanel,
  type ChannelAccessCommand,
} from "./ChannelAccessPanel";
import type { AgentChannelConnectionClientView as Channel } from "@/lib/agents/channel-connection-client";
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
  ],
  telegram: ["TELEGRAM_BOT_TOKEN"],
  qqbot: ["QQBOT_APP_ID", "QQBOT_SECRET"],
  weixin: [],
  discord: ["DISCORD_BOT_TOKEN"],
  slack: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
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
  endpoint,
  view,
  agents,
  pending,
  error,
  send,
  onClose,
}: {
  channel: Channel;
  endpoint: string;
  view: "configure" | "access";
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
  const permissionFields = platform.credentials.filter((field) =>
    /ALLOWED|REQUIRE_MENTION/.test(field.name),
  );
  const basicFields = platform.credentials.filter(
    (field) => !permissionFields.includes(field),
  );
  const fields = basicFields.filter(
    (field) => !primary || primary.includes(field.name),
  );
  const advanced = basicFields.filter(
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
          {view === "configure" && (
            <>
              <div className="grid gap-5 md:grid-cols-2">
                <DialogField
                  label={t("connectionName")}
                  htmlFor={`${idPrefix}-name`}
                  dirty={name.trim() !== channel.name}
                >
                  <Input
                    id={`${idPrefix}-name`}
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
                  dirty={
                    !channel.sandboxId && agentId !== (channel.agentId ?? "")
                  }
                >
                  <FormSelect
                    id={`${idPrefix}-agent`}
                    disabled={Boolean(channel.sandboxId)}
                    value={
                      channel.sandboxId ? (channel.agentId ?? "") : agentId
                    }
                    label={t("bindAgent")}
                    options={[
                      { value: "", label: t("noAgent") },
                      agents.map((agent) => ({
                        value: agent.id,
                        label: agent.name,
                      })),
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
              </div>
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
              <BouncyAccordion
                items={[
                  {
                    id: "details",
                    title: <>{t("advanced")}</>,
                    description: (
                      <div className="space-y-5">
                        <section
                          className="space-y-4 border-t border-border pt-4"
                          aria-labelledby={`${idPrefix}-sessions`}
                        >
                          <h3
                            id={`${idPrefix}-sessions`}
                            className="text-sm font-medium"
                          >
                            {t("sessions")}
                          </h3>
                          {(
                            [
                              "groupSessionsPerUser",
                              "threadSessionsPerUser",
                            ] as const
                          ).map((key) => (
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
                          ))}
                        </section>
                        <ChannelCommands />
                        <div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
                          {advanced.map(renderField)}
                        </div>
                      </div>
                    ),
                  },
                ]}
              />
            </>
          )}
          {view === "access" && (
            <>
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
              <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
                {permissionFields.map(renderField)}
              </div>
              <ChannelAccessPanel
                endpoint={endpoint}
                connectionId={channel.id}
                pending={pending}
                send={send}
              />
            </>
          )}
          {error && (
            <p role="alert" className="break-words text-sm text-destructive">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter
          className="static"
          cancel={<ChannelPanelCancel onClick={onClose} />}
        >
          <Button
            type="submit"
            disabled={pending}
            aria-busy={pending}
            variant="primary"
            size="md"
          >
            {pending && <LoaderCircle className="size-4 animate-spin" />}
            {t("saveSettings")}
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
  const [selected, setSelected] = useState<MessagingPlatformSlug | "all">(
    "all",
  );
  const [adding, setAdding] = useState(false);
  const [moreId, setMoreId] = useState<string | null>(null);
  const [connections, setConnections] = useState(initialConnections);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([]);
  const [moveId, setMoveId] = useState<string | null>(null);
  const [targetSandboxId, setTargetSandboxId] = useState("");
  const targetSandboxFieldId = useId();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [settingsView, setSettingsView] = useState<"configure" | "access">(
    "configure",
  );
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
    (channel) => selected === "all" || channel.platform === selected,
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
  const moveChannel = connections.find((channel) => channel.id === moveId);
  const targetSandbox = sandboxes.find(
    (sandbox) => sandbox.id === targetSandboxId,
  );
  function closeDetails() {
    setEditingId(null);
    setMoveId(null);
    setDeleteId(null);
  }
  function openDetail(id: string, view: string) {
    closeDetails();
    setError("");
    setMoreId(null);
    if (view === "configure" || view === "access") {
      setSettingsView(view);
      setEditingId(id);
    } else if (view === "migrate") {
      setTargetSandboxId("");
      setMoveId(id);
    } else if (view === "delete") setDeleteId(id);
  }
  async function add(platformSlug: MessagingPlatformSlug) {
    const names = new Set(
      visible
        .filter((channel) => channel.platform === platformSlug)
        .map((channel) => channel.name),
    );
    let name = platformName(platformSlug);
    for (let i = 2; names.has(name); i += 1)
      name = `${platformName(platformSlug)} ${i}`;
    const platform = getMessagingPlatform(platformSlug);
    if (!platform)
      throw new Error(`Unsupported messaging platform: ${platformSlug}`);
    const created = await send({
      action: "create",
      platform: platformSlug,
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
      setAdding(false);
      setSelected("all");
      openDetail(created.connectionId, "configure");
      if (["feishu", "weixin"].includes(platformSlug))
        await send({ action: "pair", connectionId: created.connectionId });
    }
  }
  const detailChannel = editing ?? moveChannel ?? deleteChannel;
  const detailView = editing
    ? settingsView
    : moveChannel
      ? "migrate"
      : "delete";
  const detailContent = (
    <>
      {editing && (
        <ChannelEditor
          key={editing.id}
          channel={editing}
          endpoint={endpoint}
          view={settingsView}
          agents={agents}
          pending={Boolean(pending)}
          error={error}
          send={send}
          onClose={() => setEditingId(null)}
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
    </>
  );
  return (
    <div className="h-full min-h-0 min-w-0 overflow-y-auto px-4 py-5 sm:px-6">
      <header className="mb-5 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <MorphPopover open={adding} onOpenChange={setAdding}>
          <MorphPopoverTrigger>
            <Button disabled={Boolean(pending)} variant="primary" size="sm">
              <Plus className="size-4" />
              {t("addChannel")}
            </Button>
          </MorphPopoverTrigger>
          <MorphPopoverContent className="w-56 p-2">
            <section className="grid gap-1" aria-label={t("choosePlatform")}>
              {PLATFORMS.map((platform) => (
                <Button
                  key={platform}
                  disabled={Boolean(pending)}
                  variant="ghost"
                  size="sm"
                  className="justify-start"
                  onClick={() => void add(platform)}
                >
                  <PlatformIcon platform={platform} />
                  {platformName(platform)}
                </Button>
              ))}
            </section>
          </MorphPopoverContent>
        </MorphPopover>
      </header>
      <nav
        aria-label={t("platformNavigation")}
        className="mb-4 flex gap-1 overflow-x-auto pb-2"
      >
        <Button
          type="button"
          aria-current={selected === "all" ? "page" : undefined}
          onClick={() => {
            setSelected("all");
            closeDetails();
          }}
          variant={selected === "all" ? "secondary" : "ghost"}
          size="sm"
          className="shrink-0"
        >
          {t("allChannels")}{" "}
          <span className="text-muted-foreground">{visible.length}</span>
        </Button>
        {platforms.map((platform) => (
          <Button
            key={platform}
            type="button"
            aria-current={selected === platform ? "page" : undefined}
            onClick={() => {
              setSelected(platform);
              closeDetails();
            }}
            variant={selected === platform ? "secondary" : "ghost"}
            size="sm"
            className="shrink-0 justify-start rounded-xl text-left"
          >
            <span className="whitespace-nowrap">{platformName(platform)}</span>
          </Button>
        ))}
      </nav>
      <section aria-label={t("channelList")} className="min-w-0">
        {!ready && (
          <p className="mb-4 text-xs text-muted-foreground">
            {t(
              "configureAModelProviderBeforeExternalMessagesCanReceiveAgentReplies",
            )}
          </p>
        )}
        {error && !detailChannel && (
          <p role="alert" className="py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {!selectedChannels.length && (
          <div className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
            <Radio className="size-7 opacity-50" />
            <p className="text-sm">
              {selected === "all"
                ? t("noChannels")
                : t("noInstances", { platform: platformName(selected) })}
            </p>
          </div>
        )}
        <div className="space-y-2">
          {selectedChannels.map((channel) => {
            const active = ["running", "starting"].includes(channel.status);
            const expanded = detailChannel?.id === channel.id;
            const panelId = `${targetSandboxFieldId}-${channel.id}`;
            return (
              <div
                key={channel.id}
                className={`min-w-0 rounded-xl border ${expanded ? "border-border bg-muted/10" : "border-transparent border-b-border/60"}`}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-3 p-3 sm:p-4">
                  <PlatformIcon platform={channel.platform} />
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
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {platformName(channel.platform)}
                      {!agentId && (
                        <>
                          {" "}
                          ·{" "}
                          {agents.find((agent) => agent.id === channel.agentId)
                            ?.name ?? t("noAgent")}
                        </>
                      )}
                    </p>
                    {channel.lastError && (
                      <p className="mt-1 break-words text-xs text-destructive">
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
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-expanded={expanded}
                      aria-controls={expanded ? panelId : undefined}
                      disabled={Boolean(pending)}
                      onClick={() =>
                        expanded
                          ? closeDetails()
                          : openDetail(channel.id, "configure")
                      }
                    >
                      {t(expanded ? "collapse" : "configure")}
                      {expanded ? (
                        <ChevronUp className="size-4" />
                      ) : (
                        <ChevronDown className="size-4" />
                      )}
                    </Button>
                    <MorphPopover
                      open={moreId === channel.id}
                      onOpenChange={(open) =>
                        setMoreId(open ? channel.id : null)
                      }
                    >
                      <MorphPopoverTrigger>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t("moreActions", { name: channel.name })}
                          disabled={Boolean(pending)}
                        >
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </MorphPopoverTrigger>
                      <MorphPopoverContent className="w-44 p-1">
                        <div className="grid gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="justify-start"
                            onClick={() => openDetail(channel.id, "migrate")}
                          >
                            <ArrowRightLeft className="size-4" />
                            {t("migrate")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="justify-start text-destructive"
                            onClick={() => openDetail(channel.id, "delete")}
                          >
                            <Trash2 className="size-4" />
                            {t("delete")}
                          </Button>
                        </div>
                      </MorphPopoverContent>
                    </MorphPopover>
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
                {expanded && (
                  <div id={panelId} className="min-w-0 border-t border-border">
                    {detailView === "migrate" || detailView === "delete" ? (
                      detailContent
                    ) : (
                      <Tabs
                        variant="underline"
                        value={detailView}
                        onValueChange={(view) => openDetail(channel.id, view)}
                        className="min-w-0"
                      >
                        <TabsList
                          aria-label={t("channelDetails")}
                          wrapperClassName="px-3 sm:px-4"
                        >
                          {(["configure", "access"] as const).map((view) => (
                            <TabsTrigger
                              key={view}
                              value={view}
                              id={`${panelId}-${view}-tab`}
                              aria-controls={`${panelId}-settings`}
                            >
                              {t(view === "configure" ? "basic" : view)}
                              {view === "access" &&
                                channel.access.pendingCount > 0 && (
                                  <span className="ml-1 text-xs text-amber-600">
                                    {channel.access.pendingCount}
                                  </span>
                                )}
                            </TabsTrigger>
                          ))}
                        </TabsList>
                        <div
                          id={`${panelId}-settings`}
                          role="tabpanel"
                          aria-labelledby={`${panelId}-${detailView}-tab`}
                          className="mt-4 min-w-0"
                        >
                          <ChannelInlineDetails>
                            {detailContent}
                          </ChannelInlineDetails>
                        </div>
                        <div className="px-6 pb-4">
                          <ButtonLink
                            href={`/app/${encodeURIComponent(slug)}/observability?tab=channels&channelId=${encodeURIComponent(channel.id)}${channel.agentId ? `&agentId=${encodeURIComponent(channel.agentId)}` : ""}`}
                            variant="ghost"
                            size="sm"
                          >
                            {t("observe")}
                          </ButtonLink>
                        </div>
                      </Tabs>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
