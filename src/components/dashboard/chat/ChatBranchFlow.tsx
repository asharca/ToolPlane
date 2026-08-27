'use client';

import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { graphlib, layout } from '@dagrejs/dagre';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
  type Viewport,
} from '@xyflow/react';
import {
  GitBranch,
  Maximize2,
  Minimize2,
  Split,
  Trash2,
  X,
} from 'lucide-react';
import type { ChatBranchNavigation } from '@/lib/chat/branches';

export type ChatBranchState = {
  activeMessageId: string | null;
  branchCount: number;
  navigation: ChatBranchNavigation[];
  nodes: ChatBranchNode[];
};

export type ChatBranchNode = {
  id: string;
  parentId: string | null;
  role: string;
  status: string;
  modelId: string | null;
  createdAt: string;
  preview: string;
  active: boolean;
  awaitingInput: boolean;
};

type BranchFlowNodeData = Record<string, unknown> & ChatBranchNode & {
  activeMessageId: string | null;
  busy: boolean;
  onDelete: (messageId: string) => void;
  onStart: (messageId: string) => void;
};

type BranchFlowNode = Node<BranchFlowNodeData, 'chatBranch'>;

const NODE_WIDTH = 220;
const NODE_HEIGHT = 106;

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function statusClass(status: string, awaitingInput: boolean) {
  if (awaitingInput) return 'bg-warning';
  if (status === 'pending') return 'bg-warning';
  if (status === 'failed' || status === 'cancelled') return 'bg-destructive';
  return 'bg-brand';
}

function BranchNode({ data }: NodeProps<BranchFlowNode>) {
  const t = useTranslations('console.chatAssistants');
  const date = new Date(data.createdAt);
  const time = Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const status = data.awaitingInput
    ? t('branchAwaitingInput')
    : data.status === 'pending'
      ? t('branchPending')
      : data.status === 'failed'
        ? t('branchFailed')
        : data.status === 'cancelled'
          ? t('branchCancelled')
          : t('branchCompleted');

  return (
    <div
      title={data.preview}
      data-message-id={data.id}
      data-active-path={data.active ? 'true' : 'false'}
      className={cx(
        'group/branch-node relative h-[106px] w-[220px] rounded-md border bg-card px-3 py-2 shadow-sm transition-[border-color,box-shadow,opacity]',
        data.role === 'user' ? 'border-brand/35 bg-brand-soft/35' : 'border-border bg-muted/35',
        data.awaitingInput && 'border-warning/60 bg-warning/10',
        data.id === data.activeMessageId && 'border-brand ring-2 ring-brand/20',
        !data.active && 'opacity-55 hover:opacity-100',
      )}
    >
      <Handle className="!size-1 !border-0 !bg-transparent" isConnectable={false} position={Position.Top} type="target" />
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium">
            {data.role === 'user' ? t('branchUser') : t('branchAssistant')}
          </span>
          {data.modelId ? <span className="truncate font-mono text-[9px] text-muted-foreground">{data.modelId}</span> : null}
        </div>
        <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/branch-node:opacity-100 group-focus-within/branch-node:opacity-100">
          {data.role === 'assistant' ? (
            <button
              type="button"
              disabled={data.busy}
              className="nodrag nopan flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
              aria-label={t('newBranch')}
              title={t('newBranch')}
              onClick={(event) => { event.stopPropagation(); data.onStart(data.id); }}
            >
              <Split className="size-3.5" />
            </button>
          ) : null}
          {data.awaitingInput ? (
            <button
              type="button"
              disabled={data.busy}
              className="nodrag nopan flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-destructive"
              aria-label={t('deleteEmptyBranch')}
              title={t('deleteEmptyBranch')}
              onClick={(event) => { event.stopPropagation(); data.onDelete(data.id); }}
            >
              <Trash2 className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>
      <p className="mt-2 line-clamp-2 min-h-8 text-[11px] leading-4 text-foreground">
        {data.awaitingInput ? t('branchAwaitingInputDescription') : data.preview}
      </p>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[9px] text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cx('size-1.5 shrink-0 rounded-full', statusClass(data.status, data.awaitingInput))} />
          <span className="truncate">{status}</span>
        </span>
        <time className="shrink-0" dateTime={data.createdAt}>{time}</time>
      </div>
      <Handle className="!size-1 !border-0 !bg-transparent" isConnectable={false} position={Position.Bottom} type="source" />
    </div>
  );
}

const nodeTypes = { chatBranch: BranchNode } satisfies NodeTypes;

function branchFlow(
  branch: ChatBranchState,
  busy: boolean,
  onDelete: (messageId: string) => void,
  onStart: (messageId: string) => void,
) {
  const graph = new graphlib.Graph()
    .setGraph({ rankdir: 'TB', nodesep: 48, ranksep: 72, marginx: 24, marginy: 24 })
    .setDefaultEdgeLabel(() => ({}));
  const ids = new Set(branch.nodes.map((node) => node.id));
  for (const node of branch.nodes) graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const node of branch.nodes) {
    if (node.parentId && ids.has(node.parentId)) graph.setEdge(node.parentId, node.id);
  }
  layout(graph);

  const nodes: BranchFlowNode[] = branch.nodes.map((node) => {
    const point = graph.node(node.id);
    return {
      id: node.id,
      type: 'chatBranch',
      position: { x: point.x - NODE_WIDTH / 2, y: point.y - NODE_HEIGHT / 2 },
      data: { ...node, activeMessageId: branch.activeMessageId, busy, onDelete, onStart },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      draggable: false,
      connectable: false,
      style: { width: NODE_WIDTH, height: NODE_HEIGHT },
    };
  });
  const activeIds = new Set(branch.nodes.filter((node) => node.active).map((node) => node.id));
  const edges: Edge[] = branch.nodes.flatMap((node) => {
    if (!node.parentId || !ids.has(node.parentId)) return [];
    const active = node.active && activeIds.has(node.parentId);
    const color = active ? 'hsl(var(--brand))' : 'hsl(var(--border))';
    return [{
      id: `${node.parentId}:${node.id}`,
      source: node.parentId,
      target: node.id,
      type: 'smoothstep',
      animated: active,
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      style: { stroke: color, strokeWidth: active ? 2.25 : 1.5, strokeDasharray: '4 4' },
    }];
  });
  return { nodes, edges };
}

