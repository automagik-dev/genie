import React, { useState, useEffect } from 'react';
// @ts-ignore - ESM module
import { Text, Box } from 'ink';
import gradient from 'gradient-string';

const starGradient = gradient(['#FFFFFF', '#C0C0FF', '#8080FF']);

interface ConstellationAnimationProps {
  onComplete: () => void;
}

const FRAMES = [
  `





         ✦



   `,
  `



    ✦

         ✦



   `,
  `

    ✦        ✦

         ✦
              ✦


   `,
  `
    ✦────────✦
     ╲
      ╲
    ✦──✦─────✦
              ╲
               ✦
   `,
  `
    ✦────────✦
     ╲      ╱
      ╲  ╱
    ✦──✦─────✦
       │      ╲
       │       ✦
   `,
  `
    ✦────────✦
     ╲  🧞  ╱
      ╲  ╱
    ✦──✦─────✦
       │      ╲
       ✦       ✦
   `,
  `
    ✦────────✦
     ╲  🧞  ╱
      ╲  ╱
    ✦──✦─────✦
       │ Genie
       ✦
   `,
];

export const ConstellationAnimation: React.FC<ConstellationAnimationProps> = ({ onComplete }) => {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (frame < FRAMES.length - 1) {
      const timeout = setTimeout(() => {
        setFrame(frame + 1);
      }, 450);
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
      <Text>{starGradient(FRAMES[frame])}</Text>
    </Box>
  );
};
