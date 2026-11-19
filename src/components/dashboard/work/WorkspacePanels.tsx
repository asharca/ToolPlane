"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Boxes, Folder, Monitor, TerminalSquare } from "lucide-react";
import { Button } from "@/components/motion/button";
import {
  CenterMorphModal,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import { DialogHeader } from "@/components/dashboard/dialog";
import { SandboxConsole } from "@/components/dashboard/sandboxes/SandboxConsole";
import {
  SandboxScreen,
  type SandboxDisplay,
} from "@/components/dashboard/sandboxes/SandboxScreen";
import { apiRequest } from "@/lib/client/api";
import type { WorkItem, WorkPanel } from "./work-types";

const EMPTY_SANDBOX_DISPLAYS: SandboxDisplay[] = [];
const DESKTOP_PANEL_QUERY = "(min-width: 1280px)";

type ControlSandbox = WorkItem["sandbox"];

export type WorkspacePanelsState = {
  desktopPanel: WorkPanel | null;
  mobilePanel: WorkPanel | null;
  closeMobilePanel: () => void;
  displays: SandboxDisplay[];
  hasScreen: boolean;
  /** Increments ask the open screen to take control; 0 only shows it. */
  controlRequest: number;
  screenReleaseRequest: number;
  openScreen: () => void;
  openTakeoverScreen: (requestId: string) => void;
  releaseScreenControl: () => void;
  togglePanel: (panel: WorkPanel) => void;
};

/**
 * Which workspace panel (files, terminal, screen) is open, and the screen's
 * displays. Screen control requests are scoped to the composer identity, so a
 * request from one conversation never opens control in another.
 */
export function useWorkspacePanels({
  slug,
  controlSandbox,
  composerScope,
}: {
  slug: string;
  controlSandbox: ControlSandbox;
  composerScope: string;
}): WorkspacePanelsState {
  const [desktopPanel, setDesktopPanel] = useState<WorkPanel | null>(null);
  const [mobilePanel, setMobilePanel] = useState<WorkPanel | null>(null);
  const [screenDisplays, setScreenDisplays] = useState<{
    key: string;
    displays: SandboxDisplay[];
  }>({ key: "", displays: EMPTY_SANDBOX_DISPLAYS });
  const [screenControlRequest, setScreenControlRequest] = useState({
    scope: "",
    value: 0,
  });
  const [screenReleaseRequest, setScreenReleaseRequest] = useState(0);
  const seenTakeoverRequests = useRef(new Set<string>());
  const screenSandboxId = controlSandbox?.id;
  const screenRunning = controlSandbox?.running === true;
  const screenKey = `${slug}:${screenSandboxId}`;
  const displays =
    screenRunning && screenDisplays.key === screenKey
      ? screenDisplays.displays
      : EMPTY_SANDBOX_DISPLAYS;
  const hasScreen = displays.length > 0;
  const controlRequest =
    screenControlRequest.scope === composerScope
      ? screenControlRequest.value
      : 0;

  useEffect(() => {
    if (!screenSandboxId || !screenRunning) {
      setScreenDisplays({ key: screenKey, displays: EMPTY_SANDBOX_DISPLAYS });
      return;
    }
    const controller = new AbortController();
    void apiRequest<{ displays?: unknown }>(
      `/api/v1/workspaces/${encodeURIComponent(slug)}/sandboxes/${encodeURIComponent(screenSandboxId)}/screen`,
      { cache: "no-store", signal: controller.signal },
    ).then((result) => {
      if (controller.signal.aborted) return;
      setScreenDisplays({
        key: screenKey,
        displays:
          result.ok && Array.isArray(result.data?.displays)
            ? (result.data.displays as SandboxDisplay[])
            : EMPTY_SANDBOX_DISPLAYS,
      });
    });
    return () => controller.abort();
  }, [screenSandboxId, screenRunning, screenKey, slug]);

  const openScreen = useCallback(() => {
    if (!hasScreen) return;
    if (window.matchMedia(DESKTOP_PANEL_QUERY).matches) {
      setMobilePanel(null);
      setDesktopPanel("screen");
    } else {
      setDesktopPanel(null);
      setMobilePanel("screen");
    }
    setScreenControlRequest((current) => ({
      scope: composerScope,
      value: current.scope === composerScope ? current.value + 1 : 1,
    }));
  }, [hasScreen, composerScope]);

  const openTakeoverScreen = useCallback(
    (id: string) => {
      if (!hasScreen || !window.matchMedia(DESKTOP_PANEL_QUERY).matches) return;
      const key = `${composerScope}:${id}`;
      if (seenTakeoverRequests.current.has(key)) return;
      seenTakeoverRequests.current.add(key);
      setScreenControlRequest({ scope: composerScope, value: 0 });
      setMobilePanel(null);
      setDesktopPanel("screen");
    },
    [hasScreen, composerScope],
  );
  const releaseScreenControl = useCallback(
    () => setScreenReleaseRequest((current) => current + 1),
    [],
  );

  function togglePanel(panel: WorkPanel) {
    if (panel === "screen") {
      setScreenControlRequest({ scope: composerScope, value: 0 });
    }
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia(DESKTOP_PANEL_QUERY).matches
    ) {
      if (panel === "screen") setMobilePanel(null);
      setDesktopPanel((current) => (current === panel ? null : panel));
      return;
    }
    if (panel === "screen") setDesktopPanel(null);
    setMobilePanel(panel);
  }

  return {
    desktopPanel,
    mobilePanel,
    closeMobilePanel: () => setMobilePanel(null),
    displays,
    hasScreen,
    controlRequest,
    screenReleaseRequest,
    openScreen,
    openTakeoverScreen,
    releaseScreenControl,
    togglePanel,
  };
}