function BranchCanvas({
  busy,
  flow,
  onSelect,
}: {
  busy: boolean;
  flow: ReturnType<typeof branchFlow>;
  onSelect: (messageId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);

  useEffect(() => {
    if (viewport || !flow.nodes.length) return;
    const frame = window.requestAnimationFrame(() => {
      const width = containerRef.current?.clientWidth ?? 0;
      if (!width) return;
      const root = flow.nodes.reduce((current, node) => {
        if (node.position.y !== current.position.y) return node.position.y < current.position.y ? node : current;
        return node.data.active && !current.data.active ? node : current;
      });
      const zoom = 0.85;
      setViewport({
        x: width / 2 - (root.position.x + NODE_WIDTH / 2) * zoom,
        y: 48 - root.position.y * zoom,
        zoom,
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [flow.nodes, viewport]);

  return (
    <div ref={containerRef} className="relative h-full min-h-0">
      {viewport ? (
        <ReactFlow
          colorMode="system"
          defaultViewport={viewport}
          nodes={flow.nodes}
          edges={flow.edges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesFocusable={false}
          elementsSelectable={!busy}
          minZoom={0.08}
          maxZoom={1.5}
          onNodeClick={(_event, node) => { if (!busy) onSelect(node.id); }}
          onlyRenderVisibleElements
        >
          <Background gap={18} size={1} color="hsl(var(--border))" />
          <Controls
            className="[&>button]:!border-border [&>button]:!bg-card [&>button]:!fill-foreground [&>button]:!text-foreground"
            position="bottom-left"
            showInteractive={false}
          />
          <MiniMap
            className="overflow-hidden rounded-md border border-border bg-card shadow-sm"
            nodeColor={(node) => node.data.role === 'user' ? 'hsl(var(--brand))' : 'hsl(var(--muted-foreground))'}
            maskColor="hsl(var(--background) / 0.72)"
            pannable
            position="bottom-right"
            style={{ height: 96, width: 128 }}
            zoomable
          />
        </ReactFlow>
      ) : null}
    </div>
  );
}

export function ChatBranchPanel({
  branch,
  busy,
  canMaximize = false,
  maximized = false,
  onClose,
  onDelete,
  onMaximize,
  onSelect,
  onStart,
}: {
  branch: ChatBranchState;
  busy: boolean;
  canMaximize?: boolean;
  maximized?: boolean;
  onClose: () => void;
  onDelete: (messageId: string) => void;
  onMaximize?: () => void;
  onSelect: (messageId: string) => void;
  onStart: (messageId: string) => void;
}) {
  const t = useTranslations('console.chatAssistants');
  const common = useTranslations('common');
  const flow = useMemo(() => branchFlow(branch, busy, onDelete, onStart), [branch, busy, onDelete, onStart]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex h-11 shrink-0 items-center justify-between px-3">
        <div className="flex min-w-0 items-center gap-2">
          <GitBranch className="size-4 text-muted-foreground" />
          <div className="min-w-0">
            <h2 className="truncate text-xs font-medium">{t('conversationBranches')}</h2>
            <p className="text-[10px] text-muted-foreground">{t('branchSummary', { branches: branch.branchCount, messages: branch.nodes.length })}</p>
          </div>
        </div>
        <div className="flex items-center gap-0.5">
          {canMaximize ? (
            <button type="button" onClick={onMaximize} aria-label={maximized ? t('restoreBranchPanel') : t('maximizeBranchPanel')} title={maximized ? t('restoreBranchPanel') : t('maximizeBranchPanel')} className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
              {maximized ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </button>
          ) : null}
          <button type="button" onClick={onClose} aria-label={common('close')} className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        {flow.nodes.length ? (
          <BranchCanvas busy={busy} flow={flow} onSelect={onSelect} />
        ) : (
          <p className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">{t('branchEmpty')}</p>
        )}
      </div>
    </div>
  );
}
