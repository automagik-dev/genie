import React, { useState, useEffect } from 'react';
import { Text, Box } from 'ink';
import gradient from 'gradient-string';

const scrollGradient = gradient(['#FFD700', '#FFA500', '#FF8C00']);

interface ScrollAnimationProps {
  onComplete: () => void;
}

const FRAMES = [
  `


        ═══
        ║ ║
        ║ ║


   `,
  `

       ╔═══╗
       ║   ║
       ║   ║
       ╚═══╝


   `,
  `
      ╔═════╗
     ╱  ∼∼∼  ╲
    │    ∼    │
     ╲  ∼∼∼  ╱
      ╚═════╝

   `,
  `
     ╔═══════╗
    ╱  ∼∼∼∼∼  ╲
   │   ∼ ∼ ∼   │
   │  ∼∼∼∼∼∼  │
    ╲  ∼∼∼∼∼  ╱
     ╚═══════╯
   `,
  `
     ╔═══════╗
    ╱  ∼∼∼∼∼  ╲
   │  ✨ 🧞 ✨  │
   │  ∼∼∼∼∼∼  │
    ╲  ∼∼∼∼∼  ╱
     ╚═══════╯
   `,
  `
     ╔═══════╗
    ╱         ╲
   │    🧞    │
   │  Genie   │
    ╲         ╱
     ╚═══════╯
   `,
];

export const ScrollAnimation: React.FC<ScrollAnimationProps> = ({ onComplete }) => {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (frame < FRAMES.length - 1) {
      const timeout = setTimeout(() => {
        setFrame(frame + 1);
      }, 400);
      return () => clearTimeout(timeout);
    } else {
      const timeout = setTimeout(() => {
        onComplete();
      }, 800);
      return () => clearTimeout(timeout);
    }
  }, [frame, onComplete]);

  return (
    <Box flexDirection="column" alignItems="center">
      <Text>{scrollGradient(FRAMES[frame])}</Text>
    </Box>
  );
};
