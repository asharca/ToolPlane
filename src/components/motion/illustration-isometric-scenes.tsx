"use client";
// asharca.github.io/ui/components/motion/illustration-isometric-scenes

import { Boxes, CircleDot, FileText, Layers, Sparkles } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useState } from "react";
import { EASE_IN_OUT, EASE_OUT } from "@/lib/ease";
import { cn } from "@/lib/utils";

import { IllustrationPlaybackControl } from "./illustration-product-scene";

const towerTimes = [0, 0.22, 0.78, 1];
function towerBody(x: number, height: number) {
  return `M${x - 34} ${285 - height}l34-20 34 20v${height}l-34 20-34-20Z`;
}
function towerEdges(x: number, height: number) {
  return `m${x - 34} ${285 - height} 34 20 34-20m-34 20v${height}`;
}
function towerCap(x: number, height: number) {
  return `M${x - 34} ${285 - height}l34-20 34 20-34 20Z`;
}
export type IsometricSceneVariant = 1 | 2 | 3 | 4 | 5;
export interface IsometricSceneNode {
  id: string;
  label: string;
  detail: string;
}
export interface IsometricScenesProps {
  variant?: IsometricSceneVariant;
  nodes: readonly IsometricSceneNode[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (id: string) => void;
  label?: string;
  className?: string;
  autoPlay?: boolean;
}
const titles = {
  1: "Compute node",
  2: "Event queue",
  3: "Product capabilities",
  4: "Application runtime",
  5: "Crypto towers",
};
/** Original vector geometry, with supplied content and inspectable node identities. */
export function IsometricScenes({
  variant = 1,
  nodes,
  value,
  defaultValue,
  onValueChange,
  label,
  className,
  autoPlay = true,
}: IsometricScenesProps) {
  const [selected, setSelected] = useState(defaultValue ?? nodes[0]?.id);
  const [engaged, setEngaged] = useState(false);
  const [paused, setPaused] = useState(false);
  const reduce = useReducedMotion();
  const uid = useId();
  const running = autoPlay && !reduce && !engaged && !paused;
  const activeIndex = Math.max(
    0,
    nodes.findIndex((node) => node.id === (value ?? selected)),
  );
  const active = nodes[activeIndex];
  const select = (id: string) => {
    if (value === undefined) setSelected(id);
    onValueChange?.(id);
  };
  useEffect(() => {
    if (!running || value !== undefined || nodes.length < 2 || variant !== 2)
      return;
    const timer = window.setTimeout(
      () => setSelected(nodes[(activeIndex + 1) % nodes.length].id),
      8000 / nodes.length,
    );
    return () => window.clearTimeout(timer);
  }, [running, value, nodes, activeIndex, variant]);
  return (
    <section
      aria-label={label ?? titles[variant]}
      className={cn(
        "@container group relative isolate aspect-[4/3] w-full max-w-xl overflow-hidden rounded-2xl bg-muted text-foreground",
        className,
      )}
      data-scene={variant}
      onFocusCapture={() => setEngaged(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setEngaged(false);
      }}
    >
      {variant === 1 && (
        <svg
          viewBox="0 0 400 300"
          className="absolute inset-0 size-full"
          role="img"
          aria-labelledby={`${uid}-title`}
        >
          <title id={`${uid}-title`}>{label ?? titles[variant]}</title>
          <g
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.07}
            strokeWidth={1}
            strokeDasharray="6 8"
          >
            <motion.path
              d="M8 275 400 47"
              animate={
                running
                  ? { strokeDashoffset: [0, -28] }
                  : { strokeDashoffset: 0 }
              }
              transition={
                running
                  ? { duration: 4.8, repeat: Infinity, ease: "linear" }
                  : { duration: 0 }
              }
            />
            <motion.path
              d="M14 299 406 71"
              animate={
                running
                  ? { strokeDashoffset: [0, -28] }
                  : { strokeDashoffset: 0 }
              }
              transition={
                running
                  ? { duration: 5.6, repeat: Infinity, ease: "linear" }
                  : { duration: 0 }
              }
            />
          </g>
          {[
            { duration: 3.2, start: 8, end: 400, top: 275, bottom: 47 },
            { duration: 3.8, start: 14, end: 406, top: 299, bottom: 71 },
          ].map((lane, index) => (
            <motion.circle
              key={`${lane.start}-${lane.top}-${lane.end}-${lane.bottom}`}
              r={2}
              fill="currentColor"
              fillOpacity={0.25}
              animate={
                running
                  ? {
                      cx: [
                        lane.start,
                        lane.start + (lane.end - lane.start) * 0.06,
                        lane.start + (lane.end - lane.start) * 0.94,
                        lane.end,
                      ],
                      cy: [
                        lane.top,
                        lane.top + (lane.bottom - lane.top) * 0.06,
                        lane.top + (lane.bottom - lane.top) * 0.94,
                        lane.bottom,
                      ],
                      opacity: [0, 1, 1, 0],
                    }
                  : { cx: lane.start, cy: lane.top, opacity: 0 }
              }
              transition={
                running
                  ? {
                      duration: lane.duration,
                      delay: index * 0.8,
                      repeat: Infinity,
                      ease: "linear",
                      times: [0, 0.06, 0.94, 1],
                    }
                  : { duration: 0 }
              }
            />
          ))}
          <ellipse
            cx="210"
            cy="222"
            rx="94"
            ry="30"
            fill="currentColor"
            fillOpacity={0.035}
          />
          <g
            transform="translate(10 -13)"
            fill="var(--background)"
            stroke="currentColor"
            strokeWidth={1.35}
            strokeLinejoin="round"
          >
            <path d="M116 105v89q0 12 10 18l64 37q10 6 20 0l64-37q10-6 10-18v-89" />
            <path d="M123 96 190 57q10-6 20 0l67 39q14 8 0 16l-67 39q-10 6-20 0l-67-39q-14-8 0-16Z" />
            <path d="m116 151 84 49 84-49M200 200v50" fill="none" />
            <path
              d="m139 199 43 25m35 0 43-25"
              fill="none"
              strokeDasharray="4 5"
            />
            {[0, 1, 2, 3].map((index) => (
              <path
                key={index}
                d={`M${130 + index * 4} ${139 + index * 2.3}v${20 - index * 3}`}
              />
            ))}
            {[
              [200, 67],
              [151, 91],
              [251, 92],
              [200, 142],
            ].map(([x, y]) => (
              <circle
                key={`${x}-${y}`}
                cx={x}
                cy={y}
                r={2.1}
                fill="currentColor"
                stroke="none"
              />
            ))}
            {[0, 1, 2].map((index) => (
              <motion.circle
                key={index}
                cx={257 + index * 11}
                cy={141 - index * 6}
                r={3.1}
                fill="currentColor"
                stroke="none"
                animate={
                  running ? { opacity: [0.15, 0.65, 0.15] } : { opacity: 0.25 }
                }
                transition={
                  running
                    ? { duration: 2.4, delay: index * 0.3, repeat: Infinity }
                    : { duration: 0 }
                }
              />
            ))}
          </g>
        </svg>
      )}
      {variant === 2 && (
        <>
          <div
            aria-hidden
            className="absolute inset-0 opacity-40 [background-image:linear-gradient(var(--border)_1px,transparent_1px),linear-gradient(90deg,var(--border)_1px,transparent_1px)] [background-size:6cqw_6cqw] [mask-image:radial-gradient(ellipse,black,transparent_70%)]"
          />
          <div className="absolute left-1/2 top-1/2 flex w-[30%] -translate-x-1/2 -translate-y-1/2 flex-col gap-[1.12cqw]">
            {nodes.map((node, index) => (
              <motion.button
                type="button"
                key={node.id}
                aria-pressed={index === activeIndex}
                onClick={() => select(node.id)}
                initial={false}
                animate={{
                  opacity: index === activeIndex ? 1 : 0.2,
                  filter: index === activeIndex ? "blur(0px)" : "blur(1px)",
                }}
                transition={{ duration: reduce ? 0 : 0.3, ease: EASE_OUT }}
                className={cn(
                  "relative flex h-[8.9cqw] cursor-pointer items-center gap-[1.12cqw] rounded-[max(6.4px,1cqw)] border bg-background px-[3cqw] shadow-sm",
                  index === activeIndex
                    ? "border-sky-400/60 ring-2 ring-sky-400/10"
                    : "border-border",
                )}
              >
                <CircleDot
                  aria-hidden
                  className="size-[3cqw] shrink-0 text-muted-foreground"
                />
                <span aria-hidden className="flex-1 space-y-[1.5cqw]">
                  <span className="block h-[1.4cqw] w-1/2 rounded-full bg-sky-500/20" />
                  <span className="block h-[1.4cqw] w-full rounded-full bg-foreground/10" />
                </span>
                <span className="sr-only">{node.label}</span>
                {index === activeIndex && (
                  <span className="absolute -right-[1.5cqw] -top-[1.5cqw] grid size-[3.8cqw] place-items-center rounded-full bg-sky-500 text-[1.7cqw] text-white">
                    {index + 1}
                  </span>
                )}
              </motion.button>
            ))}
          </div>
        </>
      )}
      {variant === 3 && (
        <div className="absolute inset-x-[9%] inset-y-[7%]">
          <div
            aria-hidden
            className="absolute inset-y-0 left-1/2 w-px bg-border"
          />
          {nodes.map((node, index) => {
            const selected = index === activeIndex;
            const Icon = [FileText, Boxes, Sparkles, Layers][index % 4];
            return (
              <div
                key={node.id}
                className="relative"
                style={{ height: `${100 / Math.max(1, nodes.length)}%` }}
              >
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => select(node.id)}
                  className={cn(
                    "absolute top-1/2 flex h-[72%] -translate-y-1/2 cursor-pointer items-center gap-[2cqw] rounded-[2cqw] border bg-background px-[2cqw] text-[max(9.28px,2.4cqw)] transition-colors",
                    selected
                      ? "inset-x-[7%] h-[84%] border-teal-400 bg-teal-400/5 text-foreground"
                      : index % 2
                        ? "left-[calc(50%+max(10.4px,2.2cqw))] w-[39%] border-border text-muted-foreground"
                        : "right-[calc(50%+max(10.4px,2.2cqw))] w-[39%] border-border text-muted-foreground",
                  )}
                >
                  <Icon
                    aria-hidden
                    className={cn(
                      "size-[3.5cqw] shrink-0 rounded p-0.5",
                      selected ? "bg-teal-400/20 text-teal-500" : "bg-muted",
                    )}
                  />
                  {node.label}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {variant === 4 && (
        <svg
          viewBox="0 0 400 300"
          className="absolute inset-0 size-full"
          role="img"
          aria-label={nodes.map((node) => node.label).join(" → ")}
        >
          <path
            d="m65 250 290-180"
            fill="none"
            stroke="#b9ddeb"
            strokeDasharray="3 7"
          />
          <motion.circle
            r={3}
            fill="#38bdf8"
            initial={false}
            animate={
              running
                ? {
                    cx: [65, 65, 355, 355],
                    cy: [250, 250, 70, 70],
                    opacity: [0, 1, 1, 0],
                  }
                : { cx: 65, cy: 250, opacity: 0.7 }
            }
            transition={{
              duration: running ? 5.6 : 0,
              times: running ? [0, 0.05, 0.9, 1] : undefined,
              repeat: running ? Infinity : 0,
              ease: "linear",
            }}
          />
          {nodes.map((node, index) => {
            const x = index === 0 ? 72 : 60 + index * 90;
            const y = index === 0 ? 224 : 244 - index * 54;
            return (
              <motion.g
                key={node.id}
                initial={false}
                animate={{ opacity: 1, y: running ? [0, -4, 0] : 0 }}
                transition={{
                  duration: running ? 5.6 : 0,
                  delay: running ? index * 1.4 : 0,
                  repeat: running ? Infinity : 0,
                  ease: EASE_IN_OUT,
                }}
                fill="var(--background)"
                stroke="currentColor"
                strokeWidth={1.2}
                strokeLinejoin="round"
              >
                {index === 0 ? (
                  <>
                    <path d={`M${x - 25} ${y - 20}l50 29v39l-50-29Z`} />
                    <path d={`m${x - 20} ${y - 24} 50 29v39`} fill="none" />
                    <path
                      d={`m${x - 12} ${y - 1} 28 16m-28-7 21 12`}
                      fill="none"
                    />
                  </>
                ) : index === 2 ? (
                  <>
                    {[0, 1, 2, 3].map((layer) => (
                      <path
                        key={layer}
                        d={`M${x - 34} ${y + layer * 11 - 20}l34-20 34 20v7l-34 20-34-20Zm0 0 34 20 34-20`}
                      />
                    ))}
                    <path
                      d={`M${x - 34} ${y - 20}l34-20 34 20-34 20Z`}
                      fill="#f1f8fc"
                      stroke="#89b7d2"
                    />
                    <path
                      d={`M${x - 23} ${y - 20}l23-13 23 13-23 13Z`}
                      fill="none"
                      stroke="#89b7d2"
                      strokeWidth={0.8}
                    />
                  </>
                ) : (
                  <>
                    <path
                      d={`M${x - 32} ${y - 20}l32-19 32 19v34l-32 19-32-19Z`}
                    />
                    <path
                      d={`m${x - 32} ${y - 20} 32 19 32-19m-32 19v34`}
                      fill="none"
                    />
                    <path
                      d={`m${x - 25} ${y - 20} 25-14 25 14-25 14Z`}
                      fill="#edf7fd"
                      stroke="#91bdd7"
                      strokeWidth={0.7}
                    />
                    {index === 1 ? (
                      <path
                        d={`M${x - 12.5} ${y - 27}l25 14m-25 0 25-14`}
                        fill="none"
                        stroke="#91bdd7"
                        strokeWidth={0.8}
                      />
                    ) : (
                      <path
                        d={`M${x - 20} ${y - 20}l8-4.5 8 4.5-8 4.5Zm12-7l8-4.5 8 4.5-8 4.5Zm0 14l8-4.5 8 4.5-8 4.5Zm12-7l8-4.5 8 4.5-8 4.5Z`}
                        fill="#d9edfb"
                        stroke="#7fb2d0"
                        strokeWidth={0.8}
                      />
                    )}
                  </>
                )}
                <text
                  x={x + 24}
                  y={y + 45}
                  fontSize={6}
                  fill="currentColor"
                  stroke="none"
                  letterSpacing={1.3}
                >
                  {node.label.toUpperCase()}
                </text>
              </motion.g>
            );
          })}
        </svg>
      )}
      {variant === 5 && (
        <svg
          viewBox="0 0 400 300"
          className="absolute inset-0 size-full text-blue-500"
          role="img"
          aria-label={nodes.map((node) => node.label).join(", ")}
        >
          {nodes.map((node, index) => {
            const x =
              nodes.length === 1
                ? 200
                : 109 + (index * 182) / Math.max(1, nodes.length - 1);
            const height = 102 + (index * 140) / Math.max(1, nodes.length - 1);
            const body = towerBody(x, height);
            const edges = towerEdges(x, height);
            const cap = towerCap(x, height);
            const flatBody = towerBody(x, 12);
            const flatEdges = towerEdges(x, 12);
            const flatCap = towerCap(x, 12);
            const transition = {
              duration: running ? 6 : 0,
              delay: running ? index * 0.65 : 0,
              times: running ? towerTimes : undefined,
              repeat: running ? Infinity : 0,
              ease: EASE_IN_OUT,
            };
            return (
              <motion.g
                key={node.id}
                initial={false}
                animate={{ opacity: running ? [0.35, 0.8, 0.8, 0.35] : 0.8 }}
                transition={transition}
                fill="#bfdbfe"
                fillOpacity={0.04}
                stroke="currentColor"
                strokeOpacity={0.35}
                strokeWidth={0.8}
              >
                <motion.path
                  initial={false}
                  animate={{
                    d: running ? [flatBody, body, body, flatBody] : body,
                  }}
                  transition={transition}
                />
                <motion.path
                  initial={false}
                  animate={{
                    d: running ? [flatEdges, edges, edges, flatEdges] : edges,
                  }}
                  transition={transition}
                  fill="none"
                />
                <motion.path
                  initial={false}
                  animate={{ d: running ? [flatCap, cap, cap, flatCap] : cap }}
                  transition={transition}
                  fill="var(--background)"
                  fillOpacity={0.7}
                />
                <motion.g
                  initial={false}
                  animate={{
                    y: running ? [0, 12 - height, 12 - height, 0] : 12 - height,
                  }}
                  transition={transition}
                >
                  <text
                    x={x}
                    y={273}
                    dominantBaseline="middle"
                    textAnchor="middle"
                    fill="currentColor"
                    fillOpacity={0.65}
                    stroke="none"
                    fontSize={18}
                    transform={`rotate(30 ${x} 273)`}
                  >
                    {node.label === "Bitcoin"
                      ? "₿"
                      : node.label === "Ethereum"
                        ? "♦"
                        : "≋"}
                  </text>
                </motion.g>
              </motion.g>
            );
          })}
        </svg>
      )}
      <fieldset
        aria-label="Inspect system node"
        className="absolute inset-x-2 bottom-1 z-20 m-0 flex min-w-0 flex-wrap justify-center gap-1 border-0 p-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {nodes.map((node) => (
          <button
            type="button"
            key={node.id}
            aria-pressed={active?.id === node.id}
            onClick={() => select(node.id)}
            className="rounded-full bg-background/90 px-3 py-1.5 text-[1.8cqw]"
          >
            {node.label}
          </button>
        ))}
      </fieldset>
      <p className="sr-only" aria-live="polite">
        {active?.detail ?? "No system nodes supplied."}
      </p>
      {autoPlay && (
        <IllustrationPlaybackControl
          label="isometric playback"
          playing={!paused}
          onPlayingChange={(next) => setPaused(!next)}
          reduced={reduce}
        />
      )}
    </section>
  );
}
