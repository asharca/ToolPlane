"use client";

import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { motion, useReducedMotion } from "motion/react";
import { useTranslations } from "next-intl";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  type LucideIcon,
  Search,
} from "lucide-react";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { composerTrigger } from "@/lib/work/composer-types";
import { cn } from "@/lib/utils";

/** React and native keyboard events both satisfy this shape. */
export type ComposerMenuKeyEvent = Pick<
  KeyboardEvent<HTMLElement>,
  | "key"
  | "shiftKey"
  | "ctrlKey"
  | "metaKey"
  | "altKey"
  | "keyCode"
  | "preventDefault"
  | "stopPropagation"
> & {
  nativeEvent: { isComposing: boolean };
  currentTarget: EventTarget | null;
};

export type ComposerMenuItem = {
  id: string;
  label: string;
  description?: string;
  /** Right-aligned status text, e.g. an MCP server state. */
  hint?: string;
  icon: LucideIcon;
  group?: string;
  disabled?: boolean;
  pressed?: boolean;
  /** Opens another view inside the same menu. */
  drill?: boolean;
  /** Informational row: shown normally but not selectable. */
  readOnly?: boolean;
  data?: unknown;
};

export type ComposerMenuForm = {
  title: string;
  subtitle?: string;
  description?: string;
  fields: Array<{
    name: string;
    label: string;
    required?: boolean;
    placeholder?: string;
  }>;
  submitLabel: string;
  submit: (values: Record<string, string>) => Promise<void>;
};

export type ComposerMenuView = {
  title: string;
  load: (query: string, signal: AbortSignal) => Promise<ComposerMenuItem[]>;
  /** Send the search text to the server instead of filtering loaded items. */
  remoteQuery?: boolean;
  empty?: string;
};

/**
 * `{ view }` drills into another view, `{ form }` shows a form in place, `"keep"`
 * leaves the menu open; anything else closes it.
 */
export type ComposerMenuOutcome =
  | undefined
  | "keep"
  | { view: string; query?: string }
  | { form: ComposerMenuForm };

type Frame = {
  view: string;
  query: string;
  form?: ComposerMenuForm;
};
type Trigger = {
  symbol: "/" | "@";
  start: number;
  end: number;
  fromButton: boolean;
  /** Space the + button inserted before "/"; removed together with it. */
  pad: number;
};
type Loaded = {
  key: string;
  items: ComposerMenuItem[];
  error?: string;
};

function matches(item: ComposerMenuItem, query: string) {
  return `${item.label} ${item.id} ${item.description ?? ""}`
    .toLowerCase()
    .includes(query.toLowerCase());
}

/**
 * One menu for the + button, "/" and pinned shortcuts. The + button inserts "/" so
 * both entry points show the same list; every MCP step stays inside this menu.
 */
