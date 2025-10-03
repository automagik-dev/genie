"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.backgroundManager = void 0;
const background_manager_1 = __importDefault(require("../background-manager"));
exports.backgroundManager = new background_manager_1.default();
exports.default = exports.backgroundManager;
