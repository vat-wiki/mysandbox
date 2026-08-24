// 版本号统一从 package.json 读取，发布后保持一致。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _version: string | null = null;
export function getVersion(): string {
  if (_version) return _version;
  // dev: server/ -> ../package.json；compiled: dist/server/ -> ../../package.json
  const candidates = [
    join(__dirname, '..', 'package.json'),
    join(__dirname, '..', '..', 'package.json'),
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf8')) as { version?: string };
      if (pkg.version) {
        _version = pkg.version;
        return _version;
      }
    } catch {
      /* try next */
    }
  }
  _version = '0.0.0-unknown';
  return _version;
}
