# Shared UI and CI

> **中文**：[UI_LIBRARY.zh-CN.md](./UI_LIBRARY.zh-CN.md)

The current beUI source is the Registry published at https://asharca.github.io/ui/llms.txt.
ToolPlane installs the original Registry component source under `src/components/` and
its required helpers under `src/lib/`. It keeps routing, authentication, API clients,
and business adapters in ToolPlane.

## Updating UI

Registry source is copied without theme or component overrides. Discover a component
from the original catalog, fetch its detail/source entry, review its dependencies and
merge the source into the matching `src/components/` or `src/lib/` path. Keep the
original `app/globals.css` token definitions and component motion behavior intact.

ToolPlane may add only domain adapters required to preserve server actions, FormData,
workspace ownership, streaming, or security boundaries. These adapters must not
redefine beUI styling or create a second generic component library.

The public homepage combines Registry badges, tilt cards, buttons, inputs, tabs,
and FAQ components. GitHub source links use `FaGithub` from `react-icons/fa`.
Keep the header's Popover trigger and button in the same client component tree
so cloning the trigger preserves event handlers through hydration.
The sticky header has a transparent outer shell and a translucent, backdrop-blurred card.
The homepage uses the original `ShaderBackground` metaballs variant at low opacity
and speed, fixed across the viewport behind all page content without intercepting
interaction. The site layout isolates this negative-z layer above its base background.
Reduced motion freezes the shader.
The public homepage (`/`) is fixed to dark mode, with 30% shader opacity. The shared
provider uses `forcedTheme` without changing the saved theme, and the shared theme
toggle is hidden while a theme is forced; other routes retain normal theme selection.

Center Morph Modal consumers use `CenterMorphModalContent`'s built-in close button
with a localized `closeButtonLabel`; do not replace it with a custom header button
or Escape listener. Footer cancel actions use `CenterMorphModalClose`. Keep unsaved-change
guards and open-state updates in `onOpenChange`. Defer navigation and parent removal to
`CenterMorphModalContent.onExitComplete`; this integration hook forwards the existing
`AnimatePresence` completion without changing the Registry animation or adding timers.
Pending operations may temporarily hide the native button and disable dismissal, without replacing it.
Reserve header space for the inset control; panels embedded inside a modal omit
their standalone close button.

The MCP list uses a single search/status-filter row and keeps only the lifecycle
action visible beside each server. Logs, restart, and confirmed removal live in
the existing Popover, opening toward the roomier half of the viewport. Batch
actions appear only after selection; creation links appear once above the list.
The creation modal is a single-column JSON form without a speculative endpoint
preview. Examples, optional files, and network controls use BouncyAccordion;
the collapsed network summary shows the selected mode and preserves FormData.
Trust warnings, remote HTTP warnings, validation, and the fixed footer remain.

Workspace pages do not render a breadcrumb bar or reserve its former row.
Detail pages retain their content headings and actions; `DashboardHeader` only
supplies a screen-reader heading for pages without a visible level-one heading.

`WorkspaceShell` owns the outer surface, corners, and tab-to-content join. The
shared `ChatApp` adapter for Agents and Assistants must not add another outer
border or rounded frame: its top border would separate the active tab from the surface.

Assistants follow the Agents sidebar layout: a compact add/list-options toolbar
above the resource tree, with new-chat actions on assistant rows. The list-options
popover contains left-aligned icon/text actions for expanding, collapsing, and
creating groups; it does not include search or an assistant-market link.
Conversation-row action menus contain only Delete chat; reorder conversations or
move them between assistants by dragging. Assistant and group menus are unchanged.
The assistant conversation model picker lives in the PromptInput bottom toolbar,
beside the tools button, rather than in the conversation header. It retains the
shared searchable, provider-grouped menu and shows the selected model on mobile.
The conversation composer retains horizontal alignment padding but no outer vertical
padding. Its input keeps the standard border with a transparent background and
automatically grows from two to eight rows; there is no manual expansion control.
Enabled web search remains visible as a pressed, primary-variant globe button,
even when it is not pinned. Disabling it removes the temporary shortcut; pinned
buttons remain in place with their inactive appearance. Toggling does not change
the saved toolbar configuration, and each send uses the current search state.
Assistant turns are owned and consumed by the server, not the browser connection.
Closing a tab or switching conversations does not stop model or web-search execution.
Reopening the active conversation resumes its stream without sending the prompt again;
completed answers are loaded from the database. Stop explicitly cancels the exact turn
and preserves its partial answer. Each thread admits only one running turn.
Execution still follows the existing five-minute turn deadline and workspace access checks.
Live replay is process-local on the single runtime owner (retained for 60 seconds after
settlement); this is not restart-resilient execution or automatic retry after a server crash.
Running conversations and their assistant icons show a green pulsing corner dot.
The authorized workspace status snapshot refreshes every two seconds while visible
and on returning to the tab. Completion, failure, or cancellation removes the dot;
reduced-motion users see a static green dot instead of the breathing animation.
Reasoning uses the original `AgentActivity` presentation. The conversation adapter
measures live reasoning time and supplies `duration`; the component does not run
its own timer. Restored reasoning without recorded timing uses an untimed summary
rather than claiming zero seconds. Only one pending-reply indicator is rendered,
yielding to the activity stream as soon as reasoning starts.
`MessageScroller` handles content growth and reader-aware following natively. Its
`followOutput`/`onFollowChange` props preserve a reader's scroll-up position and
resume following on explicit send or retry; no per-token manual scrolling is added.
The shared model menu is capped at 320px wide and 384px tall, without a title row. Each model occupies
one row with input/output prices formatted as `5$↓/10$↑` (per million tokens).
Unavailable input/output rates are omitted individually; zero rates remain visible.
Provider headers toggle drawers whose model lists scroll independently within
a 160px maximum height. Long model names truncate; names and capabilities remain
available on hover and to assistive technology.
Each assistant message uses one `StreamingResponse` surface for Markdown, tools,
and attachments, with live streaming/error/completion status and the component's
native copy, retry, and helpful/not-helpful buttons. Copy includes the full reply;
retry uses the existing regeneration path and is unavailable while blocked.
Feedback uses the component's local state, without server persistence. The response's
`actions` slot places branch navigation and new-branch controls alongside feedback,
without a separate assistant footer. User copy/edit and all branch controls match
the native feedback buttons: 28px, borderless, muted, with hover/focus states.
Only the last message's action row stays visible on hover-capable devices; earlier
rows reveal on message hover or keyboard focus, retaining space to avoid layout jumps.
Touch devices keep actions visible. Duplicate live announcements remain disabled
because the conversation log announces messages.

