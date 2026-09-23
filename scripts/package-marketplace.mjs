import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageClaudeCode } from './package-claude-code.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Builds a Claude Code plugin marketplace: a folder to publish as its own Git repository.
 *  Users then run `/plugin marketplace add OWNER/REPOSITORY` and `/plugin install glue@glue`. */
export function packageMarketplace(destination, owner) {
  if (typeof owner !== 'string' || !owner.trim() || owner.length > 200 || /[\x00-\x1f]/.test(owner))
    throw Error('Supply the marketplace owner name.');
  const output = resolve(destination);
  if (existsSync(output))
    throw Error('Marketplace output already exists. Choose a new output directory.');
  const { version } = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  const description =
    'Continue and deliberately reuse selected project work with retained evidence.';
  mkdirSync(join(output, 'plugins'), { recursive: true });
  const plugin = packageClaudeCode(join(output, 'plugins', 'glue'), owner);
  mkdirSync(join(output, '.claude-plugin'));
  writeFileSync(
    join(output, '.claude-plugin', 'marketplace.json'),
    JSON.stringify(
      {
        name: 'glue',
        owner: { name: owner },
        metadata: { description: 'Glue for Claude Code: ' + description, version },
        plugins: [
          {
            name: 'glue',
            source: './plugins/glue',
            description,
            version,
            author: { name: owner },
            license: 'Apache-2.0',
          },
        ],
      },
      null,
      2,
    ) + '\n',
  );
  for (const name of ['LICENSE', 'NOTICE']) cpSync(join(source, name), join(output, name));
  writeFileSync(
    join(output, 'README.md'),
    '# Glue for Claude Code\n\nIn Claude Code, run:\n\n```text\n/plugin marketplace add OWNER/REPOSITORY\n/plugin install glue@glue\n```\n\nReplace `OWNER/REPOSITORY` with this repository. Glue then works in every project you open; it binds to the open project and saves into that project only. Requires Node.js 22 or later.\n\nThis repository contains the packaged plugin (version ' +
      version +
      '). Source, documentation and issues live in the main Glue repository.\n',
  );
  return { destination: output, version, packageId: plugin.packageId };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !process.argv[3] || process.argv[4])
    throw Error('Usage: node scripts/package-marketplace.mjs NEW_OUTPUT_DIRECTORY OWNER');
  console.log(JSON.stringify(packageMarketplace(process.argv[2], process.argv[3])));
}