export function useComposerMenu({
  text,
  setText,
  textareaRef,
  containerRef,
  disabled,
  rootItems,
  views,
  mentionView,
  onActivate,
  onError,
}: {
  text: string;
  setText: (text: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  containerRef: RefObject<HTMLElement | null>;
  disabled?: boolean;
  rootItems: ComposerMenuItem[];
  views: Record<string, ComposerMenuView>;
  /** View opened by "@" (Work sandbox references). */
  mentionView?: string;
  /** `insertText` places text where the "/" trigger (or caret) was. */
  onActivate: (
    item: ComposerMenuItem,
    view: string,
    insertText: (text: string) => void,
  ) => ComposerMenuOutcome | Promise<ComposerMenuOutcome>;
  onError?: (message: string | null) => void;
}): ComposerMenuState {
  const t = useTranslations("console.workComposer");
  const id = useId();
  const [frames, setFrames] = useState<Frame[]>([]);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded>({ key: "", items: [] });
  const insertAt = useRef<number | null>(null);
  const generation = useRef(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const textRef = useRef(text);
  // Draft at dismissal: refocusing an unchanged "/" must not reopen the menu.
  const dismissedText = useRef<string | null>(null);
  textRef.current = text;

  const open = frames.length > 0 && !disabled;
  const frame = frames.at(-1);
  const view = frame && frame.view !== "root" ? views[frame.view] : undefined;
  const textQuery =
    trigger && frames.length === 1
      ? text.slice(trigger.start + 1, trigger.end)
      : null;
  const query = textQuery ?? frame?.query ?? "";
  const loadKey =
    view && !frame?.form
      ? JSON.stringify([frame?.view, view.remoteQuery ? query : ""])
      : "";

  useEffect(() => {
    if (!view || !loadKey) return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => {
        view
          .load(view.remoteQuery ? query : "", controller.signal)
          .then((items) => {
            if (!controller.signal.aborted) setLoaded({ key: loadKey, items });
          })
          .catch((cause) => {
            if (!controller.signal.aborted)
              setLoaded({
                key: loadKey,
                items: [],
                error: cause instanceof Error ? cause.message : t("loadFailed"),
              });
          });
      },
      view.remoteQuery ? 150 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadKey, query, t, view]);

  const loading = Boolean(loadKey && loaded.key !== loadKey);
  const items = frame?.form
    ? []
    : view
      ? loaded.key === loadKey
        ? view.remoteQuery
          ? loaded.items
          : loaded.items.filter((item) => matches(item, query))
        : []
      : rootItems.filter((item) => matches(item, query));
  const activeIndex = Math.min(index, Math.max(0, items.length - 1));
  const error = frame?.form
    ? formError
    : view && loaded.key === loadKey
      ? loaded.error
      : undefined;

  const focusText = useCallback(
    (position?: number) => {
      window.requestAnimationFrame(() => {
        const input = textareaRef.current;
        input?.focus();
        if (position !== undefined)
          input?.setSelectionRange(position, position);
      });
    },
    [textareaRef],
  );

  /** Remove the typed "/query" so selections insert where the trigger was. */
  const consumeTrigger = useCallback(() => {
    if (!trigger) return;
    const current = textRef.current;
    const from = trigger.start - trigger.pad;
    setText(current.slice(0, from) + current.slice(trigger.end));
    insertAt.current = from;
    setTrigger(null);
  }, [setText, trigger]);

  const close = useCallback(
    (restoreFocus = true) => {
      // Results that arrive after dismissal must not touch the draft.
      generation.current += 1;
      dismissedText.current = textRef.current;
      // Dismissing a menu opened by + leaves no stray "/" behind.
      if (trigger?.fromButton && trigger.end === trigger.start + 1) {
        const current = textRef.current;
        const from = trigger.start - trigger.pad;
        setText(current.slice(0, from) + current.slice(trigger.end));
        if (restoreFocus) focusText(from);
      } else if (restoreFocus) focusText();
      setTrigger(null);
      setFrames([]);
      setFormError(null);
      setIndex(0);
    },
    [focusText, setText, trigger],
  );

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [close, containerRef, open]);

  // Sub-views and forms take keyboard focus; the root follows the textarea.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Focus moves only when the visible view changes.
  useEffect(() => {
    if (open && (frames.length > 1 || !trigger) && !frame?.form)
      searchRef.current?.focus();
  }, [open, frames.length, frame?.view, frame?.form]);

  useEffect(() => {
    if (open)
      document
        .getElementById(`${id}-${activeIndex}`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, id, open]);

  /** Call from the textarea's change and select handlers. */
  const sync = useCallback(
    (value: string, start: number, end: number) => {
      if (frames.length > 1 || (frames.length === 1 && !trigger)) return;
      if (!frames.length && value === dismissedText.current) return;
      dismissedText.current = null;
      const next = composerTrigger(value, start, end);
      if (!next || (next.symbol === "@" && !mentionView)) {
        if (trigger) {
          setTrigger(null);
          setFrames([]);
        }
        return;
      }
      const kept = Boolean(trigger?.fromButton && trigger.start === next.start);
      setTrigger({
        symbol: next.symbol,
        start: next.start,
        end: next.end,
        fromButton: kept,
        pad: kept && trigger ? trigger.pad : 0,
      });
      setFrames([
        next.symbol === "@" && mentionView
          ? { view: mentionView, query: next.query }
          : { view: "root", query: "" },
      ]);
      setIndex(0);
    },
    [frames.length, mentionView, trigger],
  );

  /** The + button behaves exactly like typing "/" at the caret. */
  const openFromButton = useCallback(() => {
    if (open) {
      close();
      return;
    }
    const input = textareaRef.current;
    const current = textRef.current;
    const at = input?.selectionStart ?? current.length;
    const end = input?.selectionEnd ?? at;
    const prefix = at > 0 && !/\s/.test(current[at - 1] ?? "") ? " " : "";
    const start = at + prefix.length;
    setText(`${current.slice(0, at)}${prefix}/${current.slice(end)}`);
    setTrigger({
      symbol: "/",
      start,
      end: start + 1,
      fromButton: true,
      pad: prefix.length,
    });
    setFrames([{ view: "root", query: "" }]);
    setIndex(0);
    focusText(start + 1);
  }, [close, focusText, open, setText, textareaRef]);

  /** Pinned shortcuts open a view directly, without touching the draft. */
  const openView = useCallback(
    (key: string) => {
      const input = textareaRef.current;
      insertAt.current = input?.selectionStart ?? textRef.current.length;
      setTrigger(null);
      setFrames([
        { view: "root", query: "" },
        { view: key, query: "" },
      ]);
      setIndex(0);
    },
    [textareaRef],
  );

  const back = useCallback(() => {
    setFormError(null);
    setIndex(0);
    setFrames((current) =>
      current.length > 1 ? current.slice(0, -1) : current,
    );
  }, []);

  /** Inserts text where the trigger (or caret) was when the menu was used. */
  const insertText = useCallback(
    (value: string) => {
      const current = textRef.current;
      const at = Math.min(
        insertAt.current ??
          textareaRef.current?.selectionStart ??
          current.length,
        current.length,
      );
      // Keep inserted content from fusing with the preceding word.
      const text =
        at > 0 && !/\s/.test(current[at - 1] ?? "") && !/^\s/.test(value)
          ? ` ${value}`
          : value;
      setText(current.slice(0, at) + text + current.slice(at));
      insertAt.current = null;
      focusText(at + text.length);
    },
    [focusText, setText, textareaRef],
  );

  const activate = useCallback(
    async (item: ComposerMenuItem | undefined) => {
      if (!item || item.disabled || item.readOnly || !frame || busy) return;
      if (frames.length === 1) consumeTrigger();
      onError?.(null);
      setBusy(true);
      const run = generation.current;
      const current = () => generation.current === run;
      const guardedInsert = (value: string) => {
        if (current()) insertText(value);
      };
      try {
        const outcome = await onActivate(item, frame.view, guardedInsert);
        if (!current() || outcome === "keep") return;
        if (outcome && "view" in outcome) {
          setFrames((current) => [
            ...current,
            { view: outcome.view, query: outcome.query ?? "" },
          ]);
          setIndex(0);
          return;
        }
        if (outcome && "form" in outcome) {
          setFormError(null);
          setFrames((current) => [
            ...current,
            { view: frame.view, query: "", form: outcome.form },
          ]);
          return;
        }
        setTrigger(null);
        setFrames([]);
        setIndex(0);
      } catch (cause) {
        if (!current()) return;
        const message =
          cause instanceof Error ? cause.message : t("loadFailed");
        onError?.(message);
      } finally {
        setBusy(false);
      }
    },
    [
      busy,
      consumeTrigger,
      frame,
      frames.length,
      insertText,
      onActivate,
      onError,
      t,
    ],
  );

  const submitForm = useCallback(
    async (values: Record<string, string>) => {
      if (!frame?.form || busy) return;
      setBusy(true);
      setFormError(null);
      try {
        await frame.form.submit(values);
        setFrames([]);
        setTrigger(null);
      } catch (cause) {
        setFormError(cause instanceof Error ? cause.message : t("loadFailed"));
      } finally {
        setBusy(false);
      }
    },
    [busy, frame, t],
  );

  /** Returns true when the key belonged to the menu. */
  const onKeyDown = useCallback(
    (event: ComposerMenuKeyEvent) => {
      if (!open || event.nativeEvent.isComposing || event.keyCode === 229)
        return false;
      if (event.ctrlKey || event.metaKey || event.altKey) return false;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return true;
      }
      if (frame?.form) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (event.shiftKey) return false;
        event.preventDefault();
        if (items.length)
          setIndex(
            (activeIndex +
              (event.key === "ArrowDown" ? 1 : -1) +
              items.length) %
              items.length,
          );
        return true;
      }
      if (
        (event.key === "Enter" && !event.shiftKey) ||
        (event.key === "Tab" && items.length)
      ) {
        if (!items.length) return false;
        event.preventDefault();
        void activate(items[activeIndex]);
        return true;
      }
      if (
        event.key === "Backspace" &&
        event.currentTarget === searchRef.current &&
        !query &&
        frames.length > 1
      ) {
        event.preventDefault();
        back();
        return true;
      }
      return false;
    },
    [
      activate,
      activeIndex,
      back,
      close,
      frame?.form,
      frames.length,
      items,
      open,
      query,
    ],
  );

  return {
    id,
    open,
    frame,
    frames,
    view,
    trigger,
    query,
    items,
    activeIndex,
    loading,
    busy,
    error,
    searchRef,
    setIndex,
    setQuery: (value: string) => {
      setIndex(0);
      setFrames((current) =>
        current.map((item, position) =>
          position === current.length - 1 ? { ...item, query: value } : item,
        ),
      );
    },
    sync,
    openFromButton,
    openView,
    close,
    back,
    activate,
    submitForm,
    onKeyDown,
    insertText,
    comboboxProps: {
      "aria-autocomplete": "list" as const,
      "aria-haspopup": "listbox" as const,
      "aria-expanded": open,
      "aria-controls": open ? `${id}-list` : undefined,
      "aria-activedescendant":
        open && items.length ? `${id}-${activeIndex}` : undefined,
    },
  };
}

