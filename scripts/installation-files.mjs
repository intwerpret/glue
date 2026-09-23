import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
export function collectFiles(directory) {
  const files = {};
  function visit(prefix) {
    for (const entry of readdirSync(join(directory, prefix)).sort()) {
      const relative = prefix ? prefix + '/' + entry : entry;
      if (relative === 'installation.json') continue;
      const file = join(directory, relative);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('Linked package entries are not supported.');
      if (stat.isDirectory()) visit(relative);
      else if (stat.isFile())
        files[relative] = createHash('sha256').update(readFileSync(file)).digest('hex');
      else throw new Error('Unsupported package entry.');
    }
  }
  visit('');
  return files;
}

export function fingerprint(files) {
  return createHash('sha256')
    .update(JSON.stringify(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))
    .digest('hex');
}
