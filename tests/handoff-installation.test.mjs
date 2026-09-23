import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectFiles } from '../scripts/installation-files.mjs';
import { runtimeModules } from '../scripts/runtime-files.mjs';
const root = resolve('.');
function fixture(t) {
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), 'glue-install-test-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  return workspace;
}
function run(args, input) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    input,
    encoding: 'utf8',
    windowsHide: true,
  });
}
function node(args, input) {
  const mcp = /[\\/]runtime[\\/]mcp\.js$/.test(args[0]);
  if (mcp)
    input =
      [
        {
          jsonrpc: '2.0',
          id: 'initialize',
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'glue-test', version: '1.0' },
          },
        },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
      ]
        .map(value => JSON.stringify(value))
        .join('\n') +
      '\n' +
      input;
  const p = run(args, input);
  assert.equal(p.status, 0, p.stdout + '\n' + p.stderr);
  return JSON.parse(mcp ? p.stdout.trim().split('\n').at(-1) : p.stdout);
}
test('fresh Codex installation preserves unrelated configuration and supports MCP and recovery', t => {
  const workspace = fixture(t);
  mkdirSync(join(workspace, '.codex'));
  writeFileSync(join(workspace, '.codex/config.toml'), 'model = "example"\n');
  const installed = node(['scripts/install-skill.mjs', workspace]),
    skill = installed.destination;
  assert.ok(
    readFileSync(join(workspace, '.codex/config.toml'), 'utf8').startsWith('model = "example"\n'),
  );
  assert.deepEqual(
    readdirSync(join(skill, 'runtime'))
      .filter(n => n.endsWith('.js'))
      .sort(),
    runtimeModules.map(name => name + '.js').sort(),
  );
  assert.equal(
    JSON.parse(readFileSync(join(skill, 'installation.json'), 'utf8')).packageId,
    installed.packageId,
  );
  assert.equal(existsSync(join(skill, 'release.json')), false);
  assert.equal(node([join(skill, 'scripts/check.mjs')]).ok, true);
  const call = (name, args) => {
    const r = node(
      [join(skill, 'runtime/mcp.js'), workspace],
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }) + '\n',
    );
    assert.notEqual(r.result.isError, true);
    return JSON.parse(r.result.content[0].text);
  };
  const saved = call('glue_checkpoint', {
    context: 'handoff.md',
    expectedVersion: null,
    markdown: 'First handoff',
  });
  assert.equal(saved.committed, true);
  assert.equal(call('glue_resume', { context: 'handoff.md' }).markdown, 'First handoff');
  assert.equal(call('glue_find', { query: 'First' }).results[0].version, saved.version);
  assert.equal(
    call('glue_read', { context: 'handoff.md', version: saved.version }).text,
    'First handoff',
  );
  const recovery = q =>
    node([join(skill, 'runtime/recovery.js'), workspace, '-'], JSON.stringify(q));
  const inspect = recovery({ action: 'inspect', context: 'handoff.md' });
  assert.equal(inspect.revisions.length, 1);
  assert.equal(
    recovery({
      action: 'restore',
      context: 'handoff.md',
      version: saved.version,
      expectedHeadHash: inspect.headHash,
      workingCopyHash: inspect.workingCopyHash,
    }).restored,
    true,
  );
  const duplicate = run(
    [join(skill, 'runtime/recovery.js'), workspace, '-'],
    JSON.stringify({ action: 'checkpoint' }),
  );
  assert.notEqual(duplicate.status, 0);
  const before = collectFiles(workspace);
  assert.notEqual(run(['scripts/install-skill.mjs', workspace]).status, 0);
  assert.deepEqual(collectFiles(workspace), before);
});