export type ComposerMenuState = {
  id: string;
  open: boolean;
  frame: Frame | undefined;
  frames: Frame[];
  view: ComposerMenuView | undefined;
  trigger: Trigger | null;
  query: string;
  items: ComposerMenuItem[];
  activeIndex: number;
  loading: boolean;
  busy: boolean;
  error: string | null | undefined;
  searchRef: RefObject<HTMLInputElement | null>;
  setIndex: (index: number) => void;
  setQuery: (value: string) => void;
  /** Call from the textarea's change and select handlers. */
  sync: (value: string, start: number, end: number) => void;
  openFromButton: () => void;
  openView: (key: string) => void;
  close: (restoreFocus?: boolean) => void;
  back: () => void;
  activate: (item: ComposerMenuItem | undefined) => Promise<void>;
  submitForm: (values: Record<string, string>) => Promise<void>;
  /** Returns true when the key belonged to the menu. */
  onKeyDown: (event: ComposerMenuKeyEvent) => boolean;
  /** Inserts text where the trigger (or caret) was when the menu was used. */
  insertText: (value: string) => void;
  comboboxProps: {
    "aria-autocomplete": "list";
    "aria-haspopup": "listbox";
    "aria-expanded": boolean;
    "aria-controls": string | undefined;
    "aria-activedescendant": string | undefined;
  };
};

