/**
 * ESM equivalent of __dirname and __filename
 *
 * Usage:
 * import { getDirname } from './lib/esm-dirname.js';
 * const __dirname = getDirname(import.meta.url);
 */
import { dirname } from 'path';
import { fileURLToPath } from 'url';
export function getDirname(importMetaUrl) {
    return dirname(fileURLToPath(importMetaUrl));
}
export function getFilename(importMetaUrl) {
    return fileURLToPath(importMetaUrl);
}
