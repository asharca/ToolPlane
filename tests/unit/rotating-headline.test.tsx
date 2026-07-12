import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RotatingHeadline } from '@/components/home/RotatingHeadline';

const words = ['MCP Servers', 'Agent Skills', 'MCP Clients', 'Agent Tools'];

function setReducedMotion(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches }),
  });
}

function activeWord(container: HTMLElement) {
  return container.querySelector('.animate-word-swap');
}

describe('RotatingHeadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows each phrase once and stops within five seconds', () => {
    vi.useFakeTimers();
    setReducedMotion(false);
    const { container } = render(<RotatingHeadline words={words} />);

    expect(activeWord(container)).toHaveTextContent('MCP Servers');

    act(() => vi.advanceTimersByTime(950));
    expect(activeWord(container)).toHaveTextContent('Agent Skills');

    act(() => vi.advanceTimersByTime(1900));
    expect(activeWord(container)).toHaveTextContent('Agent Tools');

    act(() => vi.advanceTimersByTime(5000));
    expect(activeWord(container)).toHaveTextContent('Agent Tools');
  });

  it('stays static when reduced motion is requested', () => {
    vi.useFakeTimers();
    setReducedMotion(true);
    const { container } = render(<RotatingHeadline words={words} />);

    act(() => vi.advanceTimersByTime(5000));

    expect(activeWord(container)).toHaveTextContent('MCP Servers');
  });
});
