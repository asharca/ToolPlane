# @asharca/ui

Reusable React controls, chat thread, conversation sidebar, and responsive shell extracted from ToolPlane. Routing, persistence, authentication, and API handlers stay in the host application.

## Install

```bash
pnpm add @asharca/ui @assistant-ui/react@0.15.18
# or: npm install @asharca/ui @assistant-ui/react@0.15.18
```

The package uses React 19 and Tailwind CSS 4. `ChatThread` additionally accepts an assistant-ui `AssistantRuntime`, so transport and persistence stay in the host application.

The runtime peer is pinned to `@assistant-ui/react@0.15.18`, paired with
`@assistant-ui/react-streamdown@0.3.13`. These are the latest releases verified on
September 5, 2026. Older runtime versions are not supported. Hosts that also use
the Streamdown adapter should use `0.3.13` so the renderer and host share the same
assistant-ui context. No package patch or legacy runtime hook is required.

Import the stylesheet once from the host application's global Tailwind stylesheet:

```css
@import "tailwindcss";
@import "@asharca/ui/styles.css";
```

The package stylesheet uses Tailwind's `@source` directive to scan the emitted `dist` files. Importing only the React components will leave their utility classes ungenerated.

## Controls

Import lightweight controls without loading the chat runtime:

```tsx
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button, IconButton, Input, SearchInput } from '@asharca/ui/controls';

export function Toolbar() {
  const [query, setQuery] = useState('');
  return <>
    <Button variant="primary">Save</Button>
    <IconButton icon={<Plus />} label="Add item" />
    <Input name="title" aria-label="Title" />
    <SearchInput
      value={query}
      label="Search conversations"
      onChange={(event) => setQuery(event.target.value)}
      onClear={() => setQuery('')}
    />
  </>;
}
```

`Button` supports `primary`, `secondary`, `ghost`, `danger`, and `danger-secondary` variants, `sm`/`md`/`lg` sizes, a loading state, and `asChild` for framework links. Controls also include `Textarea`, `Select`/`NativeSelect`, `Checkbox`, `Radio`, and field labels/descriptions/errors. All controls forward native props and refs.

## Modules

- `@asharca/ui/controls` — buttons and native form controls.
- `@asharca/ui/forms` — submit, confirm-submit, and copy actions.
- `@asharca/ui/layout` — page, header, toolbar, section, panel, card, empty state, entity, and data table.
- `@asharca/ui/navigation` — tabs, chips, and pagination layout.
- `@asharca/ui/feedback` — badges, status, alerts, and spinners.
- `@asharca/ui/dialog` and `@asharca/ui/overlays` — Dialog, Popover, Tooltip, Context Menu, and Hover Card primitives.
- `@asharca/ui/chat-shell`, `@asharca/ui/chat-thread`, and `@asharca/ui/conversation-sidebar` — chat composition.
- The root export also includes `ToolPlaneLogo`, `ContentPage`, `RotatingHeadline`, `SafeStreamdown`, `Breadcrumbs`, `NavigationTabs`, and `WorkspaceTabBar`.

Next.js routing, translations, server actions, authentication, and domain data stay in the host. Pass those through children, labels, callbacks, and thin adapters.

## Example

```tsx
'use client';

import { useState } from 'react';
import {
  ChatShell,
  ChatThread,
  type ChatThreadProps,
  ConversationSidebar,
} from '@asharca/ui';

export function ChatPage({ runtime }: { runtime: ChatThreadProps['runtime'] }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobilePane, setMobilePane] = useState<'sidebar' | 'chat'>('sidebar');

  return (
    <div className="h-dvh">
      <ChatShell
        sidebar={(
          <ConversationSidebar
            groups={[]}
            onSelectConversation={() => setMobilePane('chat')}
          />
        )}
        header={<strong>Support assistant</strong>}
        sidebarOpen={sidebarOpen}
        onSidebarOpenChange={setSidebarOpen}
        mobilePane={mobilePane}
        onMobilePaneChange={setMobilePane}
        rightPanel={<div>Optional inspector</div>}
      >
        <ChatThread
          runtime={runtime}
          assistantName="Support assistant"
        />
      </ChatShell>
    </div>
  );
}
```

Build the runtime with AI SDK, assistant-ui local runtime, or another adapter in the host. `sidebarOpen` controls the desktop column. `mobilePane` controls whether narrow screens show the sidebar or the chat. Set `rightPanelOpen={false}` to keep the optional desktop right panel closed, and pass `sidebarLabel` when the sidebar needs a named complementary landmark.

`ChatThread` accepts an optional `components` map for host-specific rendering without replacing the thread layout. Use `AssistantText` for a custom Markdown renderer, `AssistantMessageBefore` / `AssistantMessageAfter` for per-message context, `AssistantActions` for extra message actions, and `SentAttachment` for a host preview flow.

`ConversationSidebar` conversations may also provide optional `meta` content and a `deleting` state, so hosts can keep domain badges and show async delete progress without replacing the list layout.

Theme defaults are scoped to package component roots. Override them with HSL-channel variables such as `--toolplane-ui-background`, `--toolplane-ui-foreground`, and `--toolplane-ui-brand`. The older `--chat-ui-*` variables remain supported; `--chat-ui-sidebar-width` and `--chat-ui-right-panel-width` still control chat layout. Add a `.dark` class to an ancestor, or `data-theme="dark"` to a component, to use the dark defaults.

## Build and pack

```bash
pnpm --filter @asharca/ui build
pnpm --dir packages/ui pack
```

## Release

This package is versioned independently from the ToolPlane application. To
release a new version, update `packages/ui/package.json`, commit and push the
changes, then tag that release commit. Replace `X.Y.Z` with the package version:

```bash
git tag ui-vX.Y.Z
git push origin ui-vX.Y.Z
```

The `publish-ui.yml` workflow builds and tests the tagged commit, then publishes
that exact version to npm with provenance. It does not merge branches or trigger
the ToolPlane application's separate `vX.Y.Z` release workflow. Published npm
versions are immutable; use a new version and tag for each release.

Publishing requires access to the `@asharca` npm scope. Configure npm trusted
publishing for `asharca/ToolPlane` and `publish-ui.yml`, allowing direct
publishing with `npm publish`. The workflow uses OIDC rather than a long-lived
npm token. No `NPM_TOKEN` or `NODE_AUTH_TOKEN` repository secret is needed.

## License

MIT. See [LICENSE](./LICENSE). This license applies only to `packages/ui`, not
to the rest of the ToolPlane repository.
