# ToolPlane Package Migration Checklist

> **中文**：[TOOLPLANE_PACKAGE_MIGRATION.zh-CN.md](./TOOLPLANE_PACKAGE_MIGRATION.zh-CN.md)

When converting existing local capabilities into external packages, follow this checklist:

1. Put the implementation in a GitHub repository, or build a ZIP in the standard layout.
2. Add `toolplane-package.json` and validate it with `docs/toolplane-package.schema.json`.
3. Declare resources in `resources/<resource-id>/manifest.json`.
4. Remove secrets, workspace IDs, local database IDs, caches and machine paths.
5. Pin runtime and dependency versions; do not use install scripts or mutable branches.
6. Use a GitHub URL pinned to a 40-character commit, or produce a reproducible ZIP.
7. Import through "Resource Center → Import" and review the preview, source summary and security result.
8. Submit a private version first; request public review after confirming the contents.
9. Create a new package version for later updates and re-import the immutable source.
10. Keep the source repository and release notes so reviewers can reproduce the package.

The old local MCP, Agent, Assistant and Pi composition publishing entry points are retired. Existing resources remain usable and manageable; new distribution goes through the package standard boundary.
