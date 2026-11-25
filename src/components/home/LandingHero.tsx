"use client";

import {
  Activity,
  ArrowRight,
  Box,
  Cpu,
  FileCode2,
  FolderTree,
  Globe,
  Lock,
  Network,
  Server,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useMemo, useState } from "react";
import {
  type AgentTraceRun,
  TraceWaterfall,
  type TraceWaterfallLabels,
} from "@/components/agents/agent-traces";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { ButtonLink } from "@/components/motion/button";
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@/components/motion/file-tree";
import {
  ConnectedHub,
  type ConnectedHubNode,
} from "@/components/motion/illustration-connected-hub";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/motion/tabs";
import { EASE_OUT } from "@/lib/ease";
import type { MarketingContent } from "@/lib/marketing/content";
import { cn } from "@/lib/utils";

type HeroTab = "trace" | "sandbox" | "gateway";

interface LandingHeroProps {
  home: MarketingContent["home"];
  locale: string;
}

const ROUTE_ICONS: Record<string, typeof Server> = {
  "managed-mcp": Server,
  "docker-remote": Globe,
  "device-bridge": Cpu,
};

function BrandHubMark() {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="currentColor"
      aria-hidden="true"
      className="size-7 text-primary"
    >
      <path d="M12 14h30v9H31v27H21V23h-9z" />
      <path d="m34 27 20 9-20 9 4-7H29v-4h9z" />
    </svg>
  );
}

