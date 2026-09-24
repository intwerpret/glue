import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { packageClaudeCode } from '../scripts/package-claude-code.mjs';
import { selectProject } from '../integration/glue/project-binding.mjs';
import { collectFiles, fingerprint } from '../scripts/installation-files.mjs';

function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'glue-plugin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'Project space é'),
    other = join(root, 'Other project');
  mkdirSync(project);
  mkdirSync(other);
  return { root, project, other, plugin: join(root, 'Plugin space é') };
}
const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'plugin-test', version: '1' },
  },
};
const call = (name, args) => ({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name, arguments: args },
});
function run(plugin, project, cwd, request) {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  if (project !== undefined) env.CLAUDE_PROJECT_DIR = project;
  return spawnSync(process.execPath, [join(plugin, 'server.mjs')], {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    input:
      [initialize, { jsonrpc: '2.0', method: 'notifications/initialized' }, request]
        .map(JSON.stringify)
        .join('\n') + '\n',
    timeout: 10000,
  });
}

test('the Claude Code plugin has the expected files, no machine paths and a checkable inventory', t => {
  const { plugin, root } = fixture(t),
    receipt = packageClaudeCode(plugin);
  const sourcePackage = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const metadata = JSON.parse(readFileSync(join(plugin, '.claude-plugin/plugin.json')));
  assert.deepEqual(metadata, {
    name: 'glue',
    version: sourcePackage.version,
    description: 'Continue and deliberately reuse selected project work with retained evidence.',
    author: { name: sourcePackage.author },
    homepage: sourcePackage.homepage,
    repository: 'https://github.com/intwerpret/glue',
    license: sourcePackage.license,
  });
  const config = JSON.parse(readFileSync(join(plugin, '.mcp.json')));
  assert.deepEqual(config.mcpServers.glue, {
    command: 'node',
    args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs'],
  });
  const files = collectFiles(plugin);
  assert.deepEqual(files, receipt.files);
  assert.equal(fingerprint(files), receipt.packageId);
  assert.equal(
    Object.keys(files).some(p =>
      /(^|\/)(\.git|\.glue|notes|history|knowledge)(\/|$)|\.map$/.test(p),
    ),
    false,
  );
  assert.ok(files['runtime/node_modules/zod/LICENSE']);
  for (const p of Object.keys(files))
    assert.equal(readFileSync(join(plugin, p)).includes(Buffer.from(root)), false);
  assert.throws(() => packageClaudeCode(plugin), /already exists/);
});

test('the plugin refuses a missing, relative or overlapping project folder', t => {
  const { plugin, project, root } = fixture(t);
  packageClaudeCode(plugin);
  for (const invalid of [
    undefined,
    '.',
    '${CLAUDE_PROJECT_DIR}',
    join(root, 'missing'),
    plugin,
    join(plugin, 'runtime'),
    root,
  ]) {
    const child = run(plugin, invalid, project, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.notEqual(child.status, 0);
    assert.equal(child.stdout, '');
    assert.equal(child.stderr.includes(root), false);
  }
  assert.deepEqual(readdirSync(project), []);
  assert.equal(selectProject(project, plugin), project);
});

test('the plugin uses the project folder the host names, not the working directory', t => {
  const { plugin, project, other } = fixture(t);
  packageClaudeCode(plugin);
  writeFileSync(join(other, 'private.txt'), 'UNSELECTED_OTHER_PROJECT_MARKER');
  const save = run(
    plugin,
    project,
    other,
    call('glue_checkpoint', {
      context: 'notes/lantern.md',
      expectedVersion: null,
      markdown: 'Lantern budget is 500.',
    }),
  );
  assert.equal(save.status, 0, save.stderr);
  const rows = save.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(JSON.parse(rows.at(-1).result.content[0].text).committed, true);
  assert.deepEqual(readdirSync(other), ['private.txt']);
  const resumed = run(plugin, project, other, call('glue_resume', { context: 'notes/lantern.md' }));
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /Lantern budget is 500/);
  assert.doesNotMatch(resumed.stdout, /UNSELECTED_OTHER_PROJECT_MARKER/);
  const isolated = run(
    plugin,
    other,
    project,
    call('glue_resume', { context: 'notes/lantern.md' }),
  );
  assert.equal(
    JSON.parse(JSON.parse(isolated.stdout.trim().split('\n').at(-1)).result.content[0].text)
      .version,
    null,
  );
  const discovery = run(plugin, project, other, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(JSON.parse(discovery.stdout.trim().split('\n').at(-1)).result.tools.length, 6);
  assert.equal(
    fingerprint(collectFiles(plugin)),
    JSON.parse(readFileSync(join(plugin, 'installation.json'))).packageId,
  );
});

test('replacing or removing the plugin keeps saved work', t => {
  const { root, project, other, plugin } = fixture(t);
  packageClaudeCode(plugin);
  const saved = run(
    plugin,
    project,
    other,
    call('glue_checkpoint', {
      context: 'note.md',
      expectedVersion: null,
      markdown: 'Retained through package replacement.',
    }),
  );
  assert.equal(saved.status, 0, saved.stderr);
  const before = collectFiles(project);
  const replacement = join(root, 'Replacement plugin');
  packageClaudeCode(replacement);
  const resumed = run(replacement, project, other, call('glue_resume', { context: 'note.md' }));
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /Retained through package replacement/);
  // plugin is an exact fixture-owned sibling, never the selected project.
  rmSync(plugin, { recursive: true });
  assert.deepEqual(collectFiles(project), before);
});

test('the marketplace package lists the plugin by relative path and includes its license', async t => {
  const { packageMarketplace } = await import('../scripts/package-marketplace.mjs');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'glue-marketplace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'marketplace');
  assert.throws(() => packageMarketplace(output), /owner/);
  const receipt = packageMarketplace(output, 'Synthetic fixture owner');
  const manifest = JSON.parse(
    readFileSync(join(output, '.claude-plugin', 'marketplace.json'), 'utf8'),
  );
  assert.equal(manifest.plugins.length, 1);
  assert.equal(manifest.plugins[0].source, './plugins/glue');
  assert.equal(manifest.plugins[0].version, receipt.version);
  const plugin = JSON.parse(
    readFileSync(join(output, 'plugins', 'glue', '.claude-plugin', 'plugin.json'), 'utf8'),
  );
  assert.equal(plugin.name, manifest.plugins[0].name);
  assert.equal(plugin.author.name, 'Synthetic fixture owner');
  for (const file of ['LICENSE', 'NOTICE', 'plugins/glue/LICENSE', 'plugins/glue/server.mjs'])
    assert.ok(existsSync(join(output, file)), file);
  assert.equal(readFileSync(join(output, 'README.md'), 'utf8').includes(root), false);
  assert.throws(() => packageMarketplace(output, 'Synthetic fixture owner'), /already exists/);
});
