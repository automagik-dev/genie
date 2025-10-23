"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyUpgrade = exports.generateFrameworkDiff = exports.checkForUpdates = void 0;
// Upgrade system entry point
var version_checker_1 = require("./version-checker");
Object.defineProperty(exports, "checkForUpdates", { enumerable: true, get: function () { return version_checker_1.checkForUpdates; } });
var diff_generator_1 = require("./diff-generator");
Object.defineProperty(exports, "generateFrameworkDiff", { enumerable: true, get: function () { return diff_generator_1.generateFrameworkDiff; } });
var merge_strategy_1 = require("./merge-strategy");
Object.defineProperty(exports, "applyUpgrade", { enumerable: true, get: function () { return merge_strategy_1.applyUpgrade; } });