test('development install pins an independent runtime and detects installed drift', t => {
  const source = fixture(t);
  for (const path of [
    'src',
    'dist',
    'scripts',
    'integration',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'LICENSE',
    'NOTICE',
    'THIRD-PARTY-NOTICES.md',
    'node_modules/zod',
    'node_modules/smol-toml',
  ])
    cpSync(join(root, path), join(source, path), { recursive: true });
  const installer = join(source, 'scripts/install-skill.mjs');
  assert.notEqual(run([installer, source]).status, 0);
  const installed = node([installer, source, '--development']);
  assert.equal(installed.mode, 'development');
  const runtime = join(installed.destination, 'runtime/mcp.js');
  const pinned = readFileSync(runtime, 'utf8');
  writeFileSync(join(source, 'dist/mcp.js'), 'throw Error("candidate is broken");');
  writeFileSync(join(source, 'src/mcp.ts'), '// source under development');
  const check = join(installed.destination, 'scripts/check.mjs');
  assert.equal(node([check]).packageId, installed.packageId);
  assert.equal(readFileSync(runtime, 'utf8'), pinned);
  const response = node(
    [runtime, source],
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'glue_checkpoint',
        arguments: {
          context: 'notes/development.md',
          expectedVersion: null,
          markdown: 'Continue development using the pinned build.',
        },
      },
    }) + '\n',
  );
  assert.equal(JSON.parse(response.result.content[0].text).committed, true);
  writeFileSync(runtime, pinned + '\n// changed installed package');
  assert.notEqual(run([check]).status, 0);
});
test('unsupported installation options and conflicting MCP configuration leave workspace unchanged', t => {
  const workspace = fixture(t);
  for (const option of ['--update', '--dry-run', '--unknown'])
    assert.notEqual(run(['scripts/install-skill.mjs', workspace, option]).status, 0);
  assert.deepEqual(readdirSync(workspace), []);
  mkdirSync(join(workspace, '.codex'));
  writeFileSync(
    join(workspace, '.codex/config.toml'),
    '[mcp_servers.glue]\ncommand = "unrelated"\n',
  );
  const before = collectFiles(workspace);
  const failed = run(['scripts/install-skill.mjs', workspace]);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /unrelated/);
  assert.deepEqual(collectFiles(workspace), before);
});
test('failed configuration activation cleans the staged fresh package', t => {
  const workspace = fixture(t);
  const failed = run([
    '--input-type=module',
    '-e',
    `
  import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
  import {join} from 'node:path';
  const workspace=process.argv[1],original=fs.renameSync;
  fs.renameSync=(from,to)=>{if(to===join(workspace,'.codex/config.toml'))throw Error('Injected activation failure');return original(from,to);};
  syncBuiltinESMExports();process.argv=[process.execPath,'scripts/install-skill.mjs',workspace];
  await import('./scripts/install-skill.mjs');
 `,
    workspace,
  ]);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Injected activation failure/);
  assert.deepEqual(readdirSync(join(workspace, '.codex')), []);
  assert.equal(existsSync(join(workspace, '.agents/skills/glue')), false);
  assert.equal(
    readdirSync(workspace).some(n => n.startsWith('.glue-install-')),
    false,
  );
});

test('existing Glue connections in alternate TOML forms are preserved and refused', t => {
  const configurations = [
    '[mcp_servers]\nglue = { command = "existing-server" }\n',
    'mcp_servers.glue.command = "existing-server"\n',
    '["mcp_servers".\'glue\']\ncommand = "existing-server"\n',
    '[mcp_servers."gl\\u0075e"]\ncommand = "existing-server"\n',
    '[mcp_servers.glue.env]\nEXAMPLE = "value"\n',
    '[mcp_servers.glue]\nurl = "https://example.invalid/mcp"\n',
  ];
  for (const config of configurations) {
    const workspace = fixture(t);
    mkdirSync(join(workspace, '.codex'));
    writeFileSync(join(workspace, '.codex/config.toml'), config);
    const before = collectFiles(workspace),
      failed = run(['scripts/install-skill.mjs', workspace]);
    assert.notEqual(failed.status, 0, config);
    assert.match(failed.stderr, /Existing Glue connection/);
    assert.deepEqual(collectFiles(workspace), before);
    assert.deepEqual(readdirSync(workspace), ['.codex']);
  }
});

test('invalid or unextendable configuration is refused before installation writes', t => {
  for (const config of [
    'model = "unterminated\n',
    'model = "one"\nmodel = "two"\n',
    'mcp_servers = "wrong type"\n',
    'mcp_servers = { other = { command = "preserve" } }\n',
    Buffer.from([0xff, 0xfe, 0x61]),
  ]) {
    const workspace = fixture(t);
    mkdirSync(join(workspace, '.codex'));
    writeFileSync(join(workspace, '.codex/config.toml'), config);
    const before = collectFiles(workspace),
      failed = run(['scripts/install-skill.mjs', workspace]);
    assert.notEqual(failed.status, 0, String(config));
    assert.match(failed.stderr, /configuration|TOML|UTF-8/);
    assert.deepEqual(collectFiles(workspace), before);
    assert.deepEqual(readdirSync(workspace), ['.codex']);
  }
});

test('installation preserves comments, CRLF, Unicode and unrelated server settings exactly', t => {
  const workspace = fixture(t);
  mkdirSync(join(workspace, '.codex'));
  const original =
    '# Keep this comment — 计划\r\nmodel = "example"\r\n[mcp_servers.other]\r\nurl = "https://example.invalid/mcp"\r\n';
  writeFileSync(join(workspace, '.codex/config.toml'), original);
  const { destination } = node(['scripts/install-skill.mjs', workspace]);
  const after = readFileSync(join(workspace, '.codex/config.toml'));
  assert.deepEqual(after.subarray(0, Buffer.byteLength(original)), Buffer.from(original));
  assert.equal(node([join(destination, 'scripts/check.mjs')]).ok, true);
  assert.equal(existsSync(join(destination, 'runtime/node_modules/smol-toml')), false);
});

