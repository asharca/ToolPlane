# Workspace Resource Center

> **中文**：[资源中心](./RESOURCE_CENTER.md)

This guide covers the signed-in workspace console. `{workspace}` is the workspace slug.

## Routes

| Surface | Route |
|---|---|
| Discover resources | `/app/{workspace}/market` |
| Workspace resources | `/app/{workspace}/market/installed` |
| Available updates | `/app/{workspace}/market/installed?updates=1` |
| My publications | `/app/{workspace}/market/publish` |
| Import and publish entry | `/app/{workspace}/market/import` (`?type=skill`, `?type=pi`, or `?type=mcp`) |
| Listing details | `/app/{workspace}/market/items/{namespace}/{listingSlug}` |
| Focused Pi package catalogue | `/app/{workspace}/market/pi-packages` |
| Package assembly and authoring | `/app/{workspace}/market/compose` |
| Package sources and credentials | `/app/{workspace}/market/sources` |
| Read-only Toolkit history | `/app/{workspace}/toolkits` and `/app/{workspace}/toolkits/{slug}` |

The workspace shell has three equal primary entries: Assistants (`/app/{workspace}/chat`), Agents (`/app/{workspace}/agents`), and Resource Center (`/app/{workspace}/market`). Workspace page tabs, notifications, workspace switching, and account controls remain available. Knowledge and Logs remain secondary entries. Workspace Settings links to the existing Members, model providers/credentials, shared MCP connections, and resource source pages; platform administrators additionally see the real `/admin/settings` limits page. Workspace members do not edit platform quotas.

The Resource Center is the cross-type catalogue for MCP, Skills, Pi packages, Agent presets, and Assistant presets. Toolkit is no longer a selectable resource product; the historical `/market/toolkits` discovery URL redirects to Pi package discovery, without an execution compatibility endpoint. Historical `/toolkits/pi-packages` and `/toolkits/pi-packages/sources` bookmarks redirect to the real Resource Center authoring and source pages; active navigation uses the new routes.

## Discover, install, and manage

Use Discover's single filter panel to search by resource type, source, and compatible target (`target=agent` or `target=assistant`). Search stays visible while the keyboard-accessible filter panel can collapse on narrow screens. Agent results exclude Assistant presets and retired Toolkits; Assistant results include Assistant presets and remote Streamable HTTP/SSE MCP, never Skills, Pi packages, or Prompt imports. Release-specific runtime metadata remains visible on cards when supplied. Workspace configuration state is distinct from runtime state; installing a resource is not evidence of a running execution.

Workspace resources lists workspace installations; Updates filters that lifecycle view to installs with available updates; My publications lists this workspace's publication entries, including private items and public submissions under review, and continues to the matching publication flow. A workspace install is not an Agent binding or proof that an MCP process is configured, tested, or running. A Skill's agent-invocable flag is not an Agent binding. Assistants only configure remote MCP; they do not import Prompt resources or install Pi packages.

Changing a workspace Pi installation's version does not automatically change any Agent default. Only explicitly applying an approved release to a selected Agent through `/app/{workspace}/market/installed/{installId}/configure?releaseId={approvedReleaseId}` changes that Agent's default for new sessions; other Agents remain unchanged, and existing sessions keep their locked version snapshots.

Before an update or rollback, the UI identifies the current and target versions and release notes, then shows bounded file-path changes, permission and environment-key changes, transport/runtime-compatibility changes, and whether configuration changed; impact copy distinguishes the workspace install, Agent defaults, and existing session versions. Review and acknowledge the impact, then confirm; only approved releases from the same listing are selectable. The diff contains no file contents or secrets, and locally edited Skills are guarded rather than silently overwritten.

## Import and publication

Open `/market/import` from the signed-in workspace route and choose Skill, Pi, or MCP. The page presents inline source-specific forms: Skill and Pi sources can be previewed before import or publication, while the Create workspace MCP form deploys a workspace configuration. Import, installation, configuration, and Agent enablement remain distinct steps.

Pi Agent presets use the real publication flow linked from My publications at `/app/{workspace}/agents/{agentId}/publish`. The workspace owner reviews the portable definition, chooses categories, and explicitly confirms public contents before submitting an immutable release for administrator review. Installing an approved preset creates a fresh Pi Agent draft: credentials and capability authorization must be reviewed, and a revision explicitly applied before work starts. Publishing or installing a preset never resumes retired runtime sessions or makes historical files/messages writable.

### Skills

The Skill flow accepts folder and ZIP uploads and GitHub sources. Preview is non-mutating; a ZIP preview lists root Skills so you can choose which to import. Import revalidates the source, rejecting changed bytes or a stale preview instead of silently importing a different archive. Imported Skills remain workspace resources; the Skill detail's Enable for Agent flow explicitly binds one selected Agent without replacing its other resources. Public publication follows a separate review flow.

### Pi packages

Pi intake supports npm, Git, and ZIP source preview and publication, plus composition from existing workspace resources. Private workspace use requires explicit owner/admin code-trust consent; ZIP sources also require explicit execution consent. This trust is workspace-only, not public human review or official-directory validation. Public submissions enter human review. An approved private release can be submitted with new listing metadata as a separate public listing using its frozen release; the private listing does not simply change visibility.

