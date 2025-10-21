"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const codex_1 = __importDefault(require("./codex"));
// Thin wrapper around codex executor until native Opencode integration is available.
// Allows `--executor opencode` to route through the same command surface while
// we stabilise Forge-based model selection.
const opencodeExecutor = {
    ...codex_1.default,
    defaults: {
        ...codex_1.default.defaults,
        exec: {
            ...codex_1.default.defaults.exec,
            model: codex_1.default.defaults.exec?.model || 'opencode',
        }
    },
    buildRunCommand: (params) => {
        return codex_1.default.buildRunCommand(params);
    },
    buildResumeCommand: (params) => {
        return codex_1.default.buildResumeCommand(params);
    }
};
exports.default = opencodeExecutor;
