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
Object.defineProperty(exports, "__esModule", { value: true });
exports.promptExecutorChoice = promptExecutorChoice;
const readline = __importStar(require("readline"));
/**
 * Simple readline-based executor selection prompt (Group C - token-efficient output)
 * Replaces Ink-based interactive UI with minimal terminal prompt
 */
async function promptExecutorChoice(availableExecutors, defaultExecutor) {
    // If only one executor, return it immediately
    if (availableExecutors.length === 1) {
        return availableExecutors[0];
    }
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        console.log('\nSelect executor:');
        availableExecutors.forEach((executor, index) => {
            const isDefault = executor === defaultExecutor;
            const marker = isDefault ? '(default)' : '';
            console.log(`  ${index + 1}. ${executor} ${marker}`);
        });
        console.log('');
        const defaultIndex = availableExecutors.indexOf(defaultExecutor);
        const prompt = defaultIndex >= 0 ? `Choice [1-${availableExecutors.length}] (default: ${defaultIndex + 1}): ` : `Choice [1-${availableExecutors.length}]: `;
        rl.question(prompt, (answer) => {
            rl.close();
            // Handle empty input (use default)
            if (!answer.trim() && defaultIndex >= 0) {
                console.log(`Using default: ${defaultExecutor}\n`);
                resolve(defaultExecutor);
                return;
            }
            // Parse numeric input
            const choice = parseInt(answer.trim(), 10);
            if (isNaN(choice) || choice < 1 || choice > availableExecutors.length) {
                console.log(`Invalid choice. Using default: ${defaultExecutor}\n`);
                resolve(defaultExecutor);
                return;
            }
            const selected = availableExecutors[choice - 1];
            console.log(`Selected: ${selected}\n`);
            resolve(selected);
        });
    });
}
