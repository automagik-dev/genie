import React, { useState, useEffect } from 'react';
import { Text, Box, useInput, useApp } from 'ink';
import Spinner from 'ink-spinner';
import SelectInput from 'ink-select-input';
import gradient from 'gradient-string';
import { LampAnimation } from '../animations/LampAnimation.js';
import { PortalAnimation } from '../animations/PortalAnimation.js';
import { ScrollAnimation } from '../animations/ScrollAnimation.js';
import { ConstellationAnimation } from '../animations/ConstellationAnimation.js';
const genieGradient = gradient(['#FF6B9D', '#C06FEF', '#4D8FFF']);
const successGradient = gradient(['#00F260', '#0575E6']);
const warningGradient = gradient(['#FFA500', '#FF6B9D']);
const ANIMATIONS = [LampAnimation, PortalAnimation, ScrollAnimation, ConstellationAnimation];
// Streaming text component
const StreamingText = ({ text, onComplete, delay = 30 }) => {
    const [displayedText, setDisplayedText] = useState('');
    const [currentIndex, setCurrentIndex] = useState(0);
    useEffect(() => {
        if (currentIndex < text.length) {
            const timeout = setTimeout(() => {
                setDisplayedText(text.slice(0, currentIndex + 1));
                setCurrentIndex(currentIndex + 1);
            }, delay);
            return () => clearTimeout(timeout);
        }
        else if (currentIndex === text.length && text.length > 0) {
            const timeout = setTimeout(() => {
                onComplete();
            }, 500);
            return () => clearTimeout(timeout);
        }
    }, [currentIndex, text, delay, onComplete]);
    return React.createElement(Text, null, displayedText);
};
export const IntelligentEntry = ({ currentVersion, latestVersion, isWorkspaceInitialized, hasOldVersion, onUpdate, onInit, onUpgrade, onStart, }) => {
    const { exit } = useApp();
    const [state, setState] = useState('animation');
    const [streamComplete, setStreamComplete] = useState(false);
    const [selectedAction, setSelectedAction] = useState(null);
    // Random animation selection
    const [AnimationComponent] = useState(() => {
        const randomIndex = Math.floor(Math.random() * ANIMATIONS.length);
        return ANIMATIONS[randomIndex];
    });
    const needsUpdate = currentVersion !== latestVersion;
    // Handle animation complete
    const handleAnimationComplete = () => {
        setState('checking-update');
        setStreamComplete(false);
    };
    // Handle streaming text complete
    const handleStreamComplete = () => {
        setStreamComplete(true);
    };
    // Auto-progress logic
    useEffect(() => {
        if (!streamComplete)
            return;
        if (state === 'checking-update') {
            if (needsUpdate) {
                setState('needs-update');
                setStreamComplete(false);
            }
            else {
                setTimeout(() => {
                    setState('checking-workspace');
                    setStreamComplete(false);
                }, 800);
            }
        }
        else if (state === 'checking-workspace') {
            if (hasOldVersion) {
                setState('needs-upgrade');
                setStreamComplete(false);
            }
            else if (!isWorkspaceInitialized) {
                setState('needs-init');
                setStreamComplete(false);
            }
            else {
                setState('ready');
                setStreamComplete(false);
            }
        }
    }, [streamComplete, state, needsUpdate, isWorkspaceInitialized, hasOldVersion]);
    // Handle user input for confirmations
    useInput((input, key) => {
        if (state === 'ready' && streamComplete) {
            if (key.return) {
                setState('starting');
                setTimeout(() => {
                    onStart();
                    exit();
                }, 1000);
            }
        }
    });
    // Handle menu selections
    const handleSelect = (item) => {
        setSelectedAction(item.value);
        if (state === 'needs-update') {
            if (item.value === 'yes') {
                onUpdate();
                exit();
            }
            else {
                setState('checking-workspace');
                setStreamComplete(false);
                setSelectedAction(null);
            }
        }
        else if (state === 'needs-init') {
            if (item.value === 'yes') {
                onInit();
                exit();
            }
            else {
                exit();
            }
        }
        else if (state === 'needs-upgrade') {
            if (item.value === 'yes') {
                onUpgrade();
                exit();
            }
            else {
                exit();
            }
        }
    };
    return (React.createElement(Box, { flexDirection: "column", padding: 1 },
        state === 'animation' && React.createElement(AnimationComponent, { onComplete: handleAnimationComplete }),
        state === 'checking-update' && (React.createElement(Box, { flexDirection: "column" },
            React.createElement(Text, null, genieGradient('━'.repeat(60))),
            React.createElement(Box, { marginY: 1 },
                React.createElement(Text, { color: "cyan" },
                    React.createElement(Spinner, { type: "dots" })),
                React.createElement(Text, null, " "),
                React.createElement(StreamingText, { text: "Hey there! I'm Genie. Let me check if I'm running the latest version...", onComplete: handleStreamComplete })))),
        state === 'needs-update' && !selectedAction && (React.createElement(Box, { flexDirection: "column" },
            React.createElement(Text, null, genieGradient('━'.repeat(60))),
            React.createElement(Box, { marginY: 1, flexDirection: "column" },
                React.createElement(StreamingText, { text: `Looks like I found a newer version! You're on v${currentVersion}, but v${latestVersion} is available.`, onComplete: handleStreamComplete })),
            streamComplete && (React.createElement(Box, { marginY: 1 },
                React.createElement(Text, null, warningGradient('Would you like me to update now?')))),
            streamComplete && (React.createElement(SelectInput, { items: [
                    { label: 'Yes, update now', value: 'yes' },
                    { label: 'No, skip for now', value: 'no' },
                ], onSelect: handleSelect })))),
        state === 'checking-workspace' && (React.createElement(Box, { flexDirection: "column" },
            React.createElement(Text, null, genieGradient('━'.repeat(60))),
            React.createElement(Box, { marginY: 1 },
                React.createElement(Text, { color: "cyan" },
                    React.createElement(Spinner, { type: "dots" })),
                React.createElement(Text, null, " "),
                React.createElement(StreamingText, { text: "Great! Now let me check if your workspace is initialized...", onComplete: handleStreamComplete })))),
        state === 'needs-init' && !selectedAction && (React.createElement(Box, { flexDirection: "column" },
            React.createElement(Text, null, genieGradient('━'.repeat(60))),
            React.createElement(Box, { marginY: 1, flexDirection: "column" },
                React.createElement(StreamingText, { text: "I can see you don't have a .genie workspace initialized yet. Would you like me to set one up for you?", onComplete: handleStreamComplete })),
            streamComplete && (React.createElement(Box, { marginY: 1 },
                React.createElement(Text, null, warningGradient('Initialize workspace now?')))),
            streamComplete && (React.createElement(SelectInput, { items: [
                    { label: 'Yes, initialize workspace', value: 'yes' },
                    { label: 'No, exit for now', value: 'no' },
                ], onSelect: handleSelect })))),
        state === 'needs-upgrade' && !selectedAction && (React.createElement(Box, { flexDirection: "column" },
            React.createElement(Text, null, genieGradient('━'.repeat(60))),
            React.createElement(Box, { marginY: 1, flexDirection: "column" },
                React.createElement(StreamingText, { text: `I see you have an old Genie workspace here. Don't worry! Your data is safe. I'm going to learn from it and preserve everything. I'll create a backup at .genie.backup just in case. Ready to upgrade?`, onComplete: handleStreamComplete })),
            streamComplete && (React.createElement(Box, { marginY: 1 },
                React.createElement(Text, null, warningGradient('Upgrade workspace now?')))),
            streamComplete && (React.createElement(SelectInput, { items: [
                    { label: 'Yes, upgrade my workspace', value: 'yes' },
                    { label: 'No, exit for now', value: 'no' },
                ], onSelect: handleSelect })))),
        state === 'ready' && (React.createElement(Box, { flexDirection: "column" },
            React.createElement(Text, null, genieGradient('━'.repeat(60))),
            React.createElement(Box, { marginY: 1, flexDirection: "column" },
                React.createElement(StreamingText, { text: `Perfect! You're all set with v${currentVersion} and your workspace is ready to go. Let's get started! ✨`, onComplete: handleStreamComplete })),
            streamComplete && (React.createElement(Box, { marginY: 1 },
                React.createElement(Text, null, successGradient('Press ENTER to start Genie...')))))),
        state === 'starting' && (React.createElement(Box, { flexDirection: "column" },
            React.createElement(Text, null, genieGradient('━'.repeat(60))),
            React.createElement(Box, { marginY: 1 },
                React.createElement(Text, { color: "cyan" },
                    React.createElement(Spinner, { type: "dots" })),
                React.createElement(Text, null,
                    " ",
                    successGradient('Starting Genie...')))))));
};
