"use strict";
/**
 * ESM equivalent of __dirname and __filename
 *
 * Usage:
 * import { getDirname } from './lib/esm-dirname.js';
 * const __dirname = getDirname(import.meta.url);
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDirname = getDirname;
exports.getFilename = getFilename;
const path_1 = require("path");
const url_1 = require("url");
function getDirname(importMetaUrl) {
    return (0, path_1.dirname)((0, url_1.fileURLToPath)(importMetaUrl));
}
function getFilename(importMetaUrl) {
    return (0, url_1.fileURLToPath)(importMetaUrl);
}
