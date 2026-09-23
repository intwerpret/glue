import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageHost } from './package-host.mjs';
export const packageClaudeDesktop = (destination, author) =>
  packageHost(destination, 'claude-desktop', author);
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !process.argv[3] || process.argv[4])
    throw Error('Usage: node scripts/package-claude-desktop.mjs NEW_OUTPUT_DIRECTORY AUTHOR');
  const { files, ...receipt } = packageClaudeDesktop(process.argv[2], process.argv[3]);
  console.log(JSON.stringify({ ...receipt, fileCount: Object.keys(files).length }));
}