Selecting Submit new version in My publications opens the inline `/app/{workspace}/market/import?type=pi&listingId={listingId}` route and preserves the listing identity. Updating a workspace installation alone does not change Agent defaults. Package setup can explicitly Review and Apply the package and its listed MCP tools to one selected Agent, using its current applied revision as the baseline and rejecting a stale expected revision. The new immutable default applies to new sessions only; other Agents, existing sessions, and unrelated draft edits remain unchanged. An Agent without an applied revision must first prepare, review and apply its configuration from the linked Agent page, then reload package setup. Existing or reused shared MCP configuration must be changed through its affected-object confirmation flow, not silently through package setup.

This shared-connection restriction does not forbid retrying configuration of a connection created by the same package-setup operation: the acting user must still own it, and it must remain unshared. Reuse outside that operation, or a connection now referenced by other objects, requires the normal shared-connection impact review rather than a package-setup configuration write.

Catalog source imports also require a source preview and its immutable `sourceDigest`, with explicit execution consent. Upstream recapture links to the full publication preview page rather than submitting an unreviewed one-click capture.

Capture and assembly forms preserve selected files and entered metadata when submission is refused, so missing fields can be corrected without re-uploading. A source-change or stale-preview refusal invalidates the preview and disables capture submission until the current source is previewed again.

### MCP

`/app/{workspace}/market/import?type=mcp` provides an inline workspace MCP JSON deployment form. Stdio recipes use `command`, `args`, and environment variables; remote MCP uses Streamable HTTP or SSE endpoints with optional authentication. HTTPS is recommended. HTTP requires the installing user to separately check explicit plaintext-risk consent; a recipe or imported JSON flag is not consent. An unapproved connection remains in setup-required state and can be explicitly approved on its detail page; approval does not automatically start execution. HTTP may expose authentication headers, tool arguments, and results, so use it only on an assessed trusted isolated network or a tunnel covering the full connection. Private targets still require the administrator's allowlist; restricted-address checks, DNS validation and pinning, same-origin checks, and redirect rejection remain unchanged.

Configuration, environment variables, runtime files, and tool-exposure settings affect shared connections. Before saving, the UI displays the IDs of the Agents and Assistants actually referencing the connection and requires explicit confirmation. If concurrent changes alter that set, the server refuses the write and returns the latest objects for renewed confirmation. Editing a shared connection does not expand individual objects' tool permissions. The environment editor receives only key names and configured-state metadata, never saved secret values.

Protocol discovery performs a real handshake and reads catalogs; it does not call business tools or grant tool authorization. Assistants use remote MCP only; Agents may use remote connections or stdio in an isolated runtime. Creating or installing MCP does not bind or authorize it: the target and tools must be explicitly chosen. Standalone MCP discovery uses its registered runtime and does not automatically create an extra sandbox.

Connection details provide target selection, real protocol discovery, per-tool authorization, and application. The Agent branch reuses single-resource source review and application: controlled temporary isolated inspection inherits the target default Docker sandbox constraints without starting that template sandbox or requiring a running shared MCP process. Its server-signed review receipt binds the user, workspace, target, expected revision, and actual source. Unpublished Agents must prepare and publish a revision first. Switching targets or rediscovering clears selected tools; unchecked tools are never automatically authorized. Expired reviews, changed sources, and revision conflicts require fresh review. Assistants appear only for actual remote connections and retain their independent remote discovery and authorization flow without a sandbox. Applying updates only the chosen object's new default revision, preserves other connections and configuration, and uses the expected revision to reject concurrent overwrites; existing sessions keep their pinned revision. Shared connection tool exposure remains an independent ceiling and is never silently widened by application.

Pi package MCP requirements use the selected Agent's existing sandbox; that runtime must be running and its network cannot be `none`. The flow does not silently change sandbox settings. Exact npm/PyPI versions and Git commits are pinned recipes, not byte-locked transitive dependencies or wrapper images; Docker image references require a digest. Provide credentials through private configuration; they are not included in portable exports.

## Client registrations and historical Toolkit cutover

External access uses scoped, revocable registrations, not Toolkit execution endpoints. `GET /api/v1/pi-packages/registrations?workspace={workspace}` lists the signed-in account's registrations. `POST /api/v1/pi-packages/registrations` takes `workspace`, `client`, `label`, `bindings`, and exactly one of `marketInstallId` or `selections`; each explicit selection contains a fixed `releaseId`, `checksum`, and `kind` (`skill`, `mcp`, or `pi-package`). Private token/configuration is shown only at creation. Updating a registration requires its current integer `expectedConfigVersion` and explicit confirmation for expanded privileges; local installers must use the newly issued private configuration.

Historical Toolkit list/detail pages are read-only and do not create a default Toolkit, probe old runtimes, issue install links, or offer editing/publication. Conversion is an administrative dry-run/apply operation after active tasks drain: convertible capabilities freeze into a private package with source/audit records, old client tokens are revoked, and clients must register and authorize the new scopes explicitly. No public version is automatically republished, and no legacy execution shim is retained. This describes the cutover contract, not permission to perform a production migration.

## Downloads

- Skill download defaults to the complete ZIP archive at `/api/v1/skills/{id}/download` (`{slug}.zip`). The separate `/api/v1/skills/{id}/download?format=markdown` link downloads only the main `SKILL.md` as `{slug}.SKILL.md`; it does not include the Skill's other files.
- Pi package downloads use `/api/v1/workspaces/{workspace}/market/pi-packages/{releaseId}/download` and return a `.tgz` package archive, not a ZIP.

Use the format-specific action shown on the resource page; a Skill Markdown export and a complete Skill ZIP are intentionally different downloads.