test('installed checker validates actual TOML values rather than matching text anywhere', t => {
  const workspace = fixture(t),
    { destination } = node(['scripts/install-skill.mjs', workspace]);
  const config = join(workspace, '.codex/config.toml'),
    check = join(destination, 'scripts/check.mjs');
  const command = JSON.stringify(process.execPath),
    args = JSON.stringify([join(destination, 'runtime/mcp.js'), workspace]);
  writeFileSync(config, `[mcp_servers]\nglue = { args = ${args}, command = ${command} }\n`);
  assert.equal(node([check]).ok, true);
  const invalid = [
    [
      `[mcp_servers]\nglue = { command = "existing-server" }\n[mcp_servers.glue]\ncommand = ${command}\nargs = ${args}\n`,
      /Invalid.*TOML/,
    ],
    [
      `# [mcp_servers.glue]\n# command = ${command}\n# args = ${args}\n[mcp_servers.other]\ncommand = "other"\n`,
      /does not match this local installation/,
    ],
    [
      `[mcp_servers.glue]\ncommand = "other"\nargs = []\n[mcp_servers.other]\ncommand = ${command}\nargs = ${args}\n`,
      /does not match this local installation/,
    ],
    [
      '[mcp_servers.glue]\nurl = "https://example.invalid/mcp"\n',
      /does not match this local installation/,
    ],
    [Buffer.from([0xff, 0xfe, 0x61]), /UTF-8/],
  ];
  for (const [text, message] of invalid) {
    writeFileSync(config, text);
    const before = collectFiles(workspace),
      failed = run([check]);
    assert.notEqual(failed.status, 0, String(text));
    assert.match(failed.stderr, message);
    assert.deepEqual(collectFiles(workspace), before);
  }
});

test('installation preserves an existing configuration recovery file', t => {
  const workspace = fixture(t);
  mkdirSync(join(workspace, '.codex'));
  const config = join(workspace, '.codex/config.toml');
  writeFileSync(config, 'model = "example"\n');
  writeFileSync(config + '.tmp', 'User-owned recovery copy\n');
  const { destination } = node(['scripts/install-skill.mjs', workspace]);
  assert.equal(readFileSync(config + '.tmp', 'utf8'), 'User-owned recovery copy\n');
  assert.ok(readFileSync(config, 'utf8').startsWith('model = "example"\n'));
  assert.equal(node([join(destination, 'scripts/check.mjs')]).ok, true);
  assert.deepEqual(readdirSync(join(workspace, '.codex')).sort(), [
    'config.toml',
    'config.toml.tmp',
  ]);
});

test('checker refuses disabled and filtered required tools', t => {
  const workspace = fixture(t),
    { destination } = node(['scripts/install-skill.mjs', workspace]);
  const file = join(workspace, '.codex/config.toml'),
    original = readFileSync(file, 'utf8'),
    check = join(destination, 'scripts/check.mjs');
  for (const field of [
    'enabled = false',
    'enabled_tools = []',
    'disabled_tools = ["glue_resume"]',
  ]) {
    writeFileSync(file, original + '\n' + field + '\n');
    const failed = run([check]);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /disabled|filters out/);
  }
  writeFileSync(file, original + '\nenabled = true\ndisabled_tools = ["unrelated"]\n');
  assert.equal(node([check]).ok, true);
});

test('Claude Code project install preserves unrelated JSON settings and binds the workspace', t => {
  const workspace = fixture(t),
    file = join(workspace, '.mcp.json');
  const unrelated = {
    preferences: { theme: 'dark' },
    mcpServers: { other: { command: 'existing', args: ['unchanged'] } },
  };
  writeFileSync(file, JSON.stringify(unrelated));
  const { destination } = node(['scripts/install-skill.mjs', workspace, '--host', 'claude-code']);
  assert.equal(destination, join(workspace, '.claude/skills/glue'));
  const config = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(config.preferences, unrelated.preferences);
  assert.deepEqual(config.mcpServers.other, unrelated.mcpServers.other);
  assert.equal(config.mcpServers.glue.args[1], workspace);
  const check = node([join(destination, 'scripts/check.mjs')]);
  assert.equal(check.host, 'claude-code');
  assert.equal(check.nativeLoadingVerified, false);
  assert.equal(existsSync(join(workspace, '.codex')), false);
});

