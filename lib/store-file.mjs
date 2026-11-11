import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** Blob store stand-in for local work and tests: same create-only and
 *  write-if-unchanged rules as the Netlify store. Single process only. */
export function fileStore(root) {
  const pathOf = (key) => join(root, ...key.split('/')) + '.json';
  const etagOf = (p) => String(statSync(p).mtimeMs) + ':' + readFileSync(p).length;
  const walk = (dir) =>
    !existsSync(dir)
      ? []
      : readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
        );
  let version = 0;
  const etags = new Map();
  return {
    async get(key) {
      const p = pathOf(key);
      if (!existsSync(p)) return null;
      return { data: JSON.parse(readFileSync(p, 'utf8')), etag: etags.get(key) || etagOf(p) };
    },
    async put(key, data, { onlyIfNew, onlyIfMatch } = {}) {
      const p = pathOf(key);
      const exists = existsSync(p);
      if (onlyIfNew && exists) return false;
      if (onlyIfMatch && (!exists || (etags.get(key) || etagOf(p)) !== onlyIfMatch)) return false;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(data, null, 1));
      etags.set(key, `v${++version}`);
      return true;
    },
    async list(prefix) {
      const base = join(root, ...prefix.split('/').filter(Boolean));
      return walk(base).map((f) => relative(root, f).split(sep).join('/').replace(/\.json$/, ''));
    },
  };
}
