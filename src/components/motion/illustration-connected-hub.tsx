"use client";
// asharca.github.io/ui/components/motion/illustration-connected-hub

import {
  Cable,
  Grid3X3,
  Network,
  Plug,
  UserRound,
  Workflow,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";

const paymentRings = [
  {
    radius: 157.5,
    width: 18.75,
    opacity: 0.72,
    color: "stroke-[#e7e8ec] dark:stroke-[#2a2e33]",
  },
  {
    radius: 125,
    width: 16.25,
    opacity: 0.74,
    color: "stroke-[#e4e6eb] dark:stroke-[#25292e]",
  },
  {
    radius: 92.5,
    width: 13.75,
    opacity: 0.76,
    color: "stroke-[#e1e4ea] dark:stroke-[#202429]",
  },
] as const;

export interface ConnectedHubNode {
  id: string;
  label: string;
  description: string;
  icon?: ReactNode;
  /** Which labelled output a node feeds in the routing composition (variant 4). */
  branch?: "api" | "mcp";
}
export interface ConnectedHubProps {
  variant?: 1 | 2 | 3 | 4;
  nodes: readonly ConnectedHubNode[];
  hubLabel: string;
  hubIcon?: ReactNode;
  label?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (id: string) => void;
  highlightedPaths?: readonly string[];
  className?: string;
}
/** Four public compositions: payment fan, workspace rail, user workflow, and API/MCP routing. */
export function ConnectedHub({
  variant = 1,
  nodes,
  hubLabel,
  hubIcon,
  label = "Connected services",
  value,
  defaultValue,
  onValueChange,
  highlightedPaths = [],
  className,
}: ConnectedHubProps) {
  const reduce = useReducedMotion();
  const [internal, setInternal] = useState(defaultValue ?? nodes[0]?.id);
  const active =
    nodes.find((node) => node.id === (value ?? internal)) ?? nodes[0];
  const hub =
    variant === 1
      ? { x: 200, y: 225 }
      : variant === 2
        ? { x: 200, y: 174 }
        : variant === 3
          ? { x: 200, y: 156 }
          : { x: 72, y: 150 };
  const points = nodes.map((_, index) => {
    if (variant === 1) {
      const angle =
        nodes.length === 1
          ? -Math.PI / 2
          : Math.PI * (1.1 + (0.8 * index) / (nodes.length - 1));
      return {
        x: 200 + Math.cos(angle) * 134,
        y: 205 + Math.sin(angle) * 132.5,
      };
    }
    if (variant === 2) {
      const offset = index - (nodes.length - 1) / 2;
      return { x: 200 + offset * 56 + Math.sign(offset) * 34, y: 174 };
    }
    if (variant === 3) {
      const offset = index - (nodes.length - 1) / 2;
      return { x: 200 + offset * 62.5 + Math.sign(offset) * 25, y: 228 };
    }
    return {
      x: 328,
      y: nodes.length === 1 ? 150 : 60 + (index * 180) / (nodes.length - 1),
    };
  });
  const path = (index: number) => {
    const point = points[index];
    if (variant === 1) return `M${point.x} ${point.y}Q${point.x} 213 200 225`;
    if (variant === 2) return `M${point.x} 65V174H200`;
    if (variant === 3) return `M200 156V194Q200 228 ${point.x} 228`;
    const branch = nodes[index].branch;
    const branchY =
      branch === "mcp"
        ? 110
        : branch === "api"
          ? 190
          : point.y > 150
            ? 190
            : 110;
    return `M72 150H145V${branchY}H245V${point.y}H328`;
  };
  return (
    <section
      aria-label={label}
      className={cn(
        "@container group relative isolate aspect-[4/3] w-full max-w-xl overflow-hidden rounded-2xl bg-muted text-foreground",
        className,
      )}
      data-hub-variant={variant}
    >
      {(variant === 1 || variant > 2) && (
        <div
          aria-hidden
          className="absolute inset-[5%] opacity-40 [background-image:radial-gradient(circle,var(--border)_1px,transparent_1px)] [background-size:12px_12px]"
        />
      )}
      <svg
        viewBox="0 0 400 300"
        className="absolute inset-0 size-full"
        aria-hidden="true"
      >
        {variant === 1 &&
          paymentRings.map((ring) => (
            <path
              key={ring.radius}
              d={`M${200 - ring.radius} 256.25a${ring.radius} ${ring.radius} 0 0 1 ${ring.radius * 2} 0`}
              fill="none"
              className={ring.color}
              strokeWidth={ring.width}
              opacity={ring.opacity}
            />
          ))}
        {variant === 3 && <path d="M200 57V156" stroke="var(--border)" />}
        {nodes.map((node, index) => (
          <g
            key={node.id}
            data-path={node.id}
            data-highlighted={
              active?.id === node.id || highlightedPaths.includes(node.id)
            }
          >
            <path
              d={path(index)}
              fill="none"
              stroke="var(--border)"
              strokeWidth={1.4}
            />
            <motion.path
              d={path(index)}
              fill="none"
              stroke={variant === 1 ? "#667cff" : "#0ea5e9"}
              strokeWidth={1.5}
              strokeDasharray="3 110"
              animate={
                reduce
                  ? { strokeDashoffset: 0 }
                  : { strokeDashoffset: [110, -110] }
              }
              transition={{
                duration: 4,
                delay: index * 0.7,
                repeat: reduce ? 0 : Infinity,
                ease: "linear",
              }}
              opacity={
                active?.id === node.id || highlightedPaths.includes(node.id)
                  ? 0.9
                  : 0.4
              }
            />
          </g>
        ))}
      </svg>
      {variant === 3 && (
        <span
          aria-hidden
          className="absolute left-1/2 top-[19%] grid size-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-2xl border border-border bg-background"
        >
          <span className="grid size-10 place-items-center rounded-full bg-sky-500/10 text-sky-500">
            <UserRound className="size-6" />
          </span>
        </span>
      )}
      {variant === 3 &&
        nodes.map(
          (node, index) =>
            index % 2 === 0 && (
              <div
                key={node.id}
                aria-hidden
                className="absolute z-[5] h-[66px] w-[122px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-background"
                style={{
                  left: `${(points[index].x + (points[index + 1]?.x ?? points[index].x)) / 8}%`,
                  top: "76%",
                }}
              />
            ),
        )}
      <div
        className={cn(
          "absolute z-20 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center border border-border bg-background",
          variant === 1
            ? "rounded-full p-2 shadow-sm"
            : variant === 2
              ? "size-20 rounded-full ring-1 ring-border ring-offset-[6px] ring-offset-muted"
              : variant === 3
                ? "size-16 rounded-2xl text-sky-500 ring-1 ring-sky-500/10 ring-offset-2 ring-offset-muted"
                : "size-[clamp(56px,20cqw,88px)] rounded-3xl",
        )}
        style={{ left: `${hub.x / 4}%`, top: `${hub.y / 3}%` }}
      >
        {variant === 1 ? (
          <span className="rounded-full border border-blue-300/50 bg-background/80 p-1.5">
            <span className="flex h-11 items-center rounded-full border border-blue-300/50 bg-[#6782f4] px-5 text-sm text-white">
              {hubLabel}
            </span>
          </span>
        ) : (
          <span
            aria-label={hubLabel}
            role="img"
            className={cn(
              "grid size-[75%] place-items-center [&_svg]:size-7",
              variant === 4 && "rounded-2xl bg-muted text-cyan-500",
            )}
          >
            {hubIcon ??
              (variant === 3 ? (
                <Workflow />
              ) : variant === 4 ? (
                <Grid3X3 />
              ) : (
                <Network />
              ))}
          </span>
        )}
      </div>
      {variant === 2 && (
        <p className="absolute left-1/2 top-[79%] min-w-28 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-background p-1">
          <span className="flex h-8 items-center justify-center rounded-full bg-muted px-4 text-xs font-medium">
            {hubLabel}
          </span>
        </p>
      )}
      {variant === 4 &&
        [
          { label: "MCP", y: 36.7, Icon: Cable },
          { label: "API", y: 63.3, Icon: Network },
        ].map(({ label, y, Icon }) => (
          <span
            key={label}
            className="absolute left-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2.5 rounded-full border border-border bg-background py-1.5 pl-1.5 pr-4 text-xs"
            style={{ top: `${y}%` }}
          >
            <span
              aria-hidden
              className="grid size-8 place-items-center rounded-full bg-muted"
            >
              <Icon className="size-3" />
            </span>
            {label}
          </span>
        ))}
      {nodes.map((node, index) => (
        <button
          type="button"
          key={node.id}
          aria-pressed={active?.id === node.id}
          aria-label={`Inspect ${node.label}`}
          onClick={() => {
            if (value === undefined) setInternal(node.id);
            onValueChange?.(node.id);
          }}
          className={cn(
            "absolute z-10 grid -translate-x-1/2 -translate-y-1/2 cursor-pointer place-items-center border border-border bg-background focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-7",
            variant === 1
              ? "size-20 rounded-full bg-[#f4f4f4] text-[#242424]"
              : variant === 2
                ? "size-14 rounded-full"
                : variant === 3
                  ? "size-12 rounded-xl border-0 bg-muted"
                  : "size-[clamp(56px,20cqw,88px)] rounded-3xl",
            active?.id === node.id && "border-primary ring-2 ring-primary/20",
          )}
          style={{
            left: `${points[index].x / 4}%`,
            top: `${points[index].y / 3}%`,
          }}
        >
          <span
            aria-hidden
            className={cn(
              variant === 4 &&
                "grid size-[clamp(42px,15.5cqw,68px)] place-items-center rounded-2xl bg-muted",
            )}
          >
            {node.icon ?? <Plug />}
          </span>
        </button>
      ))}
      <p
        aria-live="polite"
        className="absolute inset-x-3 bottom-2 rounded-full bg-background/90 px-3 py-2 text-center text-[max(11px,1.8cqw)] text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {active
          ? `${active.label} → ${hubLabel}: ${active.description}`
          : "No integrations supplied."}
      </p>
    </section>
  );
}
