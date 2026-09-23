import {
  cpSync,
  rmSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  lstatSync,
  renameSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectFiles, fingerprint } from './installation-files.mjs';
import { buildInputs } from './build-inputs.mjs';
import { runtimeModules, skillFiles } from './runtime-files.mjs';
import { connectionChange } from './connections.mjs';
import { protectProjectGit } from './project-exclusions.mjs';
import { withInstallationLock } from './installation-lock.mjs';
import { assertUnlinked } from '../dist/storage.js';
import { TOOL_NAMES } from '../dist/tools.js';
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [argument, ...extra] = process.argv.slice(2);
const options = {};
let development = false,
  protectGit = false;
for (let i = 0; i < extra.length; i++) {
  const option = extra[i];
  if (option === '--protect-git' && !protectGit) {
    protectGit = true;
    continue;
  }
  if (option === '--development' && !development) {
    development = true;
    continue;
  }
  const key = { '--host': 'host', '--config': 'config', '--name': 'name' }[option];
  if (!key || options[key] !== undefined || !extra[i + 1] || extra[i + 1].startsWith('--'))
    throw Error('Invalid installation options.');
  options[key] = extra[++i];
}
if (!argument)
  throw Error(
    'Usage: node scripts/install-skill.mjs WORKSPACE [--development] [--host codex|claude-code|claude-desktop] [--config ABSOLUTE_FILE --name PROJECT_SERVER]',
  );
const host = options.host ?? 'codex';
if (!['codex', 'claude-code', 'claude-desktop'].includes(host))
  throw Error('Unsupported installation host.');
if (protectGit && host === 'claude-desktop')
  throw Error('Git protection requires a project installation host.');
const workspace = realpathSync(argument),
  rel = relative(source, workspace);
if (development && workspace !== realpathSync(source))
  throw Error('--development requires this exact source workspace.');
if (!development && (!rel || (!rel.startsWith('..') && !isAbsolute(rel))))
  throw Error(
    'Choose a workspace outside the development checkout, or use --development for this workspace.',
  );
const build = JSON.parse(readFileSync(join(source, 'dist/build.json'), 'utf8'));
if (build.sourceId !== buildInputs(source)) throw Error('Source changed. Run npm run build.');
const compiled = collectFiles(join(source, 'dist'));
for (const [file, hash] of Object.entries(build.files))
  if (compiled[file] !== hash) throw Error('Build output changed. Run npm run build.');
withInstallationLock(workspace, () => {
  const destination = join(
    workspace,
    host === 'claude-code'
      ? '.claude/skills/glue'
      : host === 'claude-desktop'
        ? '.agents/skills/glue-desktop'
        : '.agents/skills/glue',
  );
  assertUnlinked(destination);
  if (existsSync(destination))
    throw Error(
      'Installation destination is occupied. Remove the development installation explicitly before reinstalling.',
    );
  const connection = connectionChange(workspace, destination, options);
  const exclusions = protectGit ? protectProjectGit(workspace, host) : { verify() {} };
  const staging = mkdtempSync(join(workspace, '.glue-install-'));
  try {
    for (const file of skillFiles(host)) {
      const input = join(source, 'integration/glue', file);
      assertUnlinked(input);
      mkdirSync(dirname(join(staging, file)), { recursive: true });
      cpSync(input, join(staging, file));
    }
    for (const name of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md'])
      cpSync(join(source, name), join(staging, name));
    cpSync(join(source, 'node_modules/smol-toml'), join(staging, 'node_modules/smol-toml'), {
      recursive: true,
      filter: path => {
        if (lstatSync(path).isSymbolicLink()) throw Error('Dependencies must not be linked.');
        return true;
      },
    });
    const runtime = join(staging, 'runtime');
    mkdirSync(runtime);
    for (const name of runtimeModules)
      cpSync(join(source, 'dist', name + '.js'), join(runtime, name + '.js'));
    const sourcePackage = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    writeFileSync(
      join(runtime, 'package.json'),
      JSON.stringify({
        name: sourcePackage.name,
        version: sourcePackage.version,
        private: true,
        type: 'module',
      }),
    );
    // A project-local configuration is recorded relative to the workspace so the installed copy
    // holds no machine path.
    const local = relative(workspace, connection.file);
    const config =
      local && !local.startsWith('..') && !isAbsolute(local)
        ? local.replaceAll('\\', '/')
        : connection.file;
    writeFileSync(
      join(staging, 'connection.json'),
      JSON.stringify({ format: 1, host, name: connection.name, config }),
    );
    cpSync(join(source, 'node_modules/zod'), join(runtime, 'node_modules/zod'), {
      recursive: true,
      filter: path => {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw Error('Dependencies must not be linked.');
        return (
          stat.isDirectory() ||
          path.endsWith('.js') ||
          ['package.json', 'LICENSE'].includes(basename(path))
        );
      },
    });
    cpSync(
      join(source, 'scripts/installation-files.mjs'),
      join(staging, 'scripts/installation-files.mjs'),
    );
    const files = collectFiles(staging);
    const identity = {
      format: 1,
      version: JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version,
      sourceId: build.sourceId,
      packageId: fingerprint(files),
      mode: development ? 'development' : 'workspace',
      files,
    };
    writeFileSync(join(staging, 'installation.json'), JSON.stringify(identity, null, 2));
    mkdirSync(dirname(destination), { recursive: true });
    assertUnlinked(destination);
    if (existsSync(destination)) throw Error('Installation destination became occupied.');
    renameSync(staging, destination);
    try {
      connection.apply(exclusions.verify);
    } catch (error) {
      renameSync(destination, staging);
      throw error;
    }
    console.log(
      JSON.stringify({
        destination,
        workspace,
        version: identity.version,
        sourceId: identity.sourceId,
        packageId: identity.packageId,
        mode: identity.mode,
        tools: TOOL_NAMES,
      }),
    );
  } finally {
    if (existsSync(staging)) {
      const rel = relative(workspace, realpathSync(staging));
      if (
        isAbsolute(rel) ||
        !rel.startsWith('.glue-install-') ||
        rel.includes('/') ||
        rel.includes('\\')
      )
        throw Error('Unexpected cleanup path.');
      rmSync(staging, { recursive: true });
    }
  }
});
