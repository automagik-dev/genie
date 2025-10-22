"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readPackageJson = readPackageJson;
exports.getPackageVersion = getPackageVersion;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const paths_1 = require("./paths");
let cachedPackageJson;
function readPackageJson() {
    if (!cachedPackageJson) {
        const pkgPath = path_1.default.join((0, paths_1.getPackageRoot)(), 'package.json');
        const content = fs_1.default.readFileSync(pkgPath, 'utf8');
        cachedPackageJson = JSON.parse(content);
    }
    return cachedPackageJson;
}
function getPackageVersion() {
    const pkg = readPackageJson();
    return pkg.version ?? '0.0.0';
}
