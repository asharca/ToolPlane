"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslations } from "next-intl";
import {
  Boxes,
  Folder,
  Maximize2,
  Minimize2,
  Monitor,
  TerminalSquare,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
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
  const activeButtonClass = (active: boolean) =>
    cn(
      "size-7 rounded-md transition-colors",
      active
        ? "bg-background text-foreground shadow-xs hover:bg-background"
        : "text-muted-foreground hover:text-foreground",
    );
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted/60 p-0.5">
      <Button
        type="button"
        onClick={() => panels.togglePanel("files")}
        aria-label={tSandboxes("files")}
        title={tSandboxes("files")}
        aria-pressed={panels.desktopPanel === "files"}
        variant="ghost"
        size="icon"
        className={activeButtonClass(panels.desktopPanel === "files")}
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
        className={activeButtonClass(panels.desktopPanel === "terminal")}
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
          className={activeButtonClass(
            panels.desktopPanel === "screen" || panels.mobilePanel === "screen",
          )}
        >
          <Monitor className="size-4" />
        </Button>
      ) : null}
    </div>
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

const PANEL_WIDTH_STORAGE_KEY = "toolplane:work-panel-width";
const DEFAULT_PANEL_WIDTH = 440;
const EXPANDED_PANEL_WIDTH = 640;
const MIN_PANEL_WIDTH = 340;
const MAX_PANEL_WIDTH = 760;

function clampPanelWidth(width: number): number {
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width));
}

function savePanelWidth(width: number) {
  try {
    localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(width));
  } catch {
    /* Ignore restricted browser storage. */
  }
}

/** The open panel: a resizable side column on wide screens, a dialog otherwise. */
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
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const widthRef = useRef(DEFAULT_PANEL_WIDTH);
  widthRef.current = panelWidth;

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY));
      if (Number.isFinite(saved) && saved > 0) {
        setPanelWidth(clampPanelWidth(saved));
      }
    } catch {
      /* Ignore restricted browser storage. */
    }
  }, []);

  const startResize = useCallback((event: ReactPointerEvent<HTMLHRElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = widthRef.current;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (moveEvent: PointerEvent) => {
      const nextWidth = clampPanelWidth(
        startWidth + (startX - moveEvent.clientX),
      );
      setPanelWidth(nextWidth);
    };
    const stop = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      savePanelWidth(widthRef.current);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }, []);

  const updateAndSaveWidth = useCallback((nextWidth: number) => {
    const clamped = clampPanelWidth(nextWidth);
    setPanelWidth(clamped);
    savePanelWidth(clamped);
  }, []);

  const selectDesktopTab = (tab: WorkPanel) => {
    if (desktopPanel !== tab) panels.togglePanel(tab);
  };

  return (
    <>
      {desktopOpen ? (
        <aside
          style={{ width: `${panelWidth}px` }}
          className="relative hidden shrink-0 min-h-0 flex-col overflow-hidden border-l border-border bg-background xl:flex"
        >
          <hr
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={t("resizeInspector")}
            aria-valuenow={panelWidth}
            aria-valuemin={MIN_PANEL_WIDTH}
            aria-valuemax={MAX_PANEL_WIDTH}
            title={t("resizeInspector")}
            onPointerDown={startResize}
            onDoubleClick={() => updateAndSaveWidth(DEFAULT_PANEL_WIDTH)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                updateAndSaveWidth(panelWidth + 24);
              } else if (event.key === "ArrowRight") {
                event.preventDefault();
                updateAndSaveWidth(panelWidth - 24);
              } else if (event.key === "Home") {
                event.preventDefault();
                updateAndSaveWidth(DEFAULT_PANEL_WIDTH);
              }
            }}
            className="absolute inset-y-0 left-0 z-20 m-0 h-full w-1.5 cursor-col-resize border-0 bg-transparent transition-colors hover:bg-primary/40 focus-visible:bg-primary/50 focus-visible:outline-none"
          />
          <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/25 px-2.5">
            <div
              role="tablist"
              aria-label={t("workspace")}
              className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-background/80 p-0.5"
            >
              <Button
                type="button"
                role="tab"
                aria-selected={desktopPanel === "files"}
                variant="ghost"
                size="sm"
                onClick={() => selectDesktopTab("files")}
                className={cn(
                  "h-7 gap-1.5 rounded-md px-2 text-xs",
                  desktopPanel === "files"
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Folder className="size-3.5" />
                <span>{tSandboxes("files")}</span>
              </Button>
              <Button
                type="button"
                role="tab"
                aria-selected={desktopPanel === "terminal"}
                variant="ghost"
                size="sm"
                disabled={workspace.readOnly}
                onClick={() => selectDesktopTab("terminal")}
                className={cn(
                  "h-7 gap-1.5 rounded-md px-2 text-xs",
                  desktopPanel === "terminal"
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <TerminalSquare className="size-3.5" />
                <span>{tSandboxes("terminal")}</span>
              </Button>
              {panels.hasScreen ? (
                <Button
                  type="button"
                  role="tab"
                  aria-selected={desktopPanel === "screen"}
                  variant="ghost"
                  size="sm"
                  onClick={() => selectDesktopTab("screen")}
                  className={cn(
                    "h-7 gap-1.5 rounded-md px-2 text-xs",
                    desktopPanel === "screen"
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Monitor className="size-3.5" />
                  <span>{tSandboxes("screen")}</span>
                </Button>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={
                  panelWidth >= 600
                    ? t("compactInspector")
                    : t("expandInspector")
                }
                title={
                  panelWidth >= 600
                    ? t("compactInspector")
                    : t("expandInspector")
                }
                onClick={() =>
                  updateAndSaveWidth(
                    panelWidth >= 600
                      ? DEFAULT_PANEL_WIDTH
                      : EXPANDED_PANEL_WIDTH,
                  )
                }
                className="size-7 rounded-md text-muted-foreground hover:text-foreground"
              >
                {panelWidth >= 600 ? (
                  <Minimize2 className="size-3.5" />
                ) : (
                  <Maximize2 className="size-3.5" />
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("closeWorkspace")}
                title={t("closeWorkspace")}
                onClick={() => panels.togglePanel(desktopPanel)}
                className="size-7 rounded-md text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </Button>
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-hidden">
            <PanelBody
              panel={desktopPanel}
              panels={panels}
              workspace={workspace}
            />
          </div>
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
