export function securityHeaders(
  environment = process.env.NODE_ENV,
  allowSameOriginFrames = false,
  allowHttp = false,
) {
  const scriptPolicy =
    environment === "production"
      ? "script-src 'self' 'unsafe-inline'"
      : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
  const mediaProtocols = allowHttp ? "https: http:" : "https:";
  const contentSecurityPolicy = [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${allowSameOriginFrames ? "'self'" : "'none'"}`,
    "object-src 'none'",
    scriptPolicy,
    "connect-src 'self' http: https: ws: wss:",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${mediaProtocols}`,
    "font-src 'self' data:",
    `media-src 'self' data: blob: ${mediaProtocols}`,
    `frame-src 'self' blob: ${mediaProtocols}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join("; ");
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy },
    { key: "X-Content-Type-Options", value: "nosniff" },
    {
      key: "X-Frame-Options",
      value: allowSameOriginFrames ? "SAMEORIGIN" : "DENY",
    },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    },
  ];
}
