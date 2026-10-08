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

The MCP list uses a single search/status-filter row, including needs-configuration
resources. Lifecycle actions and a direct Logs link remain visible beside each
server; restart and confirmed removal use the existing Popover. Batch actions
appear only after selection; creation links appear once above the list.
The MCP list fills the remaining workspace viewport with an independently scrolling
table and a bottom pagination bar, including empty and single-page results. Pages
contain 20 servers; changing search or status returns to page one, and removals
clamp the current page to the remaining results.
The creation modal is a single-column JSON form without a speculative endpoint
preview. Examples, optional files, and network controls use BouncyAccordion;
the collapsed network summary shows the selected mode and preserves FormData.
Trust warnings, remote HTTP warnings, validation, and the fixed footer remain.
The deployment inspector keeps status and lifecycle actions in a compact header.
Overview shows connection details before README content; restart and rebuild live
in Settings maintenance. Configuration, variable, and runtime-file save semantics
and secret-reveal boundaries are unchanged.
Every deployed MCP uses its own runtime for manual tool calls, including stdio,
Docker, remote and marketplace-installed deployments. The tools tab and individual
tool detail reuse the same direct invocation form; no additional sandbox connection
is required. Installed marketplace resources link to that deployment. Undeployed
marketplace recipes/schema and explicit sandbox Inspector flows remain separate.

Installed skills use name/slug/description search and 20-item pages. Bulk removal
only targets visible valid selections and is unavailable when any selected skill
is market-managed; those resources link to market installation management.
Skill details put SKILL.md before collapsed properties and read-only bundled files.
Catalog content remains read-only; workspace, GitHub, and uploaded skills retain editing.
Each add-skill source has a back action that discards that source's draft; pending
submissions disable return and submit. Failed actions retain entered values and
show localized errors. Preview and copy use the current editor draft; downloads
use persisted SKILL.md. Saved feedback applies only to the successfully submitted
content and clears when the draft changes. Editable drafts use the textarea's LF
line endings so persisted multipart CRLF content also reports successful saves.
Content and market-modified status save in the same transaction, with workspace
ownership and catalog read-only guards.

MCP and Skill marketplaces use compact resource rows with actions that wrap on
narrow screens. Skill source/install/sort filters stay mounted in a collapsed
accordion; its summary reflects applied GET parameters, and source/install filters
remain catalog-only. Skill and Connector detail actions appear after the summary,
before metadata and long content. Updated installations keep their management link
and modified Skill updates still require explicit overwrite confirmation. Ordinary
MCP Server listings remain documentation/schema-only, without installation actions.

The admin console reuses the same `WorkspaceShell` composition as the workspace
console (`AdminChrome`), so sidebar collapse, mobile drawer, content scrolling,
and theming stay identical across both surfaces. Admin pages keep
`AdminPage/Header/Panel` semantics inside that shell.

Workspace observability defaults to request logs (`tab=audit` remains supported).
One GET form owns keyword/server filtering; cursor links retain the time window,
while apply and tab changes reset pagination. Failed/slow filters apply only to the
loaded page. Request summaries explicitly describe loaded records, errors use danger
badges, and expanded payloads support formatted copying only when data is available.

The A2A tab is separate from deployment MCP request summaries and usage charts.
It defaults to 24-hour request events, uses server-side workspace-scoped filters,
and switches metric labels to event counts/elapsed time for task-chain queries.
Its detail route shows metadata and the scoped trace, never body data; only an
administrator with workspace access sees a link to the separately audited admin
body view. Expired A2A bodies cannot be restored from task snapshots.

Empty results retain refresh controls. Deployment request polling can be paused
without pausing lifecycle refresh or manual refresh. Deployment logs are two peer
navigation items: MCP call logs (`?tab=logs`) and runtime logs (`?tab=runtime`).
Only the selected log view is loaded and mounted; runtime output no longer precedes
call records. Restart/rebuild and runtime-error links open the runtime view directly.
Runtime logs retain the existing stderr-only endpoint, cursor/generation protocol,
polling cadence, and UTF-8-safe 512 KiB tail. Local controls filter retained lines,
toggle wrapping, and copy visible text. Scrolling up pauses following, not polling;
filtering disables following and clearing a filter requires explicitly resuming it.
Sync failures retain collected output and show a notice outside the log viewport.

All application tables use `DashboardTable` and the reference [Table Bulk Actions](https://beui.dev/components/motion/table).
Selection replaces column controls with a localized count, clearing, and existing domain
actions, preserving column widths, order, and sorting. The shared `selectionActions` API
receives selected rows and ids in current sort order, excluding ids absent from the data;
clearing also removes hidden ids. MCP, installed skills, and Pi runtime management retain
their existing removal or update actions. Read-only tables offer selection and clearing
without new mutation endpoints. Mobile bulk controls wrap within the visible viewport;
tables scroll horizontally. Parameter schemas use the same renderer, retaining full JSON.
The adapter passes the reference `rounded-2xl` to Table and clips its horizontal-scroll
wrapper with the same radius. The selection column retains a 48px minimum width;
header and row checkboxes use the same intrinsic size and share a centered axis.
The scroll viewport and body isolate stacking contexts. The entire sticky header forms
a higher layer, including bulk actions, so animated row badges cannot paint over it.

Workspace pages do not render a breadcrumb bar or reserve its former row.
Detail pages retain their content headings and actions; `DashboardHeader` only
supplies a screen-reader heading for pages without a visible level-one heading.

`WorkspaceShell` owns the outer surface, corners, and tab-to-content join. The
shared `ChatApp` adapter for Agents and Assistants must not add another outer
border or rounded frame: its top border would separate the active tab from the surface.
The sidebar workspace switcher's list hides native scrollbars, including on hover,
while retaining scrolling when the list exceeds its maximum height. Workspace
content containers and other popovers retain their existing scrollbar behavior.
The workspace tab strip places its new-tab button immediately after the last tab;
header controls remain right-aligned, and overflowing tabs scroll independently.

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
The shared reasoning viewport grows with its content up to 208px instead of reserving
208px for short live activity, so streamed answers do not follow an empty block.
Completed collapsed activity occupies no content height and can still be reopened.
`MessageScroller` handles content growth and reader-aware following natively. Its
`followOutput`/`onFollowChange` props preserve a reader's scroll-up position and
resume following on explicit send or retry; no per-token manual scrolling is added.
The shared model picker follows the Registry [Model Selector](https://asharca.github.io/ui/components/blocks/model-selector).
Its `sm`, `md` (default), and `lg` panels are 320 × 360, 400 × 440, and 480 × 520,
bounded by the viewport. Provider groups share one scrolling list with slim,
theme-aware scrollbars. Search matches model names, providers, and capability labels;
Arrow keys and Page Up/Down move the highlight while Enter selects and Escape dismisses.
After 1.5 seconds of hover, a floating detail card shows the full model name,
provider, capabilities, and known input/output prices. Rows retain compact rates
formatted as `5$↓/10$↑` per million tokens; missing or invalid rates are omitted,
and zero remains visible. Provider identity, uncached current models, pending-state
selection guards, errors, and configuration actions remain in the domain adapter.
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
Hermes thinking effort opens the Registry `RangeSlider` with six stepped
intensity levels and a separate Default action; keyboard and drag input stay
available in the composer.
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
with more viewport space. Existing editor and composer triggers remain unchanged;
the search, model list, and optional error/configuration footer are separate regions.
Provider groups are not collapsible. Truncated names remain accessible to assistive
technology and are shown in full in the floating hover details.

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
