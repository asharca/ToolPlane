'use client';

import { useEffect, useState } from 'react';

const WORDS = ['MCP Servers', 'Agent Skills', 'MCP Clients', 'Agent Tools'];

export function RotatingHeadline() {
  const [wordIndex, setWordIndex] = useState(0);
  const [text, setText] = useState(WORDS[0]);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const word = WORDS[wordIndex];
    const done = text === word;
    const empty = text === '';

    let delay = deleting ? 45 : 90;
    if (done && !deleting) delay = 1400;
    if (empty && deleting) delay = 250;

    const timer = setTimeout(() => {
      if (!deleting && done) {
        setDeleting(true);
      } else if (deleting && empty) {
        setDeleting(false);
        setWordIndex((i) => (i + 1) % WORDS.length);
      } else {
        setText(
          deleting ? word.slice(0, text.length - 1) : word.slice(0, text.length + 1),
        );
      }
    }, delay);

    return () => clearTimeout(timer);
  }, [text, deleting, wordIndex]);

  return (
    <span className="text-muted-foreground">
      {text}
      <span className="animate-caret font-normal">|</span>
    </span>
  );
}