Agent Work conversations use the same `PromptInput`, `MessageGroup`, and
`StreamingResponse` presentation as Assistants: a shared max-w-3xl content width,
transparent two-to-eight-row composer, and native copy/feedback actions. The
existing Agent model selector sits beside the tools button; runtime-specific model
selection, approvals, command handling, and message timing remain unchanged.
The Work tools menu and toolbar customization omit New task, including previously
saved pins. The Agent sidebar retains its new-work action.
The Agent conversation header's right side contains only Files and Terminal when
a sandbox is attached. The left title and sidebar toggle remain unchanged.
Settings, execution status, cancel/start controls, and the context drawer are not
shown there; model/context controls remain in the composer, and Agent settings
remain in the sidebar action menu. Files and Terminal retain desktop drawers
and mobile dialogs.

Shared resource rows isolate their action controls, including portalled menu clicks
and double-clicks, from row selection, expansion, and rename. Tree keyboard shortcuts
apply only when the row itself is the event target; menu controls retain their own
keyboard activation and Escape dismissal.

The assistant editor uses left-aligned step navigation and rounded-xl fields,
with a viewport-bounded dialog and a scrolling form body. The shared model picker
uses a trigger-anchored Morph Popover (without a modal backdrop), choosing the side
with more viewport space. Compact rows show capability badges and input/output base
prices in $/M (USD per million tokens); missing prices show `—`, not zero. Opaque
provider headings toggle their model groups and show model counts. Search temporarily expands matching
groups, then restores their collapsed state when cleared. Header, search, and footer
remain separate from the scrolling list; long model names wrap on narrow screens.

The Agent editor uses a full-size, viewport-bounded settings dialog. Desktop navigation
is a flat list with one left-aligned item per row and no parent group headings;
mobile uses a native select without option groups. Forms show the active section
and auto-save status. Pi model and identity stay in Basic; sandbox and A2A settings
remain directly accessible from the same navigation.

Action buttons show either an icon alone (with an accessible label) or an icon
and label on one horizontal line. Mixed ReactNode labels in `StatefulButton`
use the same inline-flex layout for measurement and visible content; plain-text
labels retain their per-letter animation measurement.

Composer toolbar customization dialogs in Work and Agent conversations use padded,
non-scrolling headers and footers around a viewport-bounded scrolling list. Each row
aligns its drag grip, checkbox, icon, and clickable text label in that order,
without up/down buttons. Drag pinned rows onto one another to save their order;
unpinned rows cannot be reordered.
Keyboard users can focus a pinned checkbox and press Alt+Up/Down to reorder it.
Pinning and reset behavior remain unchanged.
Both surfaces use `ComposerToolbarCustomizer` for these controls while retaining
their own shortcut options and persistence. Their shared `ComposerToolsButton`
uses the reference PromptInput's circular size-8 trigger and rotates the plus
45 degrees when the tools menu opens, respecting reduced-motion preferences.
The tools popovers also follow PromptInput's native action-button layout: a fixed
muted icon column beside a left-aligned title and optional wrapping description,
with rounded hover/focus rows. Work's searchable tools popup is capped at 20rem
and the viewport width minus 2rem. Its header uses an integrated search input
with a search icon, not a separate pill field or decorative plus. Nested views
retain a back button, and keyboard selection, filtering and draft preservation
remain unchanged.

The `@asharca/ui` npm package is not used by the current Registry-source integration.
Do not reintroduce it unless the consuming project explicitly changes the source
strategy and migrates every Registry component back to a released package.

## CI and merging

Ordinary PRs, including stacked PRs, run the full [`ci.yml`](../.github/workflows/ci.yml) workflow. It can also be started manually. Merging into `main` does not repeat the full CI run because this workflow has no `push` trigger.

Same-repository release-please branches beginning `release-please--branches--` are an exception: `pull_request_target` validates that only `.release-please-manifest.json`, `CHANGELOG.md`, and `package.json` changed, then supplies the Connector gate results. It does not rerun application tests or Connector tests for that metadata-only PR. See [Releases](./RELEASES.md).

The workflow's check names are `validate`, `connector (ubuntu-latest)`, `connector (macos-latest)`, and `connector (windows-latest)`. Branch protection, required approvals, administrator bypasses, and restrictions on direct pushes or deletion are configured separately in GitHub repository rules; the workflow file alone does not establish or enforce those policies.

UI publishing validates the UI release in its own repository. ToolPlane's
`release-please.yml` application release flow and `vX.Y.Z` tags remain separate;
a normal feature merge does not publish a new UI package.
