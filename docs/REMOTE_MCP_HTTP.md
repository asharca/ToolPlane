# Remote MCP: HTTP compatibility and transport risks

> **中文**：[REMOTE_MCP_HTTP.zh-CN.md](./REMOTE_MCP_HTTP.zh-CN.md)

This guide is for users and administrators connecting ToolPlane to a remote MCP server. Remote MCP supports `https://` (recommended), `http://`, and explicit ports from 1 to 65535. In JSON configuration, `"type": "http"` selects Streamable HTTP; it does not require an unencrypted URL. HTTPS endpoints use the same type.

## HTTP example

```json
{
  "mcpServers": {
    "internal-mcp": {
      "type": "http",
      "url": "http://mcp.example.com:8000/mcp"
    }
  }
}
```

For authenticated servers, JSON import still supports Bearer authentication through `headers.Authorization`. Storing credentials in ToolPlane's managed variables does not encrypt the upstream HTTP connection.

## Risks users must understand

**HTTP provides no TLS encryption, server identity verification, or transport integrity.** Bearer tokens, other authentication headers, tool arguments, and results exchanged between ToolPlane and the remote MCP server may be intercepted or modified. Stolen credentials may be reused; modified tool results can also influence subsequent Agent behavior.

Prefer HTTPS. Use HTTP only after assessing a trusted, isolated network or an encrypted tunnel covering the entire connection. An internal network is not automatically safe. Avoid sending production credentials or sensitive data over unencrypted HTTP.

**HTTPS on the ToolPlane website does not protect the ToolPlane → upstream MCP HTTP connection.** A browser's secure-connection indicator says nothing about that upstream link.

The custom MCP deployment dialog displays a localized warning for HTTP URLs without blocking deployment. HTTPS remains the recommended example. The HTTP bridge also emits a startup warning that contains neither the endpoint URL nor authentication values.

## Security boundaries remain enforced

HTTP support does not allow arbitrary destinations. Private targets still require the administrator's private-host allowlist; localhost, loopback, link-local/cloud metadata, and other restricted addresses remain blocked. DNS validation and pinning, same-origin requests, and redirect rejection are unchanged.

Endpoint URLs cannot contain a username, password, query parameters, or a fragment. The existing query-parameter exception is limited to same-origin session POST URLs returned by SSE servers.

This is compatibility for explicitly configured HTTP endpoints, not an automatic HTTPS-to-HTTP fallback. OAuth TLS requirements are unchanged.
