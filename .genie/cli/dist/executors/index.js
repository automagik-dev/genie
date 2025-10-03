"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_EXECUTOR_KEY = void 0;
exports.loadExecutors = loadExecutors;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
exports.DEFAULT_EXECUTOR_KEY = 'codex';
function loadExecutors() {
    const executors = {};
    const currentDir = __dirname;
    let files = [];
    try {
        files = fs_1.default.readdirSync(currentDir);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[genie] Failed to read executors directory: ${message}`);
        return executors;
    }
    files
        .filter((file) => file.endsWith('.js') && !file.startsWith('types') && file !== 'index.js')
        .forEach((file) => {
        const executorName = path_1.default.basename(file, '.js');
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
            const mod = require(path_1.default.join(currentDir, file));
            const executor = mod.default || mod;
            if (executor && typeof executor === 'object') {
                executors[executorName] = executor;
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[genie] Failed to load executor '${executorName}': ${message}`);
        }
    });
    return executors;
}
