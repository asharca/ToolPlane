"use client";

import {
  Activity,
  AlertCircle,
  ArrowRight,
  BookOpen,
  Box,
  Check,
  Copy,
  EyeOff,
  FileCode2,
  GitBranch,
  GitCommitHorizontal,
  Info,
  Laptop,
  Layers,
  MessageSquare,
  Radio,
  Server,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Terminal,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { GithubIcon } from "@/components/ui/GithubIcon";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import {
  BouncyAccordion,
  type BouncyAccordionItem,
} from "@/components/motion/bouncy-accordion";
import { Button, ButtonLink } from "@/components/motion/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/motion/card";
import { IsometricScenes } from "@/components/motion/illustration-isometric-scenes";
import { ScrollReveal } from "@/components/motion/scroll-reveal";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/motion/tabs";
import type { MarketingContent } from "@/lib/marketing/content";
import { SITE } from "@/lib/site";
import { cn } from "@/lib/utils";

interface LandingShowcaseProps {
  content: MarketingContent;
}

type ToolPolicy = "allow" | "approve" | "deny";
type CopyState = "idle" | "copied" | "error";

const POLICY_CYCLE: Record<ToolPolicy, ToolPolicy> = {
  allow: "approve",
  approve: "deny",
  deny: "allow",
};

const POLICY_STYLES: Record<ToolPolicy, string> = {
  allow:
    "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  approve:
    "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  deny: "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-400",
};

const SECURITY_ICONS: Record<string, typeof ShieldCheck> = {
  "workspace-auth": ShieldCheck,
  "sandbox-isolation": Box,
  "immutable-pin": GitCommitHorizontal,
  redaction: EyeOff,
};

const SANDBOX_TARGET_ICONS: Record<string, typeof Box> = {
  docker: Box,
  connector: Laptop,
  adb: Smartphone,
};

const CLIENT_LAYER_ICONS: Record<string, typeof Server> = {
  mcp: Server,
  api: FileCode2,
  im: MessageSquare,
  trace: Activity,
};

export function LandingShowcase({ content }: LandingShowcaseProps) {
  const { home, capabilities, navigation } = content;

  // Interactive MCP server & per-tool policy state
  const [selectedServerId, setSelectedServerId] = useState(
    home.mcpPreview.servers[0]?.id ?? "github-mcp",
  );
  const [policyOverrides, setPolicyOverrides] = useState<
    Record<string, ToolPolicy>
  >({});

  // Interactive GitHub Plugin Pin card state
  const [selectedPluginId, setSelectedPluginId] = useState(
    home.skillsPreview.plugins[0]?.id ?? "code-review",
  );

  // Interactive Revision Diff / Sessions tab state
  const [revisionTab, setRevisionTab] = useState<"diff" | "sessions">("diff");

  // Interactive Clients surface layer state
  const [selectedClientLayer, setSelectedClientLayer] = useState(
    home.clientsPreview.nodes[0]?.id ?? "mcp",
  );

  // Quickstart terminal tab & honest clipboard copy state
  const [quickstartTab, setQuickstartTab] = useState<"docker" | "local">(
    "docker",
  );
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const activeServer =
    home.mcpPreview.servers.find((s) => s.id === selectedServerId) ??
    home.mcpPreview.servers[0];

  const activePlugin =
    home.skillsPreview.plugins.find((p) => p.id === selectedPluginId) ??
    home.skillsPreview.plugins[0];

  const activeClientNode =
    home.clientsPreview.nodes.find((n) => n.id === selectedClientLayer) ??
    home.clientsPreview.nodes[0];

  const faqItems = useMemo<BouncyAccordionItem[]>(
    () =>
      home.faq.items.map((item) => ({
        id: item.id,
        title: item.question,
        description: item.answer,
      })),
    [home.faq.items],
  );

  function cycleToolPolicy(toolKey: string, current: ToolPolicy) {
    setPolicyOverrides((prev) => ({
      ...prev,
      [toolKey]: POLICY_CYCLE[current],
    }));
  }

  async function handleCopyCommand(text: string) {
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }

    if (
      typeof navigator === "undefined" ||
      !navigator.clipboard ||
      typeof navigator.clipboard.writeText !== "function"
    ) {
      setCopyState("error");
      copyTimerRef.current = window.setTimeout(
        () => setCopyState("idle"),
        2400,
      );
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }

    copyTimerRef.current = window.setTimeout(() => setCopyState("idle"), 2200);
  }

  function handleQuickstartTabChange(next: string) {
    setQuickstartTab(next as "docker" | "local");
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
    setCopyState("idle");
  }

  const activeQuickstart = home.quickstart.tabs[quickstartTab];

  return (
    <div className="divide-y divide-border">
      {/* Section A — Architecture Pipeline */}
      <section className="py-16 sm:py-20">
        <ScrollReveal blur={0} y={12} duration={0.4} amount="some" once>
          <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
            <div className="max-w-2xl">
              <h2 className="text-balance text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                {home.pipeline.title}
              </h2>
              <p className="mt-3 text-pretty text-sm leading-relaxed text-muted-foreground sm:text-base">
                {home.pipeline.description}
              </p>
            </div>

            <ol className="relative mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {home.pipeline.steps.map((step, index) => (
                <li
                  key={step.index}
                  className="relative flex flex-col rounded-2xl border border-border bg-card/70 p-5"
                >
                  {index < home.pipeline.steps.length - 1 && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute -right-4 top-8 hidden h-px w-4 bg-border-strong lg:block"
                    />
                  )}
                  <span className="font-mono text-xs font-semibold text-primary">
                    {step.index}
                  </span>
                  <h3 className="mt-3 text-base font-semibold tracking-tight text-foreground">
                    {step.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {step.description}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </ScrollReveal>
      </section>

      {/* Section B — #mcp Managed MCP Runtime & Explicit Tool Authorization */}
      <section id="mcp" className="scroll-mt-24 py-16 sm:py-24">
        <ScrollReveal blur={0} y={12} duration={0.4} amount="some" once>
          <div className="mx-auto grid max-w-6xl grid-cols-1 items-start gap-10 px-4 sm:px-6 lg:grid-cols-12 lg:gap-12 lg:px-8">
            <div className="min-w-0 lg:col-span-5">
              <h2 className="text-balance text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                {capabilities.mcp.title}
              </h2>
              <p className="mt-4 text-pretty text-sm leading-relaxed text-muted-foreground sm:text-base">
                {capabilities.mcp.description}
              </p>

              <ul className="mt-8 space-y-5">
                {capabilities.mcp.highlights.map((item) => (
                  <li key={item.title} className="flex gap-3.5">
                    <span
                      aria-hidden="true"
                      className="mt-1 grid size-5 shrink-0 place-items-center rounded-md border border-border-strong bg-card text-primary"
                    >
                      <Server className="size-3" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-foreground">
                        {item.title}
                      </h3>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                        {item.description}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            <div className="min-w-0 lg:col-span-7">
              <div className="overflow-hidden rounded-2xl border border-border-strong bg-card shadow-xs">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-5">
                  <fieldset
                    aria-label={capabilities.mcp.eyebrow}
                    className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0"
                  >
                    {home.mcpPreview.servers.map((server) => {
                      const active = server.id === activeServer?.id;
                      return (
                        <button
                          key={server.id}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setSelectedServerId(server.id)}
                          className={cn(
                            "rounded-lg px-3 py-1.5 font-mono text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                            active
                              ? "bg-primary text-primary-foreground"
                              : "bg-background/70 text-muted-foreground hover:bg-background hover:text-foreground",
                          )}
                        >
                          {server.name}
                        </button>
                      );
                    })}
                  </fieldset>
                  {activeServer && (
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {activeServer.source}
                    </span>
                  )}
                </div>

                {activeServer && (
                  <div className="bg-background/60 p-4 sm:p-5">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs text-muted-foreground">
                      <span className="truncate">{activeServer.endpoint}</span>
                      <AnimatedBadge status="success" size="sm">
                        JSON-RPC
                      </AnimatedBadge>
                    </div>

                    <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                      {activeServer.tools.map((tool) => {
                        const toolKey = `${activeServer.id}:${tool.id}`;
                        const policy =
                          policyOverrides[toolKey] ?? tool.defaultPolicy;
                        return (
                          <div
                            key={toolKey}
                            className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between"
                          >
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono text-xs font-semibold text-foreground sm:text-sm">
                                  {tool.name}
                                </span>
                                <span className="rounded bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                                  {tool.scope}
                                </span>
                              </div>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {tool.description}
                              </p>
                            </div>

                            <div className="flex shrink-0 items-center gap-3">
                              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                                {tool.latency}
                              </span>
                              <button
                                type="button"
                                onClick={() => cycleToolPolicy(toolKey, policy)}
                                title={home.mcpPreview.policyToggleHint}
                                aria-label={`${tool.name}: ${home.mcpPreview.policyLabels[policy]} — ${home.mcpPreview.policyToggleHint}`}
                                className={cn(
                                  "inline-flex min-w-[5.75rem] items-center justify-center rounded-full border px-2.5 py-1 text-xs font-medium transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-ring",
                                  POLICY_STYLES[policy],
                                )}
                              >
                                {home.mcpPreview.policyLabels[policy]}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </ScrollReveal>
      </section>

      {/* Section C — #skills GitHub Plugin Center */}
      <section id="skills" className="scroll-mt-24 py-16 sm:py-24">
        <ScrollReveal blur={0} y={12} duration={0.4} amount="some" once>
          <div className="mx-auto grid max-w-6xl grid-cols-1 items-start gap-10 px-4 sm:px-6 lg:grid-cols-12 lg:gap-12 lg:px-8">
            {/* Interactive GitHub Plugin Commit Pin Card */}
            <div className="order-2 min-w-0 lg:order-1 lg:col-span-7">
              <div className="overflow-hidden rounded-2xl border border-border-strong bg-card shadow-xs">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-5">
                  <fieldset
                    aria-label={capabilities.skills.eyebrow}
                    className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0"
                  >
                    {home.skillsPreview.plugins.map((plugin) => {
                      const active = plugin.id === activePlugin?.id;
                      return (
                        <button
                          key={plugin.id}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setSelectedPluginId(plugin.id)}
                          className={cn(
                            "rounded-lg px-3 py-1.5 font-mono text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                            active
                              ? "bg-primary text-primary-foreground"
                              : "bg-background/70 text-muted-foreground hover:bg-background hover:text-foreground",
                          )}
                        >
                          {plugin.pluginId}
                        </button>
                      );
                    })}
                  </fieldset>
                  {activePlugin && (
                    <span className="rounded-full border border-border bg-background px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {activePlugin.schema}
                    </span>
                  )}
                </div>

                {activePlugin && (
                  <div className="bg-background/60 p-4 sm:p-5">
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                          <GithubIcon
                            aria-hidden="true"
                            className="size-4 shrink-0 text-muted-foreground"
                          />
                          <span className="truncate font-mono">
                            {activePlugin.repo}
                          </span>
                        </div>
                        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                          {activePlugin.summary}
                        </p>
                      </div>

                      <div className="flex shrink-0 items-center gap-2 font-mono text-xs">
                        <span className="inline-flex items-center gap-1 rounded-md border border-border-strong bg-background px-2 py-1 text-foreground">
                          <GitCommitHorizontal
                            aria-hidden="true"
                            className="size-3.5 text-primary"
                          />
                          {activePlugin.commit}
                        </span>
                        <span className="rounded-md border border-border bg-background px-2 py-1 text-muted-foreground">
                          v{activePlugin.version}
                        </span>
                      </div>
                    </div>

                    <div className="mt-4">
                      <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                        <span>{home.skillsPreview.artifactsLabel}</span>
                        <span className="font-mono text-[11px]">
                          {activePlugin.reviewNote}
                        </span>
                      </div>

                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {activePlugin.artifacts.map((artifact) => (
                          <div
                            key={artifact.path}
                            className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2.5"
                          >
                            <span className="flex min-w-0 items-center gap-2 font-mono text-xs text-foreground">
                              <FileCode2
                                aria-hidden="true"
                                className="size-3.5 shrink-0 text-primary"
                              />
                              <span className="truncate">{artifact.path}</span>
                            </span>
                            <span className="shrink-0 rounded bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
                              {artifact.role}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-300">
                      <ShieldAlert
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0"
                      />
                      <span>{home.skillsPreview.reviewBanner}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Copy */}
            <div className="order-1 min-w-0 lg:order-2 lg:col-span-5">
              <h2 className="text-balance text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                {capabilities.skills.title}
              </h2>
              <p className="mt-4 text-pretty text-sm leading-relaxed text-muted-foreground sm:text-base">
                {capabilities.skills.description}
              </p>

              <ul className="mt-8 space-y-5">
                {capabilities.skills.highlights.map((item) => (
                  <li key={item.title} className="flex gap-3.5">
                    <span
                      aria-hidden="true"
                      className="mt-1 grid size-5 shrink-0 place-items-center rounded-md border border-border-strong bg-card text-primary"
                    >
                      <GitBranch className="size-3" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-foreground">
                        {item.title}
                      </h3>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                        {item.description}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </ScrollReveal>
      </section>

      {/* Section D — #agents Pi SDK Revisions, Sandboxes & Native A2A Bento */}
      <section id="agents" className="scroll-mt-24 py-16 sm:py-24">
        <ScrollReveal blur={0} y={12} duration={0.4} amount="some" once>
          <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
            <div className="max-w-3xl">
              <h2 className="text-balance text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                {capabilities.agents.title}
              </h2>
              <p className="mt-4 text-pretty text-sm leading-relaxed text-muted-foreground sm:text-base">
                {capabilities.agents.description}
              </p>
            </div>

            <div className="mt-10 grid grid-cols-1 gap-5 lg:grid-cols-12">
              {/* Bento 1: Immutable Revision Diff & Pinned Sessions */}
              <Card className="min-w-0 lg:col-span-7">
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle as="h3">
                      {home.agentsPreview.revisionCard.title}
                    </CardTitle>
                    <AnimatedBadge status="info" size="sm">
                      {home.agentsPreview.revisionCard.badge}
                    </AnimatedBadge>
                  </div>
                  <CardDescription>
                    {home.agentsPreview.revisionCard.description}
                  </CardDescription>
                </CardHeader>

                <CardContent>
                  <Tabs
                    value={revisionTab}
                    onValueChange={(next) =>
                      setRevisionTab(next as "diff" | "sessions")
                    }
                    variant="segment"
                  >
                    <TabsList className="mb-3">
                      <TabsTrigger value="diff">
                        {home.agentsPreview.revisionCard.tabs.diff}
                      </TabsTrigger>
                      <TabsTrigger value="sessions">
                        {home.agentsPreview.revisionCard.tabs.sessions}
                      </TabsTrigger>
                    </TabsList>

                    <TabsContent value="diff" className="mt-0">
                      <div className="overflow-x-auto rounded-xl border border-border bg-background p-3 font-mono text-xs leading-6">
                        {home.agentsPreview.revisionCard.diffLines.map(
                          (line) => (
                            <div
                              key={line.id}
                              className={cn(
                                "rounded px-2 py-0.5 whitespace-pre",
                                line.type === "add" &&
                                  "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
                                line.type === "remove" &&
                                  "bg-rose-500/10 text-rose-800 dark:text-rose-300",
                                line.type === "context" &&
                                  "text-muted-foreground",
                              )}
                            >
                              {line.text}
                            </div>
                          ),
                        )}
                      </div>
                    </TabsContent>

                    <TabsContent value="sessions" className="mt-0">
                      <div className="space-y-2.5">
                        {home.agentsPreview.revisionCard.sessions.map(
                          (session) => (
                            <div
                              key={session.id}
                              className="flex flex-col gap-2 rounded-xl border border-border bg-background p-3.5 sm:flex-row sm:items-center sm:justify-between"
                            >
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-foreground">
                                  {session.name}
                                </div>
                                <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                                  {session.workspaceDir}
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-2">
                                <span className="rounded-md border border-border-strong bg-card px-2 py-0.5 font-mono text-xs font-medium text-foreground">
                                  {session.revision}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  {session.status}
                                </span>
                              </div>
                            </div>
                          ),
                        )}
                      </div>
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>

              {/* Bento 2: Sandboxes & Device Bridges */}
              <Card className="min-w-0 lg:col-span-5">
                <CardHeader>
                  <CardTitle as="h3">
                    {home.agentsPreview.sandboxCard.title}
                  </CardTitle>
                  <CardDescription>
                    {home.agentsPreview.sandboxCard.description}
                  </CardDescription>
                </CardHeader>

                <CardContent className="space-y-3">
                  {home.agentsPreview.sandboxCard.targets.map((target) => {
                    const Icon = SANDBOX_TARGET_ICONS[target.id] ?? Box;
                    return (
                      <div
                        key={target.id}
                        className="rounded-xl border border-border bg-background p-3.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                            <Icon
                              aria-hidden="true"
                              className="size-4 shrink-0 text-primary"
                            />
                            <span>{target.name}</span>
                          </div>
                          <span className="shrink-0 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground">
                            {target.badge}
                          </span>
                        </div>
                        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                          {target.description}
                        </p>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>

              {/* Bento 3: Native A2A Delegation */}
              <Card className="min-w-0 lg:col-span-12">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Workflow
                      aria-hidden="true"
                      className="size-4 text-primary"
                    />
                    <CardTitle as="h3">
                      {home.agentsPreview.a2aCard.title}
                    </CardTitle>
                  </div>
                  <CardDescription>
                    {home.agentsPreview.a2aCard.description}
                  </CardDescription>
                </CardHeader>

                <CardContent>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                    {home.agentsPreview.a2aCard.steps.map((step, index) => (
                      <div
                        key={step.id}
                        className="relative rounded-xl border border-border bg-background p-4"
                      >
                        {index <
                          home.agentsPreview.a2aCard.steps.length - 1 && (
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute -right-3 top-1/2 hidden h-px w-3 bg-border-strong md:block"
                          />
                        )}
                        <span className="inline-flex items-center rounded-md border border-border bg-card px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                          {step.role}
                        </span>
                        <h4 className="mt-2.5 text-sm font-semibold text-foreground">
                          {step.title}
                        </h4>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          {step.detail}
                        </p>
                      </div>
                    ))}
                  </div>
                  <p className="mt-3.5 text-xs text-muted-foreground">
                    {home.agentsPreview.a2aCard.footerNote}
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>
        </ScrollReveal>
      </section>

      {/* Section E — #clients Integrations & Observability */}
      <section id="clients" className="scroll-mt-24 py-16 sm:py-24">
        <ScrollReveal blur={0} y={12} duration={0.4} amount="some" once>
          <div className="mx-auto grid max-w-6xl grid-cols-1 items-start gap-10 px-4 sm:px-6 lg:grid-cols-12 lg:gap-12 lg:px-8">
            <div className="min-w-0 lg:col-span-5">
              <h2 className="text-balance text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                {capabilities.clients.title}
              </h2>
              <p className="mt-4 text-pretty text-sm leading-relaxed text-muted-foreground sm:text-base">
                {capabilities.clients.description}
              </p>

              <div className="mt-6 flex flex-wrap gap-2">
                {home.clientsPreview.surfaces.map((surface) => (
                  <span
                    key={surface}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-card px-3 py-1 text-xs font-medium text-foreground"
                  >
                    <Radio aria-hidden="true" className="size-3 text-primary" />
                    {surface}
                  </span>
                ))}
              </div>

              <ul className="mt-8 space-y-5">
                {capabilities.clients.highlights.map((item) => (
                  <li key={item.title} className="flex gap-3.5">
                    <span
                      aria-hidden="true"
                      className="mt-1 grid size-5 shrink-0 place-items-center rounded-md border border-border-strong bg-card text-primary"
                    >
                      <Layers className="size-3" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-foreground">
                        {item.title}
                      </h3>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                        {item.description}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            <div className="min-w-0 lg:col-span-7">
              <div className="overflow-hidden rounded-2xl border border-border-strong bg-card shadow-xs">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-5">
                  <span className="font-mono text-xs font-medium text-muted-foreground">
                    {home.clientsPreview.protocolLabel}
                  </span>
                  <Link
                    href="/docs-api"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <FileCode2
                      aria-hidden="true"
                      className="size-3.5 text-primary"
                    />
                    <span>{home.clientsPreview.exploreApiLabel}</span>
                    <ArrowRight aria-hidden="true" className="size-3" />
                  </Link>
                </div>

                <div className="bg-background/60 p-4 sm:p-5">
                  <IsometricScenes
                    variant={4}
                    nodes={home.clientsPreview.nodes}
                    value={selectedClientLayer}
                    onValueChange={setSelectedClientLayer}
                    label={home.clientsPreview.sceneLabel}
                    autoPlay={false}
                    showControls={false}
                    className="mb-4 aspect-[16/7] max-w-none border border-border bg-card/50"
                  />
                  <fieldset
                    aria-label={home.clientsPreview.sceneLabel}
                    className="m-0 grid min-w-0 grid-cols-2 gap-2 border-0 p-0 sm:grid-cols-4"
                  >
                    {home.clientsPreview.nodes.map((node) => {
                      const active = node.id === activeClientNode?.id;
                      const Icon = CLIENT_LAYER_ICONS[node.id] ?? Server;
                      return (
                        <button
                          key={node.id}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setSelectedClientLayer(node.id)}
                          className={cn(
                            "rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                            active
                              ? "border-primary/50 bg-card text-foreground shadow-xs"
                              : "border-border bg-card/40 text-muted-foreground hover:border-border-strong hover:bg-card/80 hover:text-foreground",
                          )}
                        >
                          <div className="flex items-center justify-between gap-1.5">
                            <span className="font-mono text-[11px] font-semibold text-primary">
                              {node.label}
                            </span>
                            <Icon
                              aria-hidden="true"
                              className={cn(
                                "size-3.5 shrink-0",
                                active
                                  ? "text-primary"
                                  : "text-muted-foreground",
                              )}
                            />
                          </div>
                          <div className="mt-1 truncate text-xs font-medium">
                            {node.title}
                          </div>
                        </button>
                      );
                    })}
                  </fieldset>

                  {activeClientNode && (
                    <div className="mt-4 rounded-xl border border-border bg-card p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
                        <div className="text-sm font-semibold text-foreground">
                          {activeClientNode.title}
                        </div>
                        <span className="rounded-md border border-border bg-background px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                          {activeClientNode.endpoint}
                        </span>
                      </div>
                      <p className="mt-3 text-xs leading-relaxed text-muted-foreground sm:text-sm">
                        {activeClientNode.detail}
                      </p>
                      <pre className="mt-3.5 overflow-x-auto rounded-lg border border-border bg-background p-3.5 font-mono text-xs leading-6 text-foreground">
                        <code>{activeClientNode.snippet}</code>
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </ScrollReveal>
      </section>

      {/* Section F — Security & Isolation Boundaries */}
      <section className="py-16 sm:py-24">
        <ScrollReveal blur={0} y={12} duration={0.4} amount="some" once>
          <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
            <div className="rounded-2xl border border-border-strong bg-card/60 p-6 sm:p-10">
              <div className="max-w-2xl">
                <h2 className="text-balance text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                  {home.security.title}
                </h2>
                <p className="mt-3 text-pretty text-sm leading-relaxed text-muted-foreground sm:text-base">
                  {home.security.description}
                </p>
              </div>

              <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2">
                {home.security.items.map((item) => {
                  const Icon = SECURITY_ICONS[item.id] ?? ShieldCheck;
                  return (
                    <div
                      key={item.id}
                      className="rounded-xl border border-border bg-background p-5"
                    >
                      <span
                        aria-hidden="true"
                        className="grid size-9 place-items-center rounded-lg border border-border-strong bg-card text-primary"
                      >
                        <Icon className="size-4" />
                      </span>
                      <h3 className="mt-4 text-base font-semibold text-foreground">
                        {item.title}
                      </h3>
                      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                        {item.description}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </ScrollReveal>
      </section>

      {/* Section G — #quickstart Self-Host Quick Start */}
      <section id="quickstart" className="scroll-mt-24 py-16 sm:py-24">
        <ScrollReveal blur={0} y={12} duration={0.4} amount="some" once>
          <div className="mx-auto grid max-w-6xl grid-cols-1 items-start gap-8 px-4 sm:px-6 lg:grid-cols-12 lg:gap-12 lg:px-8">
            <div className="min-w-0 lg:col-span-5">
              <h2 className="text-balance text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                {home.quickstart.title}
              </h2>
              <p className="mt-4 text-pretty text-sm leading-relaxed text-muted-foreground sm:text-base">
                {home.quickstart.description}
              </p>

              <div className="mt-6 flex items-start gap-2.5 rounded-xl border border-border bg-card p-3.5 text-xs leading-relaxed text-muted-foreground">
                <Info
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-primary"
                />
                <span>{home.quickstart.runtimeNote}</span>
              </div>

              <div className="mt-6 flex flex-wrap items-center gap-3">
                <ButtonLink
                  href={navigation.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="secondary"
                  size="sm"
                >
                  <BookOpen aria-hidden="true" className="size-3.5" />
                  {home.quickstart.docsLabel}
                </ButtonLink>
                <ButtonLink
                  href={home.quickstart.opsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="ghost"
                  size="sm"
                >
                  {home.quickstart.opsLabel}
                  <ArrowRight aria-hidden="true" className="size-3.5" />
                </ButtonLink>
              </div>
            </div>

            <div className="min-w-0 lg:col-span-7">
              <Tabs
                value={quickstartTab}
                onValueChange={handleQuickstartTabChange}
                variant="segment"
                className="overflow-hidden rounded-2xl border border-border-strong bg-card shadow-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <Terminal
                      aria-hidden="true"
                      className="size-4 text-muted-foreground"
                    />
                    <TabsList wrapperClassName="w-auto shrink-0">
                      <TabsTrigger value="docker">
                        {home.quickstart.tabs.docker.label}
                      </TabsTrigger>
                      <TabsTrigger value="local">
                        {home.quickstart.tabs.local.label}
                      </TabsTrigger>
                    </TabsList>
                  </div>

                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => handleCopyCommand(activeQuickstart.command)}
                    aria-live="polite"
                    className={cn(
                      copyState === "error" &&
                        "border-rose-500/40 text-rose-700 dark:text-rose-400",
                    )}
                  >
                    {copyState === "copied" ? (
                      <>
                        <Check
                          aria-hidden="true"
                          className="size-3.5 text-emerald-600 dark:text-emerald-400"
                        />
                        {home.quickstart.copied}
                      </>
                    ) : copyState === "error" ? (
                      <>
                        <AlertCircle aria-hidden="true" className="size-3.5" />
                        {home.quickstart.copyFailed}
                      </>
                    ) : (
                      <>
                        <Copy aria-hidden="true" className="size-3.5" />
                        {home.quickstart.copy}
                      </>
                    )}
                  </Button>
                </div>

                {(["docker", "local"] as const).map((tabKey) => (
                  <TabsContent
                    key={tabKey}
                    value={tabKey}
                    className="mt-0 bg-background p-4 sm:p-5"
                  >
                    <pre className="overflow-x-auto font-mono text-xs leading-6 text-foreground sm:text-[13px]">
                      <code>{home.quickstart.tabs[tabKey].command}</code>
                    </pre>
                    <p className="mt-4 border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
                      {home.quickstart.tabs[tabKey].note}
                    </p>
                  </TabsContent>
                ))}
              </Tabs>
            </div>
          </div>
        </ScrollReveal>
      </section>

      {/* Section H — FAQ */}
      <section className="py-16 sm:py-24">
        <ScrollReveal blur={0} y={12} duration={0.4} amount="some" once>
          <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
            <div className="max-w-2xl">
              <h2 className="text-balance text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                {home.faq.title}
              </h2>
              <p className="mt-3 text-pretty text-sm leading-relaxed text-muted-foreground sm:text-base">
                {home.faq.description}
              </p>
            </div>

            <BouncyAccordion
              items={faqItems}
              defaultValue={faqItems[0]?.id ?? null}
              className="mt-8"
              classNames={{
                trigger: "py-3.5",
                title:
                  "whitespace-normal overflow-visible text-clip leading-snug",
              }}
            />
          </div>
        </ScrollReveal>
      </section>

      {/* Section I — Closing CTA Banner */}
      <section className="py-16 sm:py-20">
        <ScrollReveal blur={0} y={12} duration={0.4} amount="some" once>
          <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
            <div className="relative overflow-hidden rounded-2xl border border-border-strong bg-card p-8 sm:p-12">
              <div
                aria-hidden="true"
                className="grid-noise pointer-events-none absolute inset-0 opacity-55 [mask-image:radial-gradient(ellipse_75%_80%_at_80%_20%,#000_20%,transparent_100%)]"
              />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -right-24 -top-24 size-80 rounded-full bg-[radial-gradient(circle,color-mix(in_oklch,var(--primary)_18%,transparent),transparent_70%)]"
              />

              <div className="relative flex flex-col items-start justify-between gap-8 lg:flex-row lg:items-center">
                <div className="max-w-lg">
                  <h2 className="text-balance text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                    {home.cta.title}
                  </h2>
                  <p className="mt-3 text-pretty text-sm leading-relaxed text-muted-foreground sm:text-base">
                    {home.cta.description}
                  </p>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-3">
                  <ButtonLink
                    href="/app"
                    size="md"
                    className="whitespace-nowrap"
                  >
                    {home.cta.primaryCta}
                    <ArrowRight aria-hidden="true" className="size-4" />
                  </ButtonLink>
                  <ButtonLink
                    href={navigation.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    variant="secondary"
                    size="md"
                    className="whitespace-nowrap"
                  >
                    <BookOpen aria-hidden="true" className="size-4" />
                    {home.cta.docsCta}
                  </ButtonLink>
                  <ButtonLink
                    href={SITE.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    variant="ghost"
                    size="md"
                    className="whitespace-nowrap"
                  >
                    <GithubIcon aria-hidden="true" className="size-4" />
                    {home.cta.githubCta}
                  </ButtonLink>
                </div>
              </div>
            </div>
          </div>
        </ScrollReveal>
      </section>
    </div>
  );
}
