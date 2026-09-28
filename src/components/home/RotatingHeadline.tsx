'use client';

import { useEffect, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { ActionSwapText } from '@/components/motion/action-swap';

export interface RotatingHeadlineProps {
  words: string[];
}

export function RotatingHeadline({ words }: RotatingHeadlineProps) {
  const [index, setIndex] = useState(0);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (reducedMotion || index >= words.length - 1) return;
    const timer = window.setTimeout(() => setIndex((current) => current + 1), 950);
    return () => window.clearTimeout(timer);
  }, [index, reducedMotion, words.length]);

  const word = words[index % words.length] ?? '';
  return <ActionSwapText value={word}>{word}</ActionSwapText>;
}
