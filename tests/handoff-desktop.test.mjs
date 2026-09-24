import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { packageClaudeDesktop } from '../scripts/package-claude-desktop.mjs';
import { collectFiles, fingerprint } from '../scripts/installation-files.mjs';

function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'glue-desktop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'Selected project é'),
    other = join(root, 'Unselected');
  mkdirSync(project);
  mkdirSync(other);
  return { root, project, other, bundle: join(root, 'Bundle space') };
}
function run(bundle, selected, cwd, call, hostArguments = []) {
  const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json')));
  const env = { ...process.env, CLAUDE_PROJECT_DIR: cwd };
  delete env.GLUE_PROJECT_DIR;
  if (selected !== undefined)
    env.GLUE_PROJECT_DIR = manifest.server.mcp_config.env.GLUE_PROJECT_DIR.replace(
      '${user_config.project_folder}',
      selected,
    );
  const args = manifest.server.mcp_config.args
    .map(x => x.replace('${__dirname}', bundle))
    .concat(hostArguments);
  return spawnSync(process.execPath, args, {
    cwd,
    env,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10000,
    input:
      [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'desktop-fixture', version: '1' },
          },
        },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        ...(call ? [{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: call }] : []),
      ]
        .map(JSON.stringify)
        .join('\n') + '\n',
  });
}
const result = child => {
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(JSON.parse(child.stdout.trim().split('\n').at(-1)).result.content[0].text);
};

test('the Desktop extension needs an author and asks for exactly one project folder', t => {
  const { bundle } = fixture(t);
  assert.throws(() => packageClaudeDesktop(bundle), /author/);
  assert.equal(existsSync(bundle), false);
  const receipt = packageClaudeDesktop(bundle, 'Synthetic fixture author');
  const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json')));
  assert.equal(manifest.author.name, 'Synthetic fixture author');
  assert.equal(manifest.user_config.project_folder.required, true);
  assert.equal(manifest.user_config.project_folder.multiple, false);
  assert.equal(manifest.user_config.project_folder.type, 'directory');
  assert.equal(Object.hasOwn(manifest.user_config.project_folder, 'default'), false);
  assert.deepEqual(collectFiles(bundle), receipt.files);
  assert.equal(existsSync(join(bundle, '.mcp.json')), false);
  assert.equal(existsSync(join(bundle, '.claude-plugin')), false);
});

test('the Desktop extension refuses to start without a valid project folder', t => {
  const { root, bundle, project } = fixture(t);
  packageClaudeDesktop(bundle, 'Synthetic fixture author');
  for (const value of [
    undefined,
    '.',
    '${user_config.project_folder}',
    join(root, 'missing'),
    bundle,
    root,
  ]) {
    const child = run(bundle, value, project);
    assert.notEqual(child.status, 0);
    assert.equal(child.stdout, '');
    assert.equal(child.stderr.includes(root), false);
  }
  assert.deepEqual(readdirSync(project), []);
});

test('the Desktop extension uses only the chosen folder and keeps history across restarts', t => {
  const { bundle, project, other } = fixture(t);
  const receipt = packageClaudeDesktop(bundle, 'Synthetic fixture author');
  writeFileSync(join(other, 'private.txt'), 'OTHER_PROJECT_PRIVATE_MARKER');
  const saved = result(
    run(bundle, project, other, {
      name: 'glue_checkpoint',
      arguments: { context: 'note.md', expectedVersion: null, markdown: 'Fictional budget 500.' },
    }),
  );
  const resumed = result(
    run(bundle, project, other, { name: 'glue_resume', arguments: { context: 'note.md' } }),
  );
  assert.equal(resumed.version, saved.version);
  assert.equal(resumed.markdown, 'Fictional budget 500.');
  result(
    run(bundle, project, other, {
      name: 'glue_checkpoint',
      arguments: {
        context: 'note.md',
        expectedVersion: saved.version,
        markdown: 'Fictional budget 350.',
      },
    }),
  );
  const old = result(
    run(bundle, project, other, {
      name: 'glue_read',
      arguments: { context: 'note.md', version: saved.version },
    }),
  );
  assert.equal(old.text, 'Fictional budget 500.');
  assert.equal(
    result(run(bundle, other, project, { name: 'glue_resume', arguments: { context: 'note.md' } }))
      .version,
    null,
  );
  assert.deepEqual(readdirSync(other), ['private.txt']);
  assert.equal(fingerprint(collectFiles(bundle)), receipt.packageId);
  const discovery = run(bundle, project, other);
  assert.equal(JSON.parse(discovery.stdout.trim().split('\n').at(-1)).result.tools.length, 6);
});

test('the Desktop extension ignores extra arguments from the host when choosing the project', t => {
  const { bundle, project, other } = fixture(t);
  packageClaudeDesktop(bundle, 'Synthetic fixture author');
  const child = run(bundle, project, project, undefined, ['--host-added-flag', other]);
  assert.equal(child.status, 0, child.stderr);
  const rows = child.stdout
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.equal(rows.at(-1).result.tools.length, 6);
  assert.deepEqual(readdirSync(other), []);
});

test('a failed Desktop start exits at once and names the failed step without paths', t => {
  const { root, bundle, project } = fixture(t);
  packageClaudeDesktop(bundle, 'Synthetic fixture author');
  const child = run(bundle, join(root, 'missing'), project);
  assert.equal(child.status, 1);
  assert.equal(child.signal, null);
  assert.match(child.stderr, /could not start or serve \(project-folder, Node \d+/);
  assert.equal(child.stderr.includes(root), false);
});

test('the Desktop extension also loads through require()', t => {
  const { bundle, project } = fixture(t);
  packageClaudeDesktop(bundle, 'Synthetic fixture author');
  const lf = String.fromCharCode(10);
  const input =
    [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'desktop-fixture', version: '1' },
        },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]
      .map(JSON.stringify)
      .join(lf) + lf;
  // require() refuses any module graph that uses top-level await, before running a line of it.
  for (const entry of ['server.mjs', 'runtime/mcp.js']) {
    const child = spawnSync(
      process.execPath,
      ['-e', 'require(process.argv[1])', join(bundle, entry)],
      {
        cwd: project,
        env: { ...process.env, GLUE_PROJECT_DIR: project },
        input,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
      },
    );
    assert.doesNotMatch(child.stderr, /ERR_REQUIRE_ASYNC_MODULE/, entry);
  }
  const served = spawnSync(
    process.execPath,
    ['-e', 'require(process.argv[1])', join(bundle, 'server.mjs')],
    {
      cwd: project,
      env: { ...process.env, GLUE_PROJECT_DIR: project },
      input,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    },
  );
  assert.equal(served.status, 0, served.stderr);
  assert.equal(JSON.parse(served.stdout.trim().split(lf).at(-1)).result.tools.length, 6);
});
