'use client';

import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Keyboard, Loader2, Monitor, RefreshCw } from 'lucide-react';

const VIRTUAL_KEYBOARD_PAD = '_'.repeat(99);
const SPECIAL_KEYSYMS: Record<string, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
};

function characterKeysym(character: string): number {
  if (character === '\n' || character === '\r') return SPECIAL_KEYSYMS.Enter;
  if (character === '\t') return SPECIAL_KEYSYMS.Tab;
  const codepoint = character.codePointAt(0) ?? 0;
  return codepoint <= 0xff ? codepoint : 0x01000000 | codepoint;
}

export type SandboxDisplay = {
  id: string;
  label: string;
  transport: 'snapshot' | 'rfb';
  control: boolean;
  width?: number | null;
  height?: number | null;
};

type RfbSession = {
  viewerUrl?: string;
};

export function SandboxScreen({
  workspace,
  sandboxId,
  displays,
  running,
}: {
  workspace: string;
  sandboxId: string;
  displays: SandboxDisplay[];
  running: boolean;
}) {
  const t = useTranslations('console.sandboxes');
  const [displayId, setDisplayId] = useState(displays[0]?.id ?? '');
  const [visible, setVisible] = useState(true);
  const [frame, setFrame] = useState(0);
  const [frameStatus, setFrameStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [rfbStatus, setRfbStatus] = useState<'idle' | 'connecting' | 'connected' | 'credentials' | 'error'>('idle');
  const [viewOnly, setViewOnly] = useState(true);
  const [password, setPassword] = useState('');
  const [virtualKeyboardOpen, setVirtualKeyboardOpen] = useState(false);
  const rfbTarget = useRef<HTMLDivElement>(null);
  const rfbClient = useRef<import('@novnc/novnc').default | null>(null);
  const viewOnlyRef = useRef(viewOnly);
  const virtualKeyboard = useRef<HTMLTextAreaElement>(null);
  const virtualKeyboardValue = useRef(VIRTUAL_KEYBOARD_PAD);
  const display = displays.find((candidate) => candidate.id === displayId) ?? displays[0];
  const apiBase = useMemo(
    () => `/api/v1/workspaces/${encodeURIComponent(workspace)}/sandboxes/${encodeURIComponent(sandboxId)}/screen`,
    [sandboxId, workspace],
  );

  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  useEffect(() => {
    if (!display || display.transport === 'rfb' || !running || !visible) return;
    if (frameStatus === 'loading') return;
    const timer = window.setTimeout(() => {
      setFrameStatus('loading');
      setFrame(Date.now());
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [display, frameStatus, running, visible]);

  useEffect(() => {
    if (!display || display.transport !== 'rfb' || !running || !visible) return;
    const controller = new AbortController();
    let active = true;
    const statusTimer = window.setTimeout(() => active && setRfbStatus('connecting'), 0);
    void (async () => {
      try {
        const response = await fetch(`${apiBase}/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ displayId: display.id }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(String(response.status));
        const session = await response.json() as RfbSession;
        if (!session.viewerUrl || !rfbTarget.current) throw new Error('missing viewer URL');
        const { default: RFB } = await import('@novnc/novnc');
        if (!active || !rfbTarget.current) return;
        const client = new RFB(rfbTarget.current, session.viewerUrl);
        client.scaleViewport = true;
        client.viewOnly = viewOnlyRef.current;
        if (!client.viewOnly) client.focus();
        client.addEventListener('connect', () => active && setRfbStatus('connected'));
        client.addEventListener('disconnect', () => active && setRfbStatus('error'));
        client.addEventListener('credentialsrequired', () => active && setRfbStatus('credentials'));
        client.addEventListener('securityfailure', () => active && setRfbStatus('error'));
        rfbClient.current = client;
      } catch (error) {
        if (active && (error as { name?: string }).name !== 'AbortError') setRfbStatus('error');
      }
    })();
    return () => {
      active = false;
      window.clearTimeout(statusTimer);
      controller.abort();
      rfbClient.current?.disconnect();
      rfbClient.current = null;
    };
  }, [apiBase, display, running, visible]);

  useEffect(() => {
    viewOnlyRef.current = viewOnly;
    if (viewOnly) virtualKeyboard.current?.blur();
    if (!rfbClient.current) return;
    rfbClient.current.viewOnly = viewOnly;
    if (!viewOnly) rfbClient.current.focus();
  }, [viewOnly]);

  const resetVirtualKeyboard = () => {
    if (!virtualKeyboard.current) return;
    virtualKeyboard.current.value = VIRTUAL_KEYBOARD_PAD;
    virtualKeyboard.current.setSelectionRange(VIRTUAL_KEYBOARD_PAD.length, VIRTUAL_KEYBOARD_PAD.length);
    virtualKeyboardValue.current = VIRTUAL_KEYBOARD_PAD;
  };

  const handleVirtualKeyboardInput = (event: FormEvent<HTMLTextAreaElement>) => {
    const input = event.currentTarget;
    const next = input.value;
    const previous = virtualKeyboardValue.current;
    const nextLength = Math.max(input.selectionStart ?? next.length, next.length);
    let common = 0;
    while (common < Math.min(previous.length, nextLength) && previous[common] === next[common]) common += 1;
    const backspaces = [...previous.slice(common)].length;
    for (let index = 0; index < backspaces; index += 1) {
      rfbClient.current?.sendKey(SPECIAL_KEYSYMS.Backspace, 'Backspace');
    }
    for (const character of next.slice(common, nextLength)) {
      rfbClient.current?.sendKey(characterKeysym(character));
    }
    if (nextLength > VIRTUAL_KEYBOARD_PAD.length * 2 || nextLength < 1) {
      resetVirtualKeyboard();
    } else {
      virtualKeyboardValue.current = next;
    }
  };

  const handleVirtualKeyboardKey = (event: KeyboardEvent<HTMLTextAreaElement>, down: boolean) => {
    const keysym = SPECIAL_KEYSYMS[event.key];
    if (!keysym) return;
    event.preventDefault();
    rfbClient.current?.sendKey(keysym, event.code || undefined, down);
  };

  if (!display) return null;
  const snapshot = display.transport !== 'rfb';
  const frameUrl = `${apiBase}/frame?displayId=${encodeURIComponent(display.id)}&frame=${frame}`;

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[#111419]">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-zinc-100">
          <Monitor className="size-4 shrink-0 text-zinc-400" />
          <span className="truncate">{display.label}</span>
          {display.width && display.height ? (
            <span className="font-mono text-xs font-normal text-zinc-500">{display.width}×{display.height}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {displays.length > 1 ? (
            <label className="sr-only" htmlFor="sandbox-display">{t('selectDisplay')}</label>
          ) : null}
          {displays.length > 1 ? (
            <select
              id="sandbox-display"
              value={display.id}
              onChange={(event) => {
                setDisplayId(event.target.value);
                setFrameStatus('loading');
                setRfbStatus('idle');
                setViewOnly(true);
                setPassword('');
              }}
              className="h-8 rounded-md border border-white/10 bg-zinc-900 px-2 text-xs text-zinc-200"
            >
              {displays.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
            </select>
          ) : null}
          {snapshot ? (
            <button
              type="button"
              onClick={() => { setFrameStatus('loading'); setFrame(Date.now()); }}
              disabled={!running || !visible}
              className="flex size-8 items-center justify-center rounded-md text-zinc-400 hover:bg-white/10 hover:text-zinc-100 disabled:opacity-40"
              title={t('refreshScreen')}
              aria-label={t('refreshScreen')}
            >
              <RefreshCw className="size-3.5" />
            </button>
          ) : display.control ? (
            <div className="flex items-center gap-2">
              {rfbStatus === 'connected' && !viewOnly ? (
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (virtualKeyboardOpen) virtualKeyboard.current?.blur();
                    else {
                      resetVirtualKeyboard();
                      virtualKeyboard.current?.focus();
                    }
                  }}
                  aria-label={t('virtualKeyboard')}
                  aria-pressed={virtualKeyboardOpen}
                  title={t('virtualKeyboard')}
                  className="flex size-8 items-center justify-center rounded-md text-zinc-400 hover:bg-white/10 hover:text-zinc-100 aria-pressed:bg-white/10 aria-pressed:text-white"
                >
                  <Keyboard className="size-4" />
                </button>
              ) : null}
              <label className="flex items-center gap-2 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={!viewOnly}
                  onChange={(event) => setViewOnly(!event.target.checked)}
                  className="size-4 accent-white"
                />
                {t('controlScreen')}
              </label>
            </div>
          ) : null}
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black p-2">
        {!running ? (
          <p className="text-sm text-zinc-400">{t('startTheSandboxToViewScreen')}</p>
        ) : !visible ? (
          <p className="text-sm text-zinc-400">{t('screenPaused')}</p>
        ) : snapshot ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- connector frames are live, authenticated snapshots. */}
            <img
              src={frameUrl}
              alt={t('screenImageAlt', { display: display.label })}
              onLoad={() => setFrameStatus('ready')}
              onError={() => setFrameStatus('error')}
              className="max-h-full max-w-full object-contain"
            />
            {frameStatus === 'loading' ? <Loader2 aria-label={t('loadingScreen')} className="absolute size-6 animate-spin text-zinc-400" /> : null}
            {frameStatus === 'error' ? <p role="alert" className="absolute rounded-md bg-black/80 px-3 py-2 text-sm text-zinc-300">{t('screenUnavailable')}</p> : null}
          </>
        ) : (
          <>
            <div
              ref={rfbTarget}
              data-testid="rfb-target"
              tabIndex={display.control && !viewOnly ? 0 : -1}
              aria-label={t('screenImageAlt', { display: display.label })}
              onMouseDownCapture={(event) => {
                if (virtualKeyboardOpen) event.preventDefault();
              }}
              onFocus={() => {
                if (!virtualKeyboardOpen) rfbClient.current?.focus();
              }}
              className="h-full w-full overflow-hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-white"
            />
            <textarea
              ref={virtualKeyboard}
              defaultValue={VIRTUAL_KEYBOARD_PAD}
              aria-label={t('virtualKeyboardInput')}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              tabIndex={-1}
              onInput={handleVirtualKeyboardInput}
              onKeyDown={(event) => handleVirtualKeyboardKey(event, true)}
              onKeyUp={(event) => handleVirtualKeyboardKey(event, false)}
              onFocus={() => {
                setVirtualKeyboardOpen(true);
                if (rfbClient.current) rfbClient.current.focusOnClick = false;
              }}
              onBlur={() => {
                resetVirtualKeyboard();
                setVirtualKeyboardOpen(false);
                if (rfbClient.current) rfbClient.current.focusOnClick = true;
              }}
              className="absolute -left-10 -z-10 h-px w-px resize-none border-0 bg-white text-white"
            />
            {rfbStatus === 'idle' || rfbStatus === 'connecting' ? (
              <Loader2 aria-label={t('loadingScreen')} className="absolute size-6 animate-spin text-zinc-400" />
            ) : null}
            {rfbStatus === 'credentials' ? (
              <form
                className="absolute flex max-w-sm items-end gap-2 rounded-md border border-white/10 bg-black/90 p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  rfbClient.current?.sendCredentials({ password });
                  setPassword('');
                  setRfbStatus('connecting');
                }}
              >
                <label className="grid gap-1 text-xs text-zinc-300">
                  {t('vncPassword')}
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="new-password"
                    className="h-8 rounded-md border border-white/15 bg-zinc-900 px-2 text-sm text-white"
                  />
                </label>
                <button type="submit" className="h-8 rounded-md bg-white px-3 text-xs font-medium text-black">
                  {t('connectScreen')}
                </button>
              </form>
            ) : null}
            {rfbStatus === 'error' ? (
              <p role="alert" className="absolute rounded-md bg-black/80 px-3 py-2 text-sm text-zinc-300">{t('screenUnavailable')}</p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
