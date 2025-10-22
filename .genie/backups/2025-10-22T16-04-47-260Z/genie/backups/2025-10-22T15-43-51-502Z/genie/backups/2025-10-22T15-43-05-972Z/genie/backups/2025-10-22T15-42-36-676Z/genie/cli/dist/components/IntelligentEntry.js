"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IntelligentEntry = void 0;
const react_1 = __importStar(require("react"));
// @ts-ignore - ESM module
const ink_1 = require("ink");
// @ts-ignore - ESM module
const ink_spinner_1 = __importDefault(require("ink-spinner"));
// @ts-ignore - ESM module
const ink_select_input_1 = __importDefault(require("ink-select-input"));
const gradient_string_1 = __importDefault(require("gradient-string"));
const LampAnimation_1 = require("../animations/LampAnimation");
const PortalAnimation_1 = require("../animations/PortalAnimation");
const ScrollAnimation_1 = require("../animations/ScrollAnimation");
const ConstellationAnimation_1 = require("../animations/ConstellationAnimation");
const genieGradient = (0, gradient_string_1.default)(['#FF6B9D', '#C06FEF', '#4D8FFF']);
const successGradient = (0, gradient_string_1.default)(['#00F260', '#0575E6']);
const warningGradient = (0, gradient_string_1.default)(['#FFA500', '#FF6B9D']);
const ANIMATIONS = [LampAnimation_1.LampAnimation, PortalAnimation_1.PortalAnimation, ScrollAnimation_1.ScrollAnimation, ConstellationAnimation_1.ConstellationAnimation];
// Streaming text component
const StreamingText = ({ text, onComplete, delay = 30 }) => {
    const [displayedText, setDisplayedText] = (0, react_1.useState)('');
    const [currentIndex, setCurrentIndex] = (0, react_1.useState)(0);
    (0, react_1.useEffect)(() => {
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
    return react_1.default.createElement(ink_1.Text, null, displayedText);
};
const IntelligentEntry = ({ currentVersion, latestVersion, isWorkspaceInitialized, hasOldVersion, onUpdate, onInit, onUpgrade, onStart, }) => {
    const { exit } = (0, ink_1.useApp)();
    const [state, setState] = (0, react_1.useState)('animation');
    const [streamComplete, setStreamComplete] = (0, react_1.useState)(false);
    const [selectedAction, setSelectedAction] = (0, react_1.useState)(null);
    // Random animation selection
    const [AnimationComponent] = (0, react_1.useState)(() => {
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
    (0, react_1.useEffect)(() => {
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
    (0, ink_1.useInput)((input, key) => {
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
    return (react_1.default.createElement(ink_1.Box, { flexDirection: "column", padding: 1 },
        state === 'animation' && react_1.default.createElement(AnimationComponent, { onComplete: handleAnimationComplete }),
        state === 'checking-update' && (react_1.default.createElement(ink_1.Box, { flexDirection: "column" },
            react_1.default.createElement(ink_1.Text, null, genieGradient('━'.repeat(60))),
            react_1.default.createElement(ink_1.Box, { marginY: 1 },
                react_1.default.createElement(ink_1.Text, { color: "cyan" },
                    react_1.default.createElement(ink_spinner_1.default, { type: "dots" })),
                react_1.default.createElement(ink_1.Text, null, " "),
                react_1.default.createElement(StreamingText, { text: "Hey there! I'm Genie. Let me check if I'm running the latest version...", onComplete: handleStreamComplete })))),
        state === 'needs-update' && !selectedAction && (react_1.default.createElement(ink_1.Box, { flexDirection: "column" },
            react_1.default.createElement(ink_1.Text, null, genieGradient('━'.repeat(60))),
            react_1.default.createElement(ink_1.Box, { marginY: 1, flexDirection: "column" },
                react_1.default.createElement(StreamingText, { text: `Looks like I found a newer version! You're on v${currentVersion}, but v${latestVersion} is available.`, onComplete: handleStreamComplete })),
            streamComplete && (react_1.default.createElement(ink_1.Box, { marginY: 1 },
                react_1.default.createElement(ink_1.Text, null, warningGradient('Would you like me to update now?')))),
            streamComplete && (react_1.default.createElement(ink_select_input_1.default, { items: [
                    { label: 'Yes, update now', value: 'yes' },
                    { label: 'No, skip for now', value: 'no' },
                ], onSelect: handleSelect })))),
        state === 'checking-workspace' && (react_1.default.createElement(ink_1.Box, { flexDirection: "column" },
            react_1.default.createElement(ink_1.Text, null, genieGradient('━'.repeat(60))),
            react_1.default.createElement(ink_1.Box, { marginY: 1 },
                react_1.default.createElement(ink_1.Text, { color: "cyan" },
                    react_1.default.createElement(ink_spinner_1.default, { type: "dots" })),
                react_1.default.createElement(ink_1.Text, null, " "),
                react_1.default.createElement(StreamingText, { text: "Great! Now let me check if your workspace is initialized...", onComplete: handleStreamComplete })))),
        state === 'needs-init' && !selectedAction && (react_1.default.createElement(ink_1.Box, { flexDirection: "column" },
            react_1.default.createElement(ink_1.Text, null, genieGradient('━'.repeat(60))),
            react_1.default.createElement(ink_1.Box, { marginY: 1, flexDirection: "column" },
                react_1.default.createElement(StreamingText, { text: "I can see you don't have a .genie workspace initialized yet. Would you like me to set one up for you?", onComplete: handleStreamComplete })),
            streamComplete && (react_1.default.createElement(ink_1.Box, { marginY: 1 },
                react_1.default.createElement(ink_1.Text, null, warningGradient('Initialize workspace now?')))),
            streamComplete && (react_1.default.createElement(ink_select_input_1.default, { items: [
                    { label: 'Yes, initialize workspace', value: 'yes' },
                    { label: 'No, exit for now', value: 'no' },
                ], onSelect: handleSelect })))),
        state === 'needs-upgrade' && !selectedAction && (react_1.default.createElement(ink_1.Box, { flexDirection: "column" },
            react_1.default.createElement(ink_1.Text, null, genieGradient('━'.repeat(60))),
            react_1.default.createElement(ink_1.Box, { marginY: 1, flexDirection: "column" },
                react_1.default.createElement(StreamingText, { text: `I see you have an old Genie workspace here. Don't worry! Your data is safe. I'm going to learn from it and preserve everything. I'll create a backup at .genie.backup just in case. Ready to upgrade?`, onComplete: handleStreamComplete })),
            streamComplete && (react_1.default.createElement(ink_1.Box, { marginY: 1 },
                react_1.default.createElement(ink_1.Text, null, warningGradient('Upgrade workspace now?')))),
            streamComplete && (react_1.default.createElement(ink_select_input_1.default, { items: [
                    { label: 'Yes, upgrade my workspace', value: 'yes' },
                    { label: 'No, exit for now', value: 'no' },
                ], onSelect: handleSelect })))),
        state === 'ready' && (react_1.default.createElement(ink_1.Box, { flexDirection: "column" },
            react_1.default.createElement(ink_1.Text, null, genieGradient('━'.repeat(60))),
            react_1.default.createElement(ink_1.Box, { marginY: 1, flexDirection: "column" },
                react_1.default.createElement(StreamingText, { text: `Perfect! You're all set with v${currentVersion} and your workspace is ready to go. Let's get started! ✨`, onComplete: handleStreamComplete })),
            streamComplete && (react_1.default.createElement(ink_1.Box, { marginY: 1 },
                react_1.default.createElement(ink_1.Text, null, successGradient('Press ENTER to start Genie...')))))),
        state === 'starting' && (react_1.default.createElement(ink_1.Box, { flexDirection: "column" },
            react_1.default.createElement(ink_1.Text, null, genieGradient('━'.repeat(60))),
            react_1.default.createElement(ink_1.Box, { marginY: 1 },
                react_1.default.createElement(ink_1.Text, { color: "cyan" },
                    react_1.default.createElement(ink_spinner_1.default, { type: "dots" })),
                react_1.default.createElement(ink_1.Text, null,
                    " ",
                    successGradient('Starting Genie...')))))));
};
exports.IntelligentEntry = IntelligentEntry;
