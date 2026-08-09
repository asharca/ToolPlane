import { ImageResponse } from 'next/og';

export const alt = 'ToolPlane — self-hosted agent control plane';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#10141d',
          color: '#f4f7f8',
          padding: '72px 80px',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <div
            style={{
              width: 72,
              height: 72,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 18,
              background: '#25c7b1',
              color: '#10141d',
              fontSize: 42,
              fontWeight: 800,
            }}
          >
            T
          </div>
          <div style={{ display: 'flex', fontSize: 48, fontWeight: 700 }}>
            Tool<span style={{ color: '#aeb7c3' }}>Plane</span>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div style={{ maxWidth: 940, fontSize: 68, fontWeight: 800, lineHeight: 1.08 }}>
            Your agents. Your tools. Your infrastructure.
          </div>
          <div style={{ maxWidth: 900, color: '#aeb7c3', fontSize: 30, lineHeight: 1.4 }}>
            Operate MCP runtimes, skills, toolkits, sandboxes, and observability from one self-hosted workspace.
          </div>
        </div>
      </div>
    ),
    size,
  );
}
