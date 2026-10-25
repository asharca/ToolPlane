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
| Unified package import | `/app/{workspace}/market/import` (fixed GitHub commit or ZIP; standalone Skill compatibility remains) |
| Listing details | `/app/{workspace}/market/items/{namespace}/{listingSlug}` |
| Pi package catalogue | `/app/{workspace}/market/pi-packages` (legacy entry) |
| Legacy package assembly | Redirects to `/app/{workspace}/market/import?type=pi` |
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

The unified intake is /app/{workspace}/market/import?type=pi. Package authors provide a GitHub repository URL with an immutable 40-character commit SHA, or upload a ZIP whose root contains one toolplane.json. ToolPlane previews the package, validates resource manifests, checks paths, checksums and secrets, and then creates an immutable imported version. Preview never executes extensions, starts MCP, creates Agent runtimes, or installs dependencies.

A package may contain Pi, MCP, Agent, Assistant, and Skill resources. Each resource continues to use its existing specialized manifest validator. Packages declare environment-variable names, exact dependency pins, and MCP tool allowlists only; they never contain API keys, private keys, workspace IDs, deployment IDs, provider IDs, conversation history, or runtime state. Installation binds models and credentials again in the target workspace, and Agents start in needs_setup.

These legacy entry points are disabled or redirected:

- /market/compose: redirects to Pi package intake and no longer composes a package from workspace Skills or MCP deployments.
- /market/import?type=mcp: no longer creates a workspace MCP deployment directly; MCP must come from a standard package.
- /market/publish: manages imported listings/releases only; it no longer publishes workspace MCP, Agent, Assistant, or other local resources.
- Pi npm source: no longer accepted as a user package import source. The official Pi catalogue's internal npm path remains available.

### Skills

The standalone Skill page may retain its existing GitHub/ZIP compatibility flow. The unified market intake no longer composes Pi packages from workspace resources. When a Skill is part of a standard package, place it under resources/skills/<id>/ and reference it from the root toolplane.json.

### Pi packages

Pi resources must use the existing pi-package manifest v1, with pinned runtime, Pi SDK, Node major, resource paths, and file checksums. Users import only from a fixed GitHub commit or a complete ZIP. ZIP imports require explicit executable-code trust; that trust is scoped to the workspace and is not public human review.

### MCP

MCP resources use the portable recipe. npm/PyPI dependencies use exact versions, GitHub uses a full commit, Docker uses a digest, and remote MCP uses HTTPS. Packages list only requiredEnv names and tool allowlists; users enter secrets during setup. Import does not start a deployment; target-workspace authorization is required.

### Agents and Assistants

Agents use the existing Agent release manifest v1 and Assistants use the existing Assistant market manifest v1. Manifests may declare prompts, model requirements, sub-agents, Skills, and verified MCP dependencies, but cannot contain workspace or runtime identities. Installation creates setup-required resources and asks the target workspace to authorize models, environment variables, and capabilities again.
## Client registrations and historical Toolkit cutover

External access uses scoped, revocable registrations, not Toolkit execution endpoints. `GET /api/v1/pi-packages/registrations?workspace={workspace}` lists the signed-in account's registrations. `POST /api/v1/pi-packages/registrations` takes `workspace`, `client`, `label`, `bindings`, and exactly one of `marketInstallId` or `selections`; each explicit selection contains a fixed `releaseId`, `checksum`, and `kind` (`skill`, `mcp`, or `pi-package`). Private token/configuration is shown only at creation. Updating a registration requires its current integer `expectedConfigVersion` and explicit confirmation for expanded privileges; local installers must use the newly issued private configuration.

Historical Toolkit list/detail pages are read-only and do not create a default Toolkit, probe old runtimes, issue install links, or offer editing/publication. Conversion is an administrative dry-run/apply operation after active tasks drain: convertible capabilities freeze into a private package with source/audit records, old client tokens are revoked, and clients must register and authorize the new scopes explicitly. No public version is automatically republished, and no legacy execution shim is retained. This describes the cutover contract, not permission to perform a production migration.

## Downloads

- Skill download defaults to the complete ZIP archive at `/api/v1/skills/{id}/download` (`{slug}.zip`). The separate `/api/v1/skills/{id}/download?format=markdown` link downloads only the main `SKILL.md` as `{slug}.SKILL.md`; it does not include the Skill's other files.
- Pi package downloads use `/api/v1/workspaces/{workspace}/market/pi-packages/{releaseId}/download` and return a `.tgz` package archive, not a ZIP.

Use the format-specific action shown on the resource page; a Skill Markdown export and a complete Skill ZIP are intentionally different downloads.
