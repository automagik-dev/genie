import React, { useState, useEffect } from 'react';
import { Text, Box } from 'ink';
import gradient from 'gradient-string';
const scrollGradient = gradient(['#FFD700', '#FFA500', '#FF8C00']);
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
export const ScrollAnimation = ({ onComplete }) => {
    const [frame, setFrame] = useState(0);
    useEffect(() => {
        if (frame < FRAMES.length - 1) {
            const timeout = setTimeout(() => {
                setFrame(frame + 1);
            }, 400);
            return () => clearTimeout(timeout);
        }
        else {
            const timeout = setTimeout(() => {
                onComplete();
            }, 800);
            return () => clearTimeout(timeout);
        }
    }, [frame, onComplete]);
    return (React.createElement(Box, { flexDirection: "column", alignItems: "center" },
        React.createElement(Text, null, scrollGradient(FRAMES[frame]))));
};
