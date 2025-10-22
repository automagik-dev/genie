import React, { useState, useEffect } from 'react';
import { Text, Box } from 'ink';
import gradient from 'gradient-string';

const portalGradient = gradient(['#4D8FFF', '#C06FEF', '#FF6B9D']);

interface PortalAnimationProps {
  onComplete: () => void;
}

const FRAMES = [
  `



         ∴



   `,
  `


        ∵ ∴
       ∴   ∵
        ∵ ∴


   `,
  `

       ∴  ∵  ∴
      ╱       ╲
     │    ∵    │
      ╲   ∴   ╱
       ∴  ∵  ∴

   `,
  `
      ✨  ∴  ∵  ✨
     ╱           ╲
    │      ∵      │
    │    ∴   ∴    │
     ╲     ∵     ╱
      ✨  ∴  ∵  ✨
   `,
  `
     ✨  ╭─────╮  ✨
       ╱  ∵ ∴  ╲
      │  ∴   ∵  │
      │  ∵ ∴ ∴  │
       ╲  ∴ ∵  ╱
     ✨  ╰─────╯  ✨
   `,
  `
     ✨  ╭─────╮  ✨
       ╱  ∵ ∴  ╲
      │    🧞    │
      │  ∵ ∴ ∴  │
       ╲  ∴ ∵  ╱
     ✨  ╰─────╯  ✨
   `,
  `

       ╭─────╮
      │       │
      │  🧞   │
      │       │
       ╰─────╯

   `,
];

export const PortalAnimation: React.FC<PortalAnimationProps> = ({ onComplete }) => {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (frame < FRAMES.length - 1) {
      const timeout = setTimeout(() => {
        setFrame(frame + 1);
      }, 350);
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
      <Text>{portalGradient(FRAMES[frame])}</Text>
    </Box>
  );
};
