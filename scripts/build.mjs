import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { buildInputs } from './build-inputs.mjs';
import { collectFiles } from './installation-files.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const sourceId = buildInputs(root);
for (const file of existsSync(join(root, 'dist')) ? readdirSync(join(root, 'dist')) : []) {
  if (
    /\.(js|js\.map|d\.ts)$/.test(file) &&
    !existsSync(join(root, 'src', file.replace(/\.(js|js\.map|d\.ts)$/, '.ts')))
  )
    unlinkSync(join(root, 'dist', file));
}
const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc')], {
  cwd: root,
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status || 1);
if (sourceId !== buildInputs(root))
  throw new Error('Source changed during compilation. Build again.');
const files = collectFiles(join(root, 'dist'));
delete files['build.json'];
writeFileSync(join(root, 'dist', 'build.json'), JSON.stringify({ sourceId, files }, null, 2));
