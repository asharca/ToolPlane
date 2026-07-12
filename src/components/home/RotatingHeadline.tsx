'use client';

import { useEffect, useState } from 'react';

export function RotatingHeadline({ words }: { words: string[] }) {
  const [wordIndex, setWordIndex] = useState(0);

  useEffect(() => {
    if (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }

    const timers = words.slice(1).map((_, index) =>
      window.setTimeout(() => setWordIndex(index + 1), (index + 1) * 950),
    );

    return () => timers.forEach(window.clearTimeout);
  }, [words]);

  const activeWord = words[wordIndex] ?? words[0] ?? '';

  return (
    <span className="relative inline-grid text-muted-foreground">
      {words.map((word) => (
        <span key={word} aria-hidden className="invisible col-start-1 row-start-1">
          {word}
        </span>
      ))}
      <span key={activeWord} aria-hidden className="animate-word-swap col-start-1 row-start-1">
        {activeWord}
      </span>
    </span>
  );
}
