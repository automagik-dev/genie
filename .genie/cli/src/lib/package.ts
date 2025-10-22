import fs from 'fs';
import path from 'path';
import { getPackageRoot } from './paths';

let cachedPackageJson: any;

export function readPackageJson(): any {
  if (!cachedPackageJson) {
    const pkgPath = path.join(getPackageRoot(), 'package.json');
    const content = fs.readFileSync(pkgPath, 'utf8');
    cachedPackageJson = JSON.parse(content);
  }
  return cachedPackageJson;
}

export function getPackageVersion(): string {
  const pkg = readPackageJson();
  return pkg.version ?? '0.0.0';
}