/** Header buttons that open the conversation's workspace panels. */
export function WorkspacePanelToggles({
  panels,
  readOnly,
}: {
  panels: WorkspacePanelsState;
  readOnly: boolean;
}) {
  const tSandboxes = useTranslations("console.sandboxes");
  return (
    <>
      <Button
        type="button"
        onClick={() => panels.togglePanel("files")}
        aria-label={tSandboxes("files")}
        title={tSandboxes("files")}
        aria-pressed={panels.desktopPanel === "files"}
        variant="ghost"
        size="icon"
      >
        <Folder className="size-4" />
      </Button>
      <Button
        type="button"
        disabled={readOnly}
        onClick={() => panels.togglePanel("terminal")}
        aria-label={tSandboxes("terminal")}
        title={tSandboxes("terminal")}
        aria-pressed={panels.desktopPanel === "terminal"}
        variant="ghost"
        size="icon"
      >
        <TerminalSquare className="size-4" />
      </Button>
      {panels.hasScreen ? (
        <Button
          type="button"
          onClick={() => panels.togglePanel("screen")}
          aria-label={tSandboxes("screen")}
          title={tSandboxes("screen")}
          aria-pressed={
            panels.desktopPanel === "screen" || panels.mobilePanel === "screen"
          }
          variant="ghost"
          size="icon"
        >
          <Monitor className="size-4" />
        </Button>
      ) : null}
    </>
  );
}

type PanelWorkspace = {
  slug: string;
  /** Conversation or Work session that owns the workspace directory. */
  sessionKey: string;
  sandbox: ControlSandbox;
  pending: boolean;
  readOnly: boolean;
  initialPath: string;
  rpcApiBase?: string;
  terminalApiBase?: string;
  unavailableLabel: string;
};

function PanelBody({
  panel,
  panels,
  workspace,
}: {
  panel: WorkPanel;
  panels: WorkspacePanelsState;
  workspace: PanelWorkspace;
}) {
  const t = useTranslations("console.work");
  const { sandbox } = workspace;
  if (panel === "screen" && sandbox && panels.hasScreen)
    return (
      <SandboxScreen
        key={sandbox.id}
        workspace={workspace.slug}
        sandboxId={sandbox.id}
        displays={panels.displays}
        running={sandbox.running}
        controlRequest={panels.controlRequest}
        releaseRequest={panels.screenReleaseRequest}
      />
    );
  if (sandbox && !workspace.pending)
    return (
      <SandboxConsole
        key={`${workspace.sessionKey}:${sandbox.id}`}
        compact
        filesOnly={panel === "files"}
        readOnly={workspace.readOnly}
        terminalOnly={panel === "terminal"}
        deploymentId={sandbox.deploymentId}
        running={sandbox.running}
        initialPath={workspace.initialPath}
        initialEntries={[]}
        terminalLabel={sandbox.name}
        terminalSubtitle={t("sandboxSubtitle")}
        workspaceRoot="/workspace"
        rpcApiBase={workspace.rpcApiBase}
        terminalApiBase={workspace.terminalApiBase}
      />
    );
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      <Boxes className="mr-2 size-4" />
      {workspace.unavailableLabel}
    </div>
  );
}

/** The open panel: a side column on wide screens, a dialog otherwise. */
export function WorkspacePanels({
  panels,
  workspace,
  hidden,
}: {
  panels: WorkspacePanelsState;
  workspace: PanelWorkspace;
  hidden: boolean;
}) {
  const t = useTranslations("console.work");
  const tSandboxes = useTranslations("console.sandboxes");
  const { desktopPanel, mobilePanel } = panels;
  const desktopOpen =
    !hidden &&
    desktopPanel !== null &&
    (desktopPanel !== "screen" || panels.hasScreen);
  const mobileOpen =
    !hidden &&
    mobilePanel !== null &&
    (mobilePanel !== "screen" || panels.hasScreen);
  const mobileTitle =
    mobilePanel === "files"
      ? tSandboxes("files")
      : mobilePanel === "screen"
        ? tSandboxes("screen")
        : tSandboxes("terminal");
  return (
    <>
      {desktopOpen ? (
        <aside className="hidden w-96 shrink-0 min-h-0 overflow-hidden bg-background xl:block">
          <PanelBody
            panel={desktopPanel}
            panels={panels}
            workspace={workspace}
          />
        </aside>
      ) : null}
      {mobileOpen ? (
        <CenterMorphModal
          open
          onOpenChange={(open) => {
            if (!open) panels.closeMobilePanel();
          }}
        >
          <CenterMorphModalContent
            ariaLabel={mobileTitle}
            closeButtonLabel={t("closeWorkspace")}
            className="flex h-[calc(100dvh-2rem)] w-full max-w-5xl flex-col"
          >
            <DialogHeader
              title={mobileTitle}
              icon={
                mobilePanel === "files" ? (
                  <Folder className="size-4" />
                ) : mobilePanel === "screen" ? (
                  <Monitor className="size-4" />
                ) : (
                  <TerminalSquare className="size-4" />
                )
              }
            />
            <div className="min-h-0 flex-1 overflow-hidden">
              <PanelBody
                panel={mobilePanel}
                panels={panels}
                workspace={workspace}
              />
            </div>
          </CenterMorphModalContent>
        </CenterMorphModal>
      ) : null}
    </>
  );
}
