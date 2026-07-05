export type SandboxImageCategory = 'recommended' | 'general';

export type SandboxImageOption = {
  id: string;
  image: string;
  name: string;
  summary: string;
  bestFor: string;
  badge: string;
  category: SandboxImageCategory;
};

export const DEFAULT_SANDBOX_IMAGE = 'mcr.microsoft.com/devcontainers/javascript-node:24-bookworm';

export const SANDBOX_IMAGE_OPTIONS = [
  {
    id: 'javascript-node-24',
    image: DEFAULT_SANDBOX_IMAGE,
    name: 'JavaScript Node 24',
    summary: 'Node.js and frontend tooling on Debian Bookworm.',
    bestFor: 'Next.js, React, frontend apps',
    badge: 'Default',
    category: 'recommended',
  },
  {
    id: 'typescript-node-24',
    image: 'mcr.microsoft.com/devcontainers/typescript-node:24-bookworm',
    name: 'TypeScript Node 24',
    summary: 'TypeScript-ready Node.js development image.',
    bestFor: 'TypeScript services and full-stack apps',
    badge: 'TypeScript',
    category: 'recommended',
  },
  {
    id: 'python-312',
    image: 'mcr.microsoft.com/devcontainers/python:3.12-bookworm',
    name: 'Python 3.12',
    summary: 'Python runtime with common build tooling.',
    bestFor: 'AI, data, automation, backend work',
    badge: 'Python',
    category: 'recommended',
  },
  {
    id: 'go-1',
    image: 'mcr.microsoft.com/devcontainers/go:1-bookworm',
    name: 'Go 1',
    summary: 'Go toolchain on Debian Bookworm.',
    bestFor: 'Go services, CLIs, infrastructure tools',
    badge: 'Go',
    category: 'recommended',
  },
  {
    id: 'rust-1',
    image: 'mcr.microsoft.com/devcontainers/rust:1-bookworm',
    name: 'Rust 1',
    summary: 'Rust toolchain with Cargo on Debian Bookworm.',
    bestFor: 'Rust apps, systems tools, WASM builds',
    badge: 'Rust',
    category: 'recommended',
  },
  {
    id: 'java-21',
    image: 'mcr.microsoft.com/devcontainers/java:21-bookworm',
    name: 'Java 21',
    summary: 'JDK 21 development environment.',
    bestFor: 'Java and Spring Boot projects',
    badge: 'Java',
    category: 'recommended',
  },
  {
    id: 'dotnet-8',
    image: 'mcr.microsoft.com/devcontainers/dotnet:8-bookworm',
    name: '.NET 8',
    summary: '.NET SDK image for C# development.',
    bestFor: '.NET services and C# tooling',
    badge: '.NET',
    category: 'recommended',
  },
  {
    id: 'php-83',
    image: 'mcr.microsoft.com/devcontainers/php:8.3-bookworm',
    name: 'PHP 8.3',
    summary: 'PHP development image on Debian Bookworm.',
    bestFor: 'Laravel, Symfony, WordPress tooling',
    badge: 'PHP',
    category: 'recommended',
  },
  {
    id: 'ruby-33',
    image: 'mcr.microsoft.com/devcontainers/ruby:3.3-bookworm',
    name: 'Ruby 3.3',
    summary: 'Ruby development image with common tooling.',
    bestFor: 'Rails, Ruby services, scripting',
    badge: 'Ruby',
    category: 'recommended',
  },
  {
    id: 'base-bookworm',
    image: 'mcr.microsoft.com/devcontainers/base:bookworm',
    name: 'Debian Base',
    summary: 'Clean Debian Bookworm base with minimal tooling.',
    bestFor: 'Small custom sandboxes you shape yourself',
    badge: 'Lean',
    category: 'general',
  },
  {
    id: 'universal-2',
    image: 'mcr.microsoft.com/devcontainers/universal:2',
    name: 'Universal 2',
    summary: 'Large all-in-one image with many language stacks.',
    bestFor: 'Polyglot projects and broad agent tasks',
    badge: 'All-in-one',
    category: 'general',
  },
  {
    id: 'ubuntu-2204',
    image: 'mcr.microsoft.com/devcontainers/ubuntu:22.04',
    name: 'Ubuntu 22.04',
    summary: 'Ubuntu Jammy base for Linux-compatible workflows.',
    bestFor: 'Ubuntu-targeted projects and packages',
    badge: 'Ubuntu',
    category: 'general',
  },
  {
    id: 'ubuntu-2404',
    image: 'mcr.microsoft.com/devcontainers/ubuntu:24.04',
    name: 'Ubuntu 24.04',
    summary: 'Ubuntu Noble base with a newer package baseline.',
    bestFor: 'Modern Ubuntu packages and testing',
    badge: 'Ubuntu',
    category: 'general',
  },
] as const satisfies readonly SandboxImageOption[];

export function findSandboxImageOption(image: string | null | undefined): SandboxImageOption | undefined {
  return SANDBOX_IMAGE_OPTIONS.find((option) => option.image === image);
}

export function resolveSandboxImage(imageChoice: unknown, customImage: unknown): string {
  const choice = String(imageChoice ?? '').trim();
  const preset = SANDBOX_IMAGE_OPTIONS.find((option) => option.image === choice || option.id === choice);
  if (preset) return preset.image;

  const custom = String(customImage ?? '').trim();
  if (choice === 'custom' && custom) return custom;
  return custom || DEFAULT_SANDBOX_IMAGE;
}
