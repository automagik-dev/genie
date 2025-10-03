"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_EXECUTOR_KEY = exports.EXECUTORS = void 0;
const executors_1 = require("../executors");
Object.defineProperty(exports, "DEFAULT_EXECUTOR_KEY", { enumerable: true, get: function () { return executors_1.DEFAULT_EXECUTOR_KEY; } });
exports.EXECUTORS = (0, executors_1.loadExecutors)();
if (!exports.EXECUTORS[executors_1.DEFAULT_EXECUTOR_KEY]) {
    const available = Object.keys(exports.EXECUTORS).join(', ') || 'none';
    throw new Error(`Default executor '${executors_1.DEFAULT_EXECUTOR_KEY}' not found. Available executors: ${available}`);
}