test('Claude JSON rejects duplicate keys, unsafe integers and conflicts without disclosure or writes', t => {
  for (const text of [
    '{"mcpServers":{},"mcpServers":{}}',
    '{"other":{"key":1,"key":2}}',
    '{"count":9007199254740993}',
    '{"count":1e400}',
    '{"count":0.1234567890123456789}',
    '{"count":1e-999}',
    '{"mcpServers":{"glue":{"command":"existing"}}}',
    '{"mcpServers":[]}',
    '{"secret":"FAKE_PRIVATE_MARKER", bad}',
  ]) {
    const workspace = fixture(t),
      file = join(workspace, '.mcp.json');
    writeFileSync(file, text);
    const before = collectFiles(workspace),
      result = run(['scripts/install-skill.mjs', workspace, '--host', 'claude-code']);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /FAKE_PRIVATE_MARKER/);
    assert.deepEqual(collectFiles(workspace), before);
  }
});

test('Desktop requires an explicit config and project name and keeps other project bindings', t => {
  const workspace = fixture(t),
    other = fixture(t),
    config = join(other, 'claude_desktop_config.json');
  for (const options of [
    [],
    ['--config', config],
    ['--name', 'project-a'],
    ['--config', 'relative.json', '--name', 'project-a'],
  ]) {
    assert.notEqual(
      run(['scripts/install-skill.mjs', workspace, '--host', 'claude-desktop', ...options]).status,
      0,
    );
    assert.deepEqual(readdirSync(workspace), []);
  }
  writeFileSync(
    config,
    JSON.stringify({ mcpServers: { 'project-b': { command: 'node', args: ['other-project'] } } }),
  );
  const { destination } = node([
    'scripts/install-skill.mjs',
    workspace,
    '--host',
    'claude-desktop',
    '--config',
    config,
    '--name',
    'project-a',
  ]);
  const settings = JSON.parse(readFileSync(config, 'utf8'));
  assert.deepEqual(settings.mcpServers['project-b'], { command: 'node', args: ['other-project'] });
  assert.equal(settings.mcpServers['project-a'].args[1], workspace);
  assert.equal(node([join(destination, 'scripts/check.mjs')]).host, 'claude-desktop');
  settings.mcpServers['project-a'].args[1] = other;
  writeFileSync(config, JSON.stringify(settings));
  const failed = run([join(destination, 'scripts/check.mjs')]);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /does not match/);
});

test('shared Desktop configuration contention preserves unrelated settings and rolls back package', t => {
  const workspace = fixture(t),
    profile = fixture(t),
    config = join(profile, 'claude_desktop_config.json');
  const previous = JSON.stringify({ mcpServers: { other: { command: 'existing' } } });
  writeFileSync(config, previous);
  const lock = join(profile, '.glue-host-connection-lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  const result = run([
    'scripts/install-skill.mjs',
    workspace,
    '--host',
    'claude-desktop',
    '--config',
    config,
    '--name',
    'project-a',
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /host configuration operation/);
  assert.equal(readFileSync(config, 'utf8'), previous);
  assert.equal(existsSync(join(workspace, '.agents/skills/glue-desktop')), false);
  assert.ok(existsSync(join(lock, 'owner.json')));
});

test('workspace installs copy an explicit host-specific inventory and record no machine path for project-local configuration', t => {
  for (const [host, directory] of [
    ['codex', '.agents/skills/glue'],
    ['claude-code', '.claude/skills/glue'],
  ]) {
    const workspace = fixture(t);
    const installed = node(['scripts/install-skill.mjs', workspace, '--host', host]);
    const files = Object.keys(collectFiles(installed.destination)).filter(
      file => !file.includes('node_modules/') && !file.startsWith('runtime/'),
    );
    assert.deepEqual(
      files.sort(),
      [
        'LICENSE',
        'NOTICE',
        'THIRD-PARTY-NOTICES.md',
        'SKILL.md',
        ...(host === 'codex' ? ['agents/openai.yaml'] : []),
        'connection.json',
        'references/hosts.md',
        'references/maintenance.md',
        'scripts/check.mjs',
        'scripts/configuration.mjs',
        'scripts/installation-files.mjs',
      ].sort(),
    );
    const binding = JSON.parse(readFileSync(join(workspace, directory, 'connection.json'), 'utf8'));
    assert.equal(binding.config, host === 'codex' ? '.codex/config.toml' : '.mcp.json');
    assert.equal(
      readFileSync(join(workspace, directory, 'connection.json'), 'utf8').includes(tmpdir()),
      false,
    );
    assert.equal(node([join(installed.destination, 'scripts/check.mjs')]).ok, true);
  }
});
