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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.accentToColor = exports.toneToColor = exports.palette = exports.renderEnvelope = void 0;
__exportStar(require("./view-model"), exports);
var render_1 = require("./render");
Object.defineProperty(exports, "renderEnvelope", { enumerable: true, get: function () { return render_1.renderEnvelope; } });
var theme_1 = require("./theme");
Object.defineProperty(exports, "palette", { enumerable: true, get: function () { return theme_1.palette; } });
Object.defineProperty(exports, "toneToColor", { enumerable: true, get: function () { return theme_1.toneToColor; } });
Object.defineProperty(exports, "accentToColor", { enumerable: true, get: function () { return theme_1.accentToColor; } });
