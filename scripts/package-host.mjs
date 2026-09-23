import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  mkdtempSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInputs } from './build-inputs.mjs';
import { collectFiles, fingerprint } from './installation-files.mjs';
import { runtimeModules } from './runtime-files.mjs';
import { assertUnlinked } from '../dist/storage.js';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function packageHost(destination, host, author) {
  if (!['claude-code', 'claude-desktop'].includes(host)) throw Error('Unsupported package host.');
  if (
    author !== undefined &&
    (typeof author !== 'string' ||
      !author.trim() ||
      author.length > 200 ||
      /[\x00-\x1f]/.test(author))
  )
    throw Error('Supply a valid explicitly selected author name.');
  if (host === 'claude-desktop' && !author)
    throw Error('Desktop packaging requires an explicitly selected author name.');
  const output = resolve(destination);
  assertUnlinked(output);
  if (existsSync(output))
    throw Error('Plugin output already exists. Choose a new output directory.');
  const build = JSON.parse(readFileSync(join(source, 'dist/build.json'), 'utf8'));
  if (build.sourceId !== buildInputs(source))
    throw Error('Source changed. Build before packaging.');
  const actual = collectFiles(join(source, 'dist'));
  for (const [file, hash] of Object.entries(build.files))
    if (actual[file] !== hash) throw Error('Compiled output changed. Build before packaging.');
  const packageInfo = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  const version = packageInfo.version;
  mkdirSync(dirname(output), { recursive: true });
  const parent = realpathSync(dirname(output));
  const stage = mkdtempSync(join(parent, '.glue-plugin-stage-'));
  try {
    const json = (file, value) => {
      mkdirSync(dirname(join(stage, file)), { recursive: true });
      writeFileSync(join(stage, file), JSON.stringify(value, null, 2) + '\n');
    };
    const copy = (from, to) => {
      const input = join(source, from);
      assertUnlinked(input);
      mkdirSync(dirname(join(stage, to)), { recursive: true });
      cpSync(input, join(stage, to));
    };
    const description =
      'Continue and deliberately reuse selected project work with retained evidence.';
    if (host === 'claude-code') {
      json('.claude-plugin/plugin.json', {
        name: 'glue',
        version,
        description,
        author: { name: author ?? packageInfo.author },
        homepage: packageInfo.homepage,
        repository: packageInfo.repository.url.replace(/^git\+/, '').replace(/\.git$/, ''),
        license: packageInfo.license,
      });
      json('.mcp.json', {
        mcpServers: { glue: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs'] } },
      });
      copy('integration/glue/SKILL.md', 'skills/glue/SKILL.md');
      for (const name of ['maintenance.md', 'hosts.md'])
        copy('integration/glue/references/' + name, 'skills/glue/references/' + name);
    } else {
      json('manifest.json', {
        manifest_version: '0.3',
        name: 'glue',
        display_name: 'Glue',
        version,
        description,
        author: { name: author },
        server: {
          type: 'node',
          entry_point: 'server.mjs',
          mcp_config: {
            command: 'node',
            args: ['${__dirname}/server.mjs'],
            env: { GLUE_PROJECT_DIR: '${user_config.project_folder}' },
          },
        },
        user_config: {
          project_folder: {
            type: 'directory',
            title: 'Project folder',
            description:
              'Select one project for Glue to save and resume. Saved work remains here when the extension is removed.',
            required: true,
            multiple: false,
          },
        },
        compatibility: { platforms: ['win32', 'darwin'], runtimes: { node: '>=22' } },
        tools_generated: true,
      });
      copy('integration/glue/SKILL.md', 'guidance.md');
      copy('integration/glue/references/maintenance.md', 'references/maintenance.md');
      copy('integration/glue/references/hosts.md', 'references/hosts.md');
    }
    copy('integration/' + host + '/server.mjs', 'server.mjs');
    copy('integration/' + host + '/README.md', 'README.md');
    copy('integration/glue/project-binding.mjs', 'project-binding.mjs');
    for (const name of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']) copy(name, name);
    for (const name of runtimeModules) copy('dist/' + name + '.js', 'runtime/' + name + '.js');
    json('runtime/package.json', { name: 'glue-runtime', version, private: true, type: 'module' });
    const dependencyFiles = collectFiles(join(source, 'node_modules/zod'));
    for (const file of Object.keys(dependencyFiles))
      if (
        file.endsWith('.js') ||
        file.endsWith('/package.json') ||
        file === 'package.json' ||
        file === 'LICENSE'
      )
        copy('node_modules/zod/' + file, 'runtime/node_modules/zod/' + file);
    if (build.sourceId !== buildInputs(source))
      throw Error('Source changed while packaging. Retry after building.');
    const files = collectFiles(stage);
    for (const name of runtimeModules)
      if (files['runtime/' + name + '.js'] !== build.files[name + '.js'])
        throw Error('Compiled output changed during packaging. Build and try again.');
    for (const [file, hash] of Object.entries(dependencyFiles))
      if (
        files['runtime/node_modules/zod/' + file] !== undefined &&
        files['runtime/node_modules/zod/' + file] !== hash
      )
        throw Error('Dependency bytes changed during packaging. Inspect before retrying.');
    const manifest = {
      format: 1,
      host,
      version,
      sourceId: build.sourceId,
      packageId: fingerprint(files),
      files,
    };
    json('installation.json', manifest);
    assertUnlinked(output);
    if (existsSync(output)) throw Error('Plugin output became occupied.');
    renameSync(stage, output);
    return { destination: output, ...manifest, nativeLoadingVerified: false };
  } finally {
    if (existsSync(stage)) {
      assertUnlinked(stage);
      const child = relative(parent, realpathSync(stage));
      if (
        isAbsolute(child) ||
        !child.startsWith('.glue-plugin-stage-') ||
        child.includes('/') ||
        child.includes('\\')
      )
        throw Error('Unexpected staging cleanup path.');
      rmSync(stage, { recursive: true });
    }
  }
}
