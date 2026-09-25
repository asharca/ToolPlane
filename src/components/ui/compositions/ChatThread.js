// Application composition port from @asharca/ui@0.2.1 (MIT). See NOTICE.md.
'use client';
import { Button as BeuiButton } from '@/components/ui/Controls';

var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { createContext, lazy, Suspense, useContext, useMemo, useRef, useState, } from 'react';
import { ActionBarPrimitive, AssistantRuntimeProvider, AttachmentPrimitive, ChainOfThoughtPrimitive, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAuiState, useMessagePartText, } from '@assistant-ui/react';
import { StreamdownTextPrimitive } from '@assistant-ui/react-streamdown';
import { code } from '@streamdown/code';
import { Popover } from '@/components/ui/primitives';
import remarkBreaks from 'remark-breaks';
import { defaultRemarkPlugins } from 'streamdown';
import { Bot, Box, Brain, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, CirclePause, Copy, Globe2, Loader2, Maximize2, Minimize2, Paperclip, Pencil, Plug, Plus, RefreshCw, Send, Split, UserRound, Wrench, X, } from 'lucide-react';
import { Button, IconButton } from "../Controls";
import { hasMermaidFence } from "./chat-markdown.js";
const MermaidAssistantText = lazy(() => import("./MermaidAssistantText.js"));
export const chatThreadDefaultLabels = {
    addAttachment: 'Add attachment',
    allowTool: 'Allow',
    attachment: 'Attachment',
    attachmentsUnavailable: 'Attachments are not available.',
    cancel: 'Cancel',
    composerTools: 'Composer tools',
    conversationBranch: 'Conversation branch',
    copy: 'Copy',
    edit: 'Edit',
    expandComposer: 'Expand composer',
    generatingReply: 'Generating reply',
    messagePlaceholder: 'Type a message',
    next: 'Next',
    openComposerTools: 'Open tools',
    preparingReply: 'Preparing',
    previous: 'Previous',
    processFailed: 'Process failed',
    processed: 'Processed',
    processing: 'Processing',
    regenerate: 'Regenerate',
    rejectTool: 'Reject',
    removeAttachment: (name) => `Remove ${name}`,
    restoreComposer: 'Restore composer',
    save: 'Save',
    scrollToLatestMessage: 'Scroll to latest message',
    send: 'Send',
    startBranch: 'Start a new branch',
    startConversation: 'Start a conversation',
    stop: 'Stop',
    thinking: 'Thinking',
    thought: 'Thought',
    toolApprovalDescription: 'This tool needs your approval before it can run.',
    toolAwaitingApproval: 'Awaiting approval',
    toolCompleted: 'Completed',
    toolFailed: 'Failed',
    toolInput: 'Input',
    toolKindMcp: 'MCP',
    toolKindSandbox: 'Sandbox',
    toolKindSkill: 'Skill',
    toolKindSubagent: 'Sub-agent',
    toolKindTool: 'Tool',
    toolKindWeb: 'Web',
    toolOutput: 'Output',
    toolRunning: 'Running',
    user: 'You',
    usingTool: (toolName) => `Using ${toolName}`,
};
const LabelsContext = createContext(chatThreadDefaultLabels);
const UserTextTransformContext = createContext((text) => text);
const markdownPlugins = { code };
const markdownRemarkPlugins = [...Object.values(defaultRemarkPlugins), remarkBreaks];
function cx(...classes) {
    return classes.filter(Boolean).join(' ');
}
function useLabels() {
    return useContext(LabelsContext);
}
function formatToolResult(result) {
    if (typeof result === 'string')
        return result;
    if (result && typeof result === 'object' && 'content' in result && Array.isArray(result.content)) {
        const text = result.content.flatMap((part) => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
            ? [part.text]
            : [])).join('\n\n');
        if (text)
            return text;
    }
    try {
        return JSON.stringify(result, null, 2);
    }
    catch (_a) {
        return String(result);
    }
}
function toolKind(toolName) {
    if (/(?:^|__)(?:brave|web|firecrawl|fetch|search|crawl|scrape|extract|browser)/i.test(toolName))
        return 'web';
    if (/skill/i.test(toolName))
        return 'skill';
    if (/sandbox|terminal|shell|process|filesystem/i.test(toolName))
        return 'sandbox';
    if (/sub.?agent|delegate/i.test(toolName))
        return 'subagent';
    if (toolName.includes('__'))
        return 'mcp';
    return 'tool';
}
function toolKindLabel(kind, labels) {
    return {
        web: labels.toolKindWeb,
        skill: labels.toolKindSkill,
        sandbox: labels.toolKindSandbox,
        mcp: labels.toolKindMcp,
        subagent: labels.toolKindSubagent,
        tool: labels.toolKindTool,
    }[kind];
}
function displayToolName(toolName) {
    const sandboxAlias = /^(?:mcp__)?tp_\d+_[A-Za-z0-9_-]+__(.+)$/.exec(toolName);
    if (sandboxAlias)
        return sandboxAlias[1];
    return toolName;
}
function UserText({ text }) {
    const transform = useContext(UserTextTransformContext);
    return _jsx("span", { className: "block whitespace-pre-wrap [&:not(:last-child)]:mb-2", children: transform(text) });
}
function AssistantText() {
    const { text } = useMessagePartText();
    if (hasMermaidFence(text)) {
        return (_jsx(Suspense, { fallback: _jsx(PlainAssistantText, {}), children: _jsx(MermaidAssistantText, {}) }));
    }
    return _jsx(PlainAssistantText, {});
}
function PlainAssistantText() {
    return (_jsx(StreamdownTextPrimitive, { plugins: markdownPlugins, remarkPlugins: markdownRemarkPlugins, linkSafety: { enabled: true }, security: {
            allowedProtocols: ['http', 'https', 'mailto'],
            allowDataImages: false,
        }, className: "space-y-2 [&_li]:my-0.5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:my-2 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5" }));
}
function ReasoningPart({ text, status }) {
    const labels = useLabels();
    if (!text.trim())
        return null;
    const running = status.type === 'running';
    return (_jsxs("details", { open: running, className: "group/reasoning rounded-md", children: [_jsxs("summary", { className: "flex min-h-7 cursor-pointer list-none items-center gap-2 rounded-md px-1 text-muted-foreground marker:content-none hover:bg-muted/50", children: [running
                        ? _jsx(Loader2, { className: "size-3.5 shrink-0 animate-spin" })
                        : _jsx(CheckCircle2, { className: "size-3.5 shrink-0" }), _jsx(Brain, { className: "size-3.5 shrink-0" }), _jsx("span", { children: running ? labels.thinking : labels.thought }), text ? _jsx(ChevronRight, { className: "ml-auto size-3.5 transition-transform group-open/reasoning:rotate-90" }) : null] }), text ? (_jsx("pre", { className: "ml-5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground", children: text })) : null] }));
}
function FilePart({ data, filename }) {
    const labels = useLabels();
    return (_jsxs("a", { href: data, download: filename, className: "my-1 inline-flex max-w-full items-center gap-2 rounded-md border border-current/20 px-2 py-1 text-xs underline-offset-2 hover:underline", children: [_jsx(Paperclip, { className: "size-3.5 shrink-0" }), _jsx("span", { className: "truncate", children: filename || labels.attachment })] }));
}
function ToolPart({ toolName, status, result, isError, args, argsText, approval, respondToApproval, }) {
    const labels = useLabels();
    const displayName = displayToolName(toolName);
    const kind = toolKind(toolName);
    const Icon = kind === 'skill'
        ? Brain
        : kind === 'web'
            ? Globe2
            : kind === 'sandbox'
                ? Box
                : kind === 'mcp'
                    ? Plug
                    : kind === 'subagent'
                        ? Bot
                        : Wrench;
    const waitingForApproval = approval && approval.approved === undefined && !approval.resolution;
    const running = status.type === 'running';
    const stateLabel = waitingForApproval
        ? labels.toolAwaitingApproval
        : running
            ? labels.toolRunning
            : isError
                ? labels.toolFailed
                : labels.toolCompleted;
    const StateIcon = waitingForApproval || isError ? CircleAlert : running ? Loader2 : CheckCircle2;
    return (_jsxs("details", { open: running || Boolean(isError) || Boolean(waitingForApproval), className: cx('group my-1 overflow-hidden rounded-lg text-xs', (isError || waitingForApproval) && 'bg-amber-500/5'), children: [_jsxs("summary", { className: "flex min-h-7 cursor-pointer list-none items-center gap-1.5 rounded-lg px-1 py-0.5 marker:content-none hover:bg-muted/50", children: [_jsx(ChevronRight, { className: "size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" }), _jsx(Icon, { className: "size-3.5 shrink-0 text-muted-foreground" }), _jsxs("span", { className: "min-w-0 flex-1 truncate text-[13px] text-muted-foreground", children: [_jsx("span", { className: "font-medium text-foreground", children: displayName }), _jsx("span", { className: "ml-1.5 text-[11px]", children: toolKindLabel(kind, labels) })] }), _jsxs("span", { className: cx('inline-flex shrink-0 items-center gap-1 px-1.5 text-[10px] font-medium', isError ? 'text-red-700 dark:text-red-300'
                            : waitingForApproval ? 'text-amber-700 dark:text-amber-300'
                                : running ? 'text-brand'
                                    : 'text-muted-foreground'), children: [_jsx(StateIcon, { className: cx('size-3', running && 'animate-spin') }), stateLabel] })] }), _jsxs("div", { className: "ml-5 space-y-3 border-l border-border/70 px-3 py-2", children: [_jsxs("div", { children: [_jsx("p", { className: "mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground", children: labels.toolInput }), _jsx("pre", { className: "max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-2 text-[11px] leading-relaxed text-foreground", children: argsText.trim() || formatToolResult(args) })] }), waitingForApproval ? (_jsxs("div", { className: "rounded-md border border-amber-500/25 bg-amber-500/10 p-2.5", children: [_jsx("p", { className: "text-xs font-medium text-amber-800 dark:text-amber-200", children: labels.toolApprovalDescription }), _jsxs("div", { className: "mt-2 flex flex-wrap gap-2", children: [_jsx(Button, { size: "sm", variant: "primary", onClick: () => respondToApproval({ approved: true }), children: labels.allowTool }), _jsx(Button, { size: "sm", variant: "secondary", onClick: () => respondToApproval({ approved: false }), children: labels.rejectTool })] })] })) : null, result !== undefined ? (_jsxs("div", { children: [_jsx("p", { className: "mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground", children: labels.toolOutput }), _jsx("pre", { className: cx('max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border p-2 text-[11px] leading-relaxed', isError ? 'border-red-500/20 bg-red-500/5 text-red-800 dark:text-red-200' : 'border-border bg-muted/30 text-foreground'), children: formatToolResult(result) })] })) : null] })] }));
}
function AssistantProcess() {
    const labels = useLabels();
    const running = useAuiState((state) => state.chainOfThought.status.type === 'running');
    const hasContent = useAuiState((state) => state.chainOfThought.parts.some((part) => (part.type === 'tool-call' || (part.type === 'reasoning' && Boolean(part.text.trim())))));
    const failed = useAuiState((state) => state.chainOfThought.parts.some((part) => (part.type === 'tool-call' && part.isError)));
    if (!hasContent)
        return null;
    const timeline = (_jsx("div", { className: "ml-5 py-1", children: _jsx(ChainOfThoughtPrimitive.Parts, { components: { Reasoning: ReasoningPart, tools: { Fallback: ToolPart } } }) }));
    if (running) {
        return (_jsx(ChainOfThoughtPrimitive.Root, { asChild: true, children: _jsx("div", { "data-ui": "assistant-process", className: "my-1.5 text-xs", children: timeline }) }));
    }
    return (_jsx(ChainOfThoughtPrimitive.Root, { asChild: true, children: _jsxs("details", { open: failed, "data-ui": "assistant-process", className: "group/process my-1.5 text-xs", children: [_jsxs("summary", { className: "flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-md px-1 text-muted-foreground marker:content-none hover:bg-muted/50", children: [_jsx(ChevronRight, { className: "size-3.5 shrink-0 transition-transform group-open/process:rotate-90" }), failed
                            ? _jsx(CircleAlert, { className: "size-3.5 shrink-0 text-red-600" })
                            : _jsx(CheckCircle2, { className: "size-3.5 shrink-0" }), _jsx("span", { className: "shrink-0 font-medium text-foreground", children: failed ? labels.processFailed : labels.processed })] }), timeline] }) }));
}
function PendingIndicator() {
    const { generatingReply } = useLabels();
    return (_jsx("div", { role: "status", "aria-label": generatingReply, "data-ui": "conversation-pending", className: "flex items-center py-0.5 text-[13px] text-muted-foreground", children: _jsxs("span", { "aria-hidden": "true", className: "flex items-center gap-1", children: [_jsx("span", { "data-ui": "conversation-pending-dot", className: "size-1 animate-bounce rounded-full bg-current [animation-delay:-300ms]" }), _jsx("span", { "data-ui": "conversation-pending-dot", className: "size-1 animate-bounce rounded-full bg-current [animation-delay:-150ms]" }), _jsx("span", { "data-ui": "conversation-pending-dot", className: "size-1 animate-bounce rounded-full bg-current" })] }) }));
}
function AssistantPendingPart() {
    const running = useAuiState((state) => { var _a; return ((_a = state.message.status) === null || _a === void 0 ? void 0 : _a.type) === 'running'; });
    if (!running)
        return null;
    return _jsx(PendingIndicator, {});
}
function attachmentUrl(attachment) {
    var _a;
    const part = (_a = attachment.content) === null || _a === void 0 ? void 0 : _a.find((item) => item.type === 'file' || item.type === 'image');
    if ((part === null || part === void 0 ? void 0 : part.type) === 'file')
        return part.data;
    if ((part === null || part === void 0 ? void 0 : part.type) === 'image')
        return part.image;
    return null;
}
function SentAttachment({ attachment }) {
    const url = attachmentUrl(attachment);
    return (_jsxs(AttachmentPrimitive.Root, { className: "my-1 inline-flex h-8 max-w-full items-center gap-2 rounded-md border border-current/20 px-2 text-xs", children: [_jsx(Paperclip, { className: "size-3.5 shrink-0" }), url ? (_jsx("a", { href: url, download: attachment.name, className: "min-w-0 truncate underline-offset-2 hover:underline", children: _jsx(AttachmentPrimitive.Name, {}) })) : (_jsx("span", { className: "min-w-0 truncate", children: _jsx(AttachmentPrimitive.Name, {}) }))] }));
}
function ComposerAttachment({ attachment }) {
    const labels = useLabels();
    return (_jsxs(AttachmentPrimitive.Root, { className: "mx-0.5 my-0.5 inline-flex h-6 max-w-[calc(100%_-_0.25rem)] items-center gap-1 overflow-hidden rounded-md border border-border bg-muted/50 px-1.5 text-xs font-medium text-foreground", children: [_jsx(AttachmentPrimitive.unstable_Thumb, { className: "flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-background text-[9px] font-semibold uppercase text-muted-foreground" }), _jsx("span", { className: "max-w-48 truncate", children: _jsx(AttachmentPrimitive.Name, {}) }), attachment.status.type === 'running' ? (_jsxs("span", { className: "text-muted-foreground", children: [Math.round(attachment.status.progress * 100), "%"] })) : null, _jsx(AttachmentPrimitive.Remove, { "aria-label": labels.removeAttachment(attachment.name), title: labels.removeAttachment(attachment.name), className: "flex size-4 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground hover:bg-muted hover:text-foreground", children: _jsx(X, { className: "size-3" }) })] }));
}
function AttachmentPicker({ disabled, enabled }) {
    const labels = useLabels();
    return (_jsxs(Popover.Root, { children: [_jsx(Popover.Trigger, { asChild: true, children: _jsx(IconButton, { icon: _jsx(Plus, { className: "size-[18px]" }), label: labels.openComposerTools, size: "sm", variant: "ghost", disabled: disabled, className: "size-[30px] min-h-[30px] shrink-0 rounded-full" }) }), _jsx(Popover.Portal, { children: _jsx(Popover.Content, { side: "top", align: "start", sideOffset: 8, collisionPadding: 12, "aria-label": labels.composerTools, className: "z-50 w-64 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl", children: _jsx(Popover.Close, { asChild: true, children: _jsxs(ComposerPrimitive.AddAttachment, { multiple: true, disabled: !enabled, className: "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60", children: [_jsx(Paperclip, { className: "size-4 shrink-0" }), _jsxs("span", { className: "min-w-0", children: [_jsx("span", { className: "block", children: labels.addAttachment }), !enabled ? _jsx("span", { className: "mt-0.5 block text-[11px] text-muted-foreground", children: labels.attachmentsUnavailable }) : null] })] }) }) }) })] }));
}
function BranchNavigator({ branch, disabled, onSelect, }) {
    const labels = useLabels();
    if (!branch || !onSelect)
        return null;
    return (_jsxs("div", { role: "group", "aria-label": labels.conversationBranch, className: "inline-flex h-8 items-center gap-0.5 text-[11px] tabular-nums text-muted-foreground", children: [_jsx(IconButton, { icon: _jsx(ChevronLeft, { className: "size-3" }), label: labels.previous, size: "sm", variant: "ghost", disabled: disabled, onClick: () => void onSelect(branch.previousMessageId), className: "rounded-md" }), _jsxs("span", { className: "min-w-8 text-center font-mono", children: [branch.position, "/", branch.total] }), _jsx(IconButton, { icon: _jsx(ChevronRight, { className: "size-3" }), label: labels.next, size: "sm", variant: "ghost", disabled: disabled, onClick: () => void onSelect(branch.nextMessageId), className: "rounded-md" })] }));
}
function UserMessage({ allowEdit, branch, busy, components, messageId, onBranchSelect, }) {
    var _a;
    const labels = useLabels();
    const SentAttachmentComponent = (_a = components === null || components === void 0 ? void 0 : components.SentAttachment) !== null && _a !== void 0 ? _a : SentAttachment;
    return (_jsx(MessagePrimitive.Root, { asChild: true, children: _jsxs("article", { id: `chat-message-${messageId}`, className: "flex flex-col items-end rounded-[10px] pt-2.5", children: [_jsxs(ComposerPrimitive.If, { editing: false, children: [_jsxs("div", { className: "flex max-w-full items-start justify-end gap-2.5", children: [_jsxs("div", { className: "min-w-0 max-w-[calc(100%_-_2.5rem)] break-words rounded-[10px] bg-muted px-4 py-2.5 text-sm leading-[1.65] text-foreground", children: [_jsx(MessagePrimitive.Parts, { components: { Text: UserText } }), _jsx(MessagePrimitive.Attachments, { children: ({ attachment }) => _jsx(SentAttachmentComponent, { attachment: attachment }) })] }), _jsx("div", { "aria-label": labels.user, className: "flex size-[30px] shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground", children: _jsx(UserRound, { className: "size-4" }) })] }), _jsxs("div", { className: "mr-10 flex min-h-[26px] items-center justify-end gap-1", children: [_jsx(BranchNavigator, { branch: branch, disabled: busy, onSelect: onBranchSelect }), _jsxs(ActionBarPrimitive.Root, { autohide: "always", className: "flex h-[26px] items-center justify-end gap-0.5", children: [allowEdit ? (_jsx(ActionBarPrimitive.Edit, { "aria-label": labels.edit, title: labels.edit, className: "flex size-[26px] items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40", children: _jsx(Pencil, { className: "size-[14px]" }) })) : null, _jsx(ActionBarPrimitive.Copy, { "aria-label": labels.copy, title: labels.copy, className: "flex size-[26px] items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40", children: _jsx(Copy, { className: "size-[15px]" }) })] })] })] }), _jsx(ComposerPrimitive.If, { editing: true, children: _jsxs(ComposerPrimitive.Root, { className: "mr-10 w-[min(36rem,calc(100%_-_2.5rem))] rounded-[10px] bg-muted p-2", children: [_jsx(ComposerPrimitive.Input, { autoFocus: true, rows: 2, submitMode: "enter", className: "max-h-48 min-h-14 w-full resize-none bg-transparent px-2 py-1 text-sm leading-6 outline-none" }), _jsxs("div", { className: "mt-1 flex justify-end gap-1", children: [_jsx(ComposerPrimitive.Cancel, { "aria-label": labels.cancel, title: labels.cancel, className: "flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground", children: _jsx(X, { className: "size-4" }) }), _jsx(ComposerPrimitive.Send, { "aria-label": labels.save, title: labels.save, className: "flex size-7 items-center justify-center rounded-md bg-foreground text-background disabled:opacity-40", children: _jsx(Check, { className: "size-4" }) })] })] }) })] }) }));
}
function AssistantMessage({ agentName, allowRegenerate, branch, busy, components, messageId, onBranchSelect, onBranchStart, onRegenerateMessage, }) {
    var _a;
    const labels = useLabels();
    const AssistantTextComponent = (_a = components === null || components === void 0 ? void 0 : components.AssistantText) !== null && _a !== void 0 ? _a : AssistantText;
    const AssistantMessageBefore = components === null || components === void 0 ? void 0 : components.AssistantMessageBefore;
    const AssistantMessageAfter = components === null || components === void 0 ? void 0 : components.AssistantMessageAfter;
    const AssistantActions = components === null || components === void 0 ? void 0 : components.AssistantActions;
    return (_jsx(MessagePrimitive.Root, { asChild: true, children: _jsxs("article", { id: `chat-message-${messageId}`, "data-ui": "assistant-reply", className: "group/message flex items-start justify-start gap-2.5 rounded-[10px] pt-2.5", children: [_jsx("div", { className: "flex size-[30px] shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground", children: _jsx(Bot, { className: "size-[15px]" }) }), _jsxs("div", { className: "min-w-0 max-w-[calc(100%_-_2.5rem)] flex-1", children: [_jsx("div", { className: "text-sm font-semibold leading-5 text-foreground", children: agentName }), _jsxs("div", { className: "mt-2 min-w-0 break-words text-sm leading-[1.65] text-foreground", children: [AssistantMessageBefore ? _jsx(AssistantMessageBefore, { messageId: messageId }) : null, _jsx(MessagePrimitive.Parts, { components: { Text: AssistantTextComponent, File: FilePart, ChainOfThought: AssistantProcess, Empty: AssistantPendingPart } }), AssistantMessageAfter ? _jsx(AssistantMessageAfter, { messageId: messageId }) : null] }), _jsxs("div", { className: "mt-1 flex min-h-[26px] items-center gap-1", children: [_jsx(BranchNavigator, { branch: branch, disabled: busy, onSelect: onBranchSelect }), _jsxs(ActionBarPrimitive.Root, { hideWhenRunning: true, autohide: "not-last", className: "flex h-[26px] items-center gap-0.5", children: [onBranchStart ? (_jsx(BeuiButton, Object.assign({ nativeButton: true, unstyled: true }, { type: "button", disabled: busy, "aria-label": labels.startBranch, title: labels.startBranch, onClick: () => void onBranchStart(messageId), className: "flex size-[26px] items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40", children: _jsx(Split, { className: "size-[15px]" }) }))) : null, _jsx(ActionBarPrimitive.Copy, { "aria-label": labels.copy, title: labels.copy, className: "flex size-[26px] items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40", children: _jsx(Copy, { className: "size-[15px]" }) }), AssistantActions ? _jsx(AssistantActions, { messageId: messageId }) : null, allowRegenerate && onRegenerateMessage ? (_jsx(BeuiButton, Object.assign({ nativeButton: true, unstyled: true }, { type: "button", disabled: busy, "aria-label": labels.regenerate, title: labels.regenerate, onClick: () => void onRegenerateMessage(messageId), className: "flex size-[26px] items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40", children: _jsx(RefreshCw, { className: "size-[15px]" }) }))) : allowRegenerate ? (_jsx(ActionBarPrimitive.Reload, { "aria-label": labels.regenerate, title: labels.regenerate, className: "flex size-[26px] items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40", children: _jsx(RefreshCw, { className: "size-[15px]" }) })) : null] })] })] })] }) }));
}
function ComposerExpand({ expanded, onToggle }) {
    const labels = useLabels();
    const Icon = expanded ? Minimize2 : Maximize2;
    const label = expanded ? labels.restoreComposer : labels.expandComposer;
    return (_jsx("div", { className: "absolute right-px top-px z-10 size-8", children: _jsx(BeuiButton, Object.assign({ nativeButton: true, unstyled: true }, { type: "button", onClick: onToggle, "aria-label": label, title: label, "aria-pressed": expanded, className: "pointer-events-none absolute right-1 top-1 flex size-[22px] -translate-y-2.5 translate-x-2.5 rotate-[-8deg] scale-80 items-center justify-center rounded-full bg-transparent text-muted-foreground opacity-0 transition-all duration-300 hover:bg-muted hover:text-foreground focus-visible:pointer-events-auto focus-visible:translate-x-0 focus-visible:translate-y-0 focus-visible:rotate-0 focus-visible:scale-100 focus-visible:opacity-100 group-focus-within/composer:pointer-events-auto group-focus-within/composer:translate-x-0 group-focus-within/composer:translate-y-0 group-focus-within/composer:rotate-0 group-focus-within/composer:scale-100 group-focus-within/composer:opacity-100 group-hover/composer:pointer-events-auto group-hover/composer:translate-x-0 group-hover/composer:translate-y-0 group-hover/composer:rotate-0 group-hover/composer:scale-100 group-hover/composer:opacity-100", children: _jsx(Icon, { className: "size-3" }) })) }));
}
function ChatThreadContent({ assistantName, allowAttachments, allowEdit, allowRegenerate, branchNavigation, busy, className, composerEnd, composerStatus, composerTools, components, disabled, emptyState, error, onBranchSelect, onBranchStart, onRegenerateMessage, }) {
    const labels = useLabels();
    const [composerRows, setComposerRows] = useState(2);
    const composerInputRef = useRef(null);
    const attachmentUploading = useAuiState((state) => (state.composer.attachments.some((attachment) => attachment.status.type === 'running')));
    const composerExpanded = composerRows > 2;
    const branchByMessageId = useMemo(() => new Map(branchNavigation.map((branch) => [branch.messageId, branch])), [branchNavigation]);
    const toggleComposer = () => {
        var _a;
        setComposerRows(composerExpanded
            ? 2
            : Math.ceil((Math.max(220, window.innerHeight * 0.5) - 6) / (14 * 1.4)));
        (_a = composerInputRef.current) === null || _a === void 0 ? void 0 : _a.focus();
    };
    const blocked = disabled || busy;
    return (_jsxs(ThreadPrimitive.Root, { "data-chat-ui": "chat-thread", className: cx('flex min-h-0 flex-1 flex-col', className), children: [_jsxs(ThreadPrimitive.Viewport, { className: "relative flex min-h-0 flex-1 flex-col overflow-y-auto bg-background", children: [_jsxs("div", { className: "flex-1 py-1.5", children: [_jsx(ThreadPrimitive.Empty, { children: _jsx("div", { className: "flex min-h-full items-center justify-center px-6 pb-24", children: emptyState !== null && emptyState !== void 0 ? emptyState : (_jsxs("div", { className: "max-w-md text-center", children: [_jsx("div", { className: "mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground", children: _jsx(Bot, { className: "size-6" }) }), _jsx("h3", { className: "text-lg font-medium text-foreground", children: labels.startConversation })] })) }) }), _jsx("div", { className: "mx-auto flex w-full max-w-[53rem] flex-col gap-0 px-6", children: _jsx(ThreadPrimitive.Messages, { children: ({ message }) => message.role === 'user'
                                        ? (_jsx(UserMessage, { allowEdit: allowEdit, branch: branchByMessageId.get(message.id), busy: blocked, components: components, messageId: message.id, onBranchSelect: onBranchSelect }))
                                        : (_jsx(AssistantMessage, { agentName: assistantName, allowRegenerate: allowRegenerate, branch: branchByMessageId.get(message.id), busy: blocked, components: components, messageId: message.id, onBranchSelect: onBranchSelect, onBranchStart: onBranchStart, onRegenerateMessage: onRegenerateMessage })) }) })] }), _jsx(ThreadPrimitive.ScrollToBottom, { "aria-label": labels.scrollToLatestMessage, title: labels.scrollToLatestMessage, className: "sticky bottom-3 z-10 mx-auto mb-3 flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground hover:text-foreground disabled:invisible", children: _jsx(ChevronDown, { className: "size-4" }) })] }), _jsx("div", { className: "shrink-0 bg-background pb-3", children: _jsxs("div", { className: "mx-auto w-full max-w-[53rem] px-6", children: [error ? (_jsx("div", { role: "alert", className: "mb-2 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300", children: error })) : null, _jsx(ComposerPrimitive.Root, { "data-ui": "chat.composer", className: "group/composer relative rounded-[20px] border-[0.5px] border-border bg-card pt-2 shadow-sm transition-all duration-200 ease-in-out hover:border-foreground/25 focus-within:border-foreground/25", children: _jsx(ComposerPrimitive.AttachmentDropzone, { asChild: true, children: _jsxs("div", { className: "contents", children: [_jsx(ComposerExpand, { expanded: composerExpanded, onToggle: toggleComposer }), _jsx("div", { className: "flex flex-wrap gap-1.5 px-[15px] empty:hidden", children: _jsx(ComposerPrimitive.Attachments, { children: ({ attachment }) => _jsx(ComposerAttachment, { attachment: attachment }) }) }), _jsx(ComposerPrimitive.Input, { ref: composerInputRef, placeholder: labels.messagePlaceholder, disabled: blocked, rows: 2, minRows: composerRows, submitMode: "enter", className: cx('block min-h-[46px] w-full resize-none overflow-y-auto bg-transparent pb-0 pl-[15px] pr-11 pt-1.5 text-sm leading-[1.4] text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60 [&::-webkit-scrollbar]:w-[3px]', composerExpanded ? 'max-h-[max(220px,50vh)]' : 'max-h-[max(220px,40vh)]') }), _jsxs("div", { className: "relative z-[2] flex min-h-10 items-center justify-between gap-4 px-2 py-[5px]", children: [_jsxs("div", { className: "flex min-w-0 items-center gap-1.5", children: [_jsx(AttachmentPicker, { disabled: blocked, enabled: allowAttachments }), composerTools, composerStatus ? _jsx("div", { className: "min-w-0 text-[11px] text-muted-foreground", children: composerStatus }) : null] }), _jsxs("div", { className: "flex shrink-0 items-center gap-2", children: [composerEnd, _jsx(ThreadPrimitive.If, { running: false, children: _jsx(ComposerPrimitive.Send, { disabled: blocked || attachmentUploading, "aria-label": labels.send, title: attachmentUploading ? labels.processing : labels.send, className: "mr-0.5 mt-px flex size-[30px] shrink-0 items-center justify-center text-brand transition-all duration-200 disabled:cursor-not-allowed disabled:text-muted-foreground/50", children: _jsx(Send, { className: "size-[22px]" }) }) }), _jsx(ThreadPrimitive.If, { running: true, children: _jsx(ComposerPrimitive.Cancel, { "aria-label": labels.stop, title: labels.stop, className: "flex size-[30px] shrink-0 items-center justify-center rounded-full text-destructive hover:bg-muted", children: _jsx(CirclePause, { className: "size-5" }) }) })] })] })] }) }) })] }) })] }));
}
export function ChatThread(_a) {
    var { runtime, assistantName, allowAttachments = false, allowEdit = false, allowRegenerate = true, branchNavigation = [], busy = false, disabled = false, labels: labelOverrides, transformUserText = (text) => text } = _a, props = __rest(_a, ["runtime", "assistantName", "allowAttachments", "allowEdit", "allowRegenerate", "branchNavigation", "busy", "disabled", "labels", "transformUserText"]);
    const labels = useMemo(() => (Object.assign(Object.assign({}, chatThreadDefaultLabels), labelOverrides)), [labelOverrides]);
    return (_jsx(LabelsContext.Provider, { value: labels, children: _jsx(UserTextTransformContext.Provider, { value: transformUserText, children: _jsx(AssistantRuntimeProvider, { runtime: runtime, children: _jsx(ChatThreadContent, Object.assign({}, props, { assistantName: assistantName, allowAttachments: allowAttachments, allowEdit: allowEdit, allowRegenerate: allowRegenerate, branchNavigation: branchNavigation, busy: busy, disabled: disabled })) }) }) }));
}