export function LandingHero({ home, locale }: LandingHeroProps) {
  const reduce = useReducedMotion();
  const isZh = locale.toLowerCase().startsWith("zh");
  const { heroPreview } = home;
  const [activeTab, setActiveTab] = useState<HeroTab>("trace");
  const [selectedNodeId, setSelectedNodeId] = useState<string>("revision-lock");
  const [selectedRouteId, setSelectedRouteId] = useState<string>(
    heroPreview.gatewayRoutes[0]?.id ?? "managed-mcp",
  );

  const traceRun = useMemo<AgentTraceRun>(
    () => ({
      id: heroPreview.traceRun.id,
      name: heroPreview.traceRun.name,
      status: "completed",
      startedAt: heroPreview.traceRun.startedAt,
      durationMs: heroPreview.traceRun.durationMs,
      spans: heroPreview.traceRun.spans,
    }),
    [heroPreview.traceRun],
  );

  const traceLabels = useMemo<Partial<TraceWaterfallLabels>>(() => {
    const l = heroPreview.traceLabels;
    return {
      trace: (name) => `${name} ${l.traceSuffix}`,
      status: {
        completed: l.statusCompleted,
        failed: l.statusFailed,
        running: l.statusRunning,
        cancelled: l.statusCancelled,
      },
      duration: l.duration,
      spans: l.spans,
      tokens: l.tokens,
      cost: l.cost,
      showKinds: l.showKinds,
      kinds: {
        agent: l.kindAgent,
        model: l.kindModel,
        llm: l.kindModel,
        tool: l.kindTool,
        guardrail: l.kindGuardrail,
      },
      span: l.span,
      expand: (name) => `${l.expandPrefix} ${name}`,
      collapse: (name) => `${l.collapsePrefix} ${name}`,
      expandAll: l.expandAll,
      collapseAll: l.collapseAll,
      search: l.search,
      clearSearch: l.clearSearch,
      errorsOnly: l.errorsOnly,
      zoomIn: l.zoomIn,
      zoomOut: l.zoomOut,
      zoomReset: l.zoomReset,
      previousSpan: l.previousSpan,
      nextSpan: l.nextSpan,
      shareOfTotal: l.shareOfTotal,
      copy: l.copy,
      copied: l.copied,
      expandText: l.expandText,
      collapseText: l.collapseText,
      noSpans: l.noSpans,
      noMatches: l.noMatches,
      resetFilters: l.resetFilters,
      clearSelection: l.clearSelection,
      timing: l.timing,
      start: l.start,
      end: l.end,
      model: l.model,
      inputTokens: l.inputTokens,
      outputTokens: l.outputTokens,
      input: l.input,
      output: l.output,
      notRecorded: l.notRecorded,
      attributes: l.attributes,
      startedAt: (value) =>
        new Date(value).toLocaleString(isZh ? "zh-CN" : "en-US", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
          timeZone: "UTC",
        }),
    };
  }, [heroPreview.traceLabels, isZh]);

  const resolvedSandboxNodeId =
    selectedNodeId === "code-review-dir"
      ? "plugins"
      : selectedNodeId === "sess-01-dir"
        ? "conv-01"
        : selectedNodeId === "sess-02-dir"
          ? "conv-02"
          : selectedNodeId;

  const activeSandboxNode =
    heroPreview.sandboxNodes[resolvedSandboxNodeId] ??
    heroPreview.sandboxNodes["revision-lock"];

  const hubNodes = useMemo<ConnectedHubNode[]>(
    () =>
      heroPreview.gatewayRoutes.map((route) => {
        const Icon = ROUTE_ICONS[route.id] ?? Server;
        return {
          id: route.id,
          label: route.label,
          description: route.description,
          icon: <Icon aria-hidden="true" className="size-6" />,
          branch: route.id === "device-bridge" ? "api" : "mcp",
        };
      }),
    [heroPreview.gatewayRoutes],
  );

  const activeRoute =
    heroPreview.gatewayRoutes.find((r) => r.id === selectedRouteId) ??
    heroPreview.gatewayRoutes[0];

  const enterInitial = reduce ? { opacity: 1 } : { opacity: 0, y: 14 };
  const enterAnimate = { opacity: 1, y: 0 };

  return (
    <section className="relative overflow-hidden border-b border-border">
      {/* Subtle architectural grid & soft radial highlight */}
      <div
        aria-hidden="true"
        className="grid-noise pointer-events-none absolute inset-0 opacity-75 [mask-image:radial-gradient(ellipse_85%_70%_at_50%_0%,#000_35%,transparent_100%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(ellipse_65%_55%_at_50%_-15%,color-mix(in_oklch,var(--primary)_14%,transparent),transparent_72%)]"
      />

      <div className="relative mx-auto max-w-6xl px-4 pb-16 pt-10 sm:px-6 sm:pb-20 sm:pt-14 lg:px-8 lg:pt-16">
        {/* Editorial hero copy */}
        <motion.div
          initial={enterInitial}
          animate={enterAnimate}
          transition={{ duration: 0.55, ease: EASE_OUT }}
          className="max-w-4xl"
        >
          <div className="inline-flex items-center gap-2 rounded-full border border-border-strong bg-card/85 px-3.5 py-1 text-xs font-medium text-muted-foreground backdrop-blur-sm">
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-primary"
            />
            <span>{home.eyebrow}</span>
          </div>

          <h1
            className={cn(
              "mt-5 text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-5xl lg:text-[3.4rem]",
              isZh ? "sm:leading-[1.2] lg:leading-[1.22]" : "lg:leading-[1.08]",
            )}
          >
            {home.headline}
          </h1>

          <p className="mt-5 max-w-2xl text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
            {home.description}
          </p>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <ButtonLink href="/app" size="md">
              {home.primaryCta}
              <ArrowRight aria-hidden="true" className="size-4" />
            </ButtonLink>
            <ButtonLink href="#quickstart" variant="secondary" size="md">
              <Terminal aria-hidden="true" className="size-4" />
              {home.secondaryCta}
            </ButtonLink>
          </div>
        </motion.div>

        {/* Elevated interactive Control Plane window */}
        <motion.div
          initial={reduce ? { opacity: 1 } : { opacity: 0, y: 18 }}
          animate={enterAnimate}
          transition={{
            duration: 0.6,
            delay: reduce ? 0 : 0.08,
            ease: EASE_OUT,
          }}
          className="mt-10 sm:mt-12"
        >
          <Tabs
            value={activeTab}
            onValueChange={(next) => setActiveTab(next as HeroTab)}
            variant="segment"
            className="overflow-hidden rounded-2xl border border-border-strong bg-card shadow-sm"
          >
            {/* Window chrome header */}
            <div className="flex flex-col gap-3 border-b border-border bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div className="flex min-w-0 items-center gap-3">
                <div
                  aria-hidden="true"
                  className="hidden items-center gap-1.5 sm:flex"
                >
                  <span className="size-2.5 rounded-full bg-border-strong" />
                  <span className="size-2.5 rounded-full bg-border-strong" />
                  <span className="size-2.5 rounded-full bg-border-strong" />
                </div>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {heroPreview.workspacePath}
                </span>
                <AnimatedBadge status="success" size="sm" className="shrink-0">
                  {heroPreview.statusBadge}
                </AnimatedBadge>
              </div>

              <TabsList wrapperClassName="w-full sm:w-auto sm:shrink-0">
                <TabsTrigger value="trace" className="gap-1.5">
                  <Activity aria-hidden="true" className="size-3.5" />
                  {heroPreview.tabs.trace}
                </TabsTrigger>
                <TabsTrigger value="sandbox" className="gap-1.5">
                  <FolderTree aria-hidden="true" className="size-3.5" />
                  {heroPreview.tabs.sandbox}
                </TabsTrigger>
                <TabsTrigger value="gateway" className="gap-1.5">
                  <Network aria-hidden="true" className="size-3.5" />
                  {heroPreview.tabs.gateway}
                </TabsTrigger>
              </TabsList>
            </div>

            {/* Tab 1: Trace Waterfall (detail drawer remains collapsed initially so <xl viewports stay roomy) */}
            <TabsContent value="trace" className="mt-0 bg-background">
              <TraceWaterfall
                run={traceRun}
                labels={traceLabels}
                className="max-w-none rounded-none border-0"
              />
            </TabsContent>

            {/* Tab 2: Persistent Sandbox FileTree + Inspector */}
            <TabsContent
              value="sandbox"
              className="mt-0 bg-background p-4 sm:p-6"
            >
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
                <div className="rounded-xl border border-border bg-card/60 p-3 sm:p-4">
                  <FileTree
                    value={selectedNodeId}
                    onValueChange={setSelectedNodeId}
                    defaultExpandedIds={[
                      ".toolplane",
                      "plugins",
                      "code-review-dir",
                      "sessions",
                      "sess-01-dir",
                      "sess-02-dir",
                    ]}
                    ariaLabel={heroPreview.sandboxTreeLabel}
                  >
                    <FileTreeFolder value=".toolplane" name=".toolplane">
                      <FileTreeFile
                        value="revision-lock"
                        name="revision-v4.lock"
                        icon={
                          <Lock
                            aria-hidden="true"
                            className="size-4 text-primary"
                          />
                        }
                      />
                    </FileTreeFolder>
                    <FileTreeFolder value="plugins" name="plugins">
                      <FileTreeFolder
                        value="code-review-dir"
                        name="code-review@7d4e2a1"
                      >
                        <FileTreeFile value="skill-md" name="SKILL.md" />
                        <FileTreeFile value="plugin-pkg" name="package.json" />
                      </FileTreeFolder>
                    </FileTreeFolder>
                    <FileTreeFolder value="sessions" name="sessions">
                      <FileTreeFolder
                        value="sess-01-dir"
                        name="conv-01/workspace"
                      >
                        <FileTreeFile
                          value="conv-01"
                          name="patch.diff"
                          icon={
                            <FileCode2
                              aria-hidden="true"
                              className="size-4 text-sky-600 dark:text-sky-400"
                            />
                          }
                        />
                      </FileTreeFolder>
                      <FileTreeFolder
                        value="sess-02-dir"
                        name="conv-02/workspace"
                      >
                        <FileTreeFile value="conv-02" name="notes.md" />
                      </FileTreeFolder>
                    </FileTreeFolder>
                  </FileTree>
                </div>

                {activeSandboxNode && (
                  <div className="flex flex-col justify-between rounded-xl border border-border bg-card/60 p-4 sm:p-5">
                    <div>
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <Box
                            aria-hidden="true"
                            className="size-4 shrink-0 text-primary"
                          />
                          <span className="truncate font-mono text-xs font-medium text-foreground sm:text-sm">
                            {activeSandboxNode.path}
                          </span>
                        </div>
                        <span className="inline-flex items-center rounded-full border border-border-strong bg-background px-2.5 py-0.5 text-xs font-medium text-foreground">
                          {activeSandboxNode.scopeLabel}
                        </span>
                      </div>

                      <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                        {activeSandboxNode.summary}
                      </p>

                      <pre className="mt-4 overflow-x-auto rounded-lg border border-border bg-background p-3.5 font-mono text-xs leading-6 text-foreground">
                        <code>{activeSandboxNode.snippet}</code>
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            </TabsContent>

            {/* Tab 3: Unified MCP & API Gateway */}
            <TabsContent
              value="gateway"
              className="mt-0 bg-background p-4 sm:p-6"
            >
              <div className="grid grid-cols-1 items-center gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
                <ConnectedHub
                  variant={4}
                  hubLabel={heroPreview.gatewayHubLabel}
                  hubIcon={<BrandHubMark />}
                  label={heroPreview.gatewayAriaLabel}
                  nodes={hubNodes}
                  value={selectedRouteId}
                  onValueChange={setSelectedRouteId}
                  className="mx-auto max-w-none border border-border"
                />

                <div className="flex flex-col gap-3">
                  {heroPreview.gatewayRoutes.map((route) => {
                    const isSelected = route.id === activeRoute?.id;
                    const Icon = ROUTE_ICONS[route.id] ?? Server;
                    return (
                      <button
                        key={route.id}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => setSelectedRouteId(route.id)}
                        className={cn(
                          "w-full rounded-xl border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                          isSelected
                            ? "border-primary/50 bg-card shadow-xs"
                            : "border-border bg-card/40 hover:border-border-strong hover:bg-card/80",
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2.5">
                            <span
                              className={cn(
                                "grid size-8 shrink-0 place-items-center rounded-lg border",
                                isSelected
                                  ? "border-primary/30 bg-primary/10 text-primary"
                                  : "border-border bg-background text-muted-foreground",
                              )}
                            >
                              <Icon aria-hidden="true" className="size-4" />
                            </span>
                            <div>
                              <div className="text-sm font-medium text-foreground">
                                {route.label}
                              </div>
                              <div className="font-mono text-[11px] text-muted-foreground">
                                {route.transport}
                              </div>
                            </div>
                          </div>
                          {isSelected && (
                            <ShieldCheck
                              aria-hidden="true"
                              className="size-4 shrink-0 text-primary"
                            />
                          )}
                        </div>
                        <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
                          {route.description}
                        </p>
                        <dl className="mt-3 grid grid-cols-1 gap-1.5 border-t border-border pt-2.5 text-[11px] sm:grid-cols-2">
                          <div>
                            <dt className="text-muted-foreground">
                              {heroPreview.gatewayAuthLabel}
                            </dt>
                            <dd className="font-medium text-foreground">
                              {route.auth}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">
                              {heroPreview.gatewayPolicyLabel}
                            </dt>
                            <dd className="font-medium text-foreground">
                              {route.policy}
                            </dd>
                          </div>
                        </dl>
                      </button>
                    );
                  })}
                </div>
              </div>
            </TabsContent>

            {/* Honest illustrative caption footer */}
            <div className="flex items-center gap-2 border-t border-border bg-card/80 px-4 py-2.5 text-[11px] text-muted-foreground sm:px-5">
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full bg-muted-foreground/60"
              />
              <span>{heroPreview.illustrativeNote}</span>
            </div>
          </Tabs>
        </motion.div>
      </div>
    </section>
  );
}
