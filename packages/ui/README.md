# @toolplane/ui

Reusable React controls, chat thread, conversation sidebar, and responsive shell extracted from ToolPlane. Routing, persistence, authentication, and API handlers stay in the host application.

## Install

```bash
pnpm add @toolplane/ui
# or: npm install @toolplane/ui
```

The package uses React 19 and Tailwind CSS 4. `ChatThread` additionally accepts an assistant-ui `AssistantRuntime`, so transport and persistence stay in the host application.

Import the stylesheet once from the host application's global Tailwind stylesheet:

```css
@import "tailwindcss";
@import "@toolplane/ui/styles.css";
```

The package stylesheet uses Tailwind's `@source` directive to scan the emitted `dist` files. Importing only the React components will leave their utility classes ungenerated.

## Controls

Import lightweight controls without loading the chat runtime:

```tsx
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button, IconButton, Input, SearchInput } from '@toolplane/ui/controls';

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

- `@toolplane/ui/controls` — buttons and native form controls.
- `@toolplane/ui/forms` — submit, confirm-submit, and copy actions.
- `@toolplane/ui/layout` — page, header, toolbar, section, panel, card, empty state, entity, and data table.
- `@toolplane/ui/navigation` — tabs, chips, and pagination layout.
- `@toolplane/ui/feedback` — badges, status, alerts, and spinners.
- `@toolplane/ui/dialog` and `@toolplane/ui/overlays` — Dialog, Popover, Tooltip, Context Menu, and Hover Card primitives.
- `@toolplane/ui/chat-shell`, `@toolplane/ui/chat-thread`, and `@toolplane/ui/conversation-sidebar` — chat composition.

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
} from '@toolplane/ui';

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
pnpm --filter @toolplane/ui build
pnpm --dir packages/ui pack
```

## Release

This package is versioned independently from the ToolPlane application, like
`packages/ai` in the Pi monorepo. To release a new version, update
`packages/ui/package.json`, merge it, and create a matching `ui-vX.Y.Z` tag.
The `publish-ui.yml` workflow builds and publishes that exact version to npm.

Before the first public release, the maintainer must verify ownership of the
`@toolplane` npm scope, add a license chosen by the copyright holder, and
configure npm trusted publishing for `asharca/ToolPlane` and
`publish-ui.yml`. The workflow uses OIDC rather than a long-lived npm token.