/**
 * Render inside the composer's `relative` container: the panel sits above the
 * composer edge and never covers the text field.
 */
export function ComposerMenu({
  menu,
  rootTitle,
  footer,
  className,
}: {
  menu: ComposerMenuState;
  rootTitle?: string;
  footer?: { label: string; icon: LucideIcon; onSelect: () => void };
  /** Horizontal alignment with the composer surface. */
  className?: string;
}) {
  const t = useTranslations("console.workComposer");
  const common = useTranslations("common");
  const reduce = useReducedMotion() ?? false;
  const [values, setValues] = useState<Record<string, string>>({});
  const formId = useId();
  const { frame } = menu;
  const formKey = frame?.form
    ? `${frame.form.title}:${menu.frames.length}`
    : "";
  const [valuesKey, setValuesKey] = useState("");
  if (formKey !== valuesKey) {
    setValuesKey(formKey);
    setValues({});
  }
  if (!menu.open || !frame) return null;
  const nested = menu.frames.length > 1;
  const showSearch = !frame.form && (nested || !menu.trigger);
  const title = frame.form
    ? frame.form.title
    : (menu.view?.title ?? rootTitle ?? t("tools"));
  const FooterIcon = footer?.icon;

  return (
    <motion.div
      id={menu.id}
      data-ui="composer.menu"
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduce ? 0 : 0.14, ease: "easeOut" }}
      className={cn(
        "absolute bottom-full left-0 z-40 mb-2 flex max-h-[min(26rem,55dvh)] w-[min(22rem,100%)] flex-col overflow-hidden rounded-xl border border-border bg-background p-1.5 text-foreground shadow-lg",
        className,
      )}
    >
      <header className="mb-1 flex h-9 shrink-0 items-center gap-1.5 px-1">
        {nested ? (
          <Button
            type="button"
            aria-label={common("back")}
            title={common("back")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={menu.back}
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
          >
            <ChevronLeft className="size-4" />
          </Button>
        ) : (
          <Search
            aria-hidden="true"
            className="ml-1.5 size-4 shrink-0 text-muted-foreground"
          />
        )}
        {showSearch ? (
          <input
            ref={(input) => {
              menu.searchRef.current = input;
            }}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded
            aria-controls={`${menu.id}-list`}
            aria-activedescendant={
              menu.items.length ? `${menu.id}-${menu.activeIndex}` : undefined
            }
            aria-label={`${title} · ${t("search")}`}
            placeholder={nested ? title : t("search")}
            value={frame.query}
            onChange={(event) => menu.setQuery(event.target.value)}
            onKeyDown={(event) => {
              menu.onKeyDown(event);
            }}
            className="h-8 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate px-1 text-xs font-medium text-muted-foreground">
            {frame.form?.subtitle ? `${title} · ${frame.form.subtitle}` : title}
          </span>
        )}
        {menu.loading || menu.busy ? (
          <Loader2
            aria-label={common("loading")}
            className="mr-1.5 size-4 shrink-0 animate-spin text-muted-foreground"
          />
        ) : null}
      </header>
      {frame.form ? (
        <form
          id={formId}
          className="flex min-h-0 flex-col gap-3 overflow-y-auto px-2 pb-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void menu.submitForm(values);
          }}
          onKeyDown={(event) => {
            menu.onKeyDown(event);
          }}
        >
          {frame.form.description ? (
            <p className="text-xs leading-5 text-muted-foreground">
              {frame.form.description}
            </p>
          ) : null}
          {frame.form.fields.map((field, position) => (
            <div key={field.name} className="flex flex-col gap-1 text-xs">
              <label
                htmlFor={`${formId}-${field.name}`}
                className="text-muted-foreground"
              >
                {field.label}
                {field.required ? (
                  <span className="text-destructive">*</span>
                ) : null}
              </label>
              <Input
                id={`${formId}-${field.name}`}
                autoFocus={position === 0}
                value={values[field.name] ?? ""}
                onChange={(value) =>
                  setValues((current) => ({ ...current, [field.name]: value }))
                }
                required={field.required}
                maxLength={20_000}
                placeholder={field.placeholder}
                className="w-full"
              />
            </div>
          ))}
          {menu.error ? (
            <p role="alert" className="text-xs text-destructive">
              {menu.error}
            </p>
          ) : null}
          <Button
            type="submit"
            autoFocus={!frame.form.fields.length}
            disabled={menu.busy}
            variant="primary"
            size="sm"
            className="self-end"
          >
            {frame.form.submitLabel}
          </Button>
        </form>
      ) : (
        <>
          <div
            role="listbox"
            id={`${menu.id}-list`}
            aria-label={title}
            className="min-h-0 overflow-y-auto"
          >
            {menu.items.map((item, position) => {
              const Icon = item.icon;
              const group = item.group;
              return (
                <div key={item.id} role="presentation">
                  {group && group !== menu.items[position - 1]?.group ? (
                    <div
                      role="presentation"
                      className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-muted-foreground"
                    >
                      {group}
                    </div>
                  ) : null}
                  <button
                    id={`${menu.id}-${position}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={position === menu.activeIndex}
                    aria-disabled={item.disabled || item.readOnly}
                    disabled={item.disabled}
                    onMouseDown={(event) => event.preventDefault()}
                    onPointerMove={() => {
                      if (position !== menu.activeIndex)
                        menu.setIndex(position);
                    }}
                    onClick={() => void menu.activate(item)}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors aria-selected:bg-muted disabled:pointer-events-none disabled:opacity-50",
                      item.readOnly && "cursor-default",
                    )}
                  >
                    <span
                      className={`mt-0.5 grid size-5 shrink-0 place-items-center [&_svg]:size-4 ${item.pressed ? "text-primary" : "text-muted-foreground"}`}
                    >
                      <Icon aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1 break-words">
                      <span className="block text-sm text-foreground">
                        {item.label}
                      </span>
                      {item.description ? (
                        <span className="mt-0.5 line-clamp-2 block text-xs leading-4 text-muted-foreground">
                          {item.description}
                        </span>
                      ) : null}
                    </span>
                    {item.hint ? (
                      <span className="mt-0.5 shrink-0 text-xs text-muted-foreground">
                        {item.hint}
                      </span>
                    ) : null}
                    {item.drill ? (
                      <ChevronRight
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      />
                    ) : null}
                  </button>
                </div>
              );
            })}
            {!menu.loading && !menu.items.length ? (
              <p
                role="status"
                className="px-3 py-6 text-center text-xs text-muted-foreground"
              >
                {menu.error ?? menu.view?.empty ?? t("empty")}
              </p>
            ) : null}
          </div>
          {footer && FooterIcon && !nested ? (
            <div className="mt-1 border-t border-border pt-1">
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  menu.close(false);
                  footer.onSelect();
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-foreground outline-none transition-colors hover:bg-muted focus-visible:bg-muted"
              >
                <span className="grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4">
                  <FooterIcon aria-hidden="true" />
                </span>
                {footer.label}
              </button>
            </div>
          ) : null}
        </>
      )}
    </motion.div>
  );
}
