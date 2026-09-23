import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectFiles, fingerprint } from './installation-files.mjs';

export function buildInputs(root) {
  const files = Object.fromEntries(
    Object.entries(collectFiles(join(root, 'src'))).map(([file, hash]) => ['src/' + file, hash]),
  );
  for (const file of ['tsconfig.json', 'package.json', 'package-lock.json'])
    files[file] = createHash('sha256')
      .update(readFileSync(join(root, file)))
      .digest('hex');
  return fingerprint(files);
}
