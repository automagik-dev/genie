import fs from 'fs';
import path from 'path';
import { getPackageRoot } from './paths.js';
let cachedPackageJson;
export function readPackageJson() {
    if (!cachedPackageJson) {
        const pkgPath = path.join(getPackageRoot(), 'package.json');
        const content = fs.readFileSync(pkgPath, 'utf8');
        cachedPackageJson = JSON.parse(content);
    }
    return cachedPackageJson;
}
export function getPackageVersion() {
    const pkg = readPackageJson();
    return pkg.version ?? '0.0.0';
}
