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
exports.ScrollAnimation = void 0;
const react_1 = __importStar(require("react"));
// @ts-ignore - ESM module
const ink_1 = require("ink");
const gradient_string_1 = __importDefault(require("gradient-string"));
const scrollGradient = (0, gradient_string_1.default)(['#FFD700', '#FFA500', '#FF8C00']);
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
const ScrollAnimation = ({ onComplete }) => {
    const [frame, setFrame] = (0, react_1.useState)(0);
    (0, react_1.useEffect)(() => {
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
    return (react_1.default.createElement(ink_1.Box, { flexDirection: "column", alignItems: "center" },
        react_1.default.createElement(ink_1.Text, null, scrollGradient(FRAMES[frame]))));
};
exports.ScrollAnimation = ScrollAnimation;
