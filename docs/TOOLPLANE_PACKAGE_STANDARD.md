# ToolPlane Package Standard

This standard defines the only external package contract accepted by ToolPlane Resource Center.

## Import sources

A package is imported from one of:

- A public GitHub repository pinned to an immutable 40-character commit:
  `https://github.com/<owner>/<repo>[.git]#<40-hex-commit>`
- A ZIP archive that contains the package manifest and resource files.

The importer previews the package, validates its manifest, scans paths and dependencies, computes a source digest, and only then permits release submission. ZIP packages are treated as executable code and require explicit workspace-owner or administrator trust.

## Package layout

The archive root must contain:

```text
toolplane-package.json
resources/
  <resource-id>/
    manifest.json
    files/...
```

The manifest must conform to `docs/toolplane-package.schema.json` and include:

- `schemaVersion: 1`
- `kind: "toolplane-package"`
- a stable lowercase `id`
- a SemVer `version`
- `name`, `summary`, and optional `description`
- optional `author`, `license`, and `tags`
- at least one resource

Each resource declares an `id`, one supported `kind` (`skill`, `mcp`, `pi-package`, `agent`, or `assistant`), and its manifest path.

## Safety and compatibility

Packages must be self-contained, use UTF-8 text for manifests, and avoid absolute paths, traversal segments, symlinks, duplicate entries, private-network downloads, install hooks, and unpinned dependencies. A package must declare every runtime file it needs. ToolPlane stores the source URL or ZIP digest with the release so the reviewed artifact can be reproduced.

## Submission flow

1. Build the package using this layout and validate the manifest against the schema.
2. Import it from GitHub or ZIP in **Resource Center → Import**.
3. Resolve preview warnings and review the captured file list and digest.
4. Submit a private release for review or explicitly request public review.
5. Publish later versions by importing another immutable GitHub revision or ZIP.

Local MCP, Agent, Assistant, and ad-hoc Pi composition forms are not package sources. Existing deployments remain available for use and management; new distributable capabilities enter through this package contract.
