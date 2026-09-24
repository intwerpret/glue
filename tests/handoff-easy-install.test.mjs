import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  rmSync,
  rmdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const installer = resolve('install.mjs');
function fixture(t) {
  const project = mkdtempSync(join(realpathSync(tmpdir()), 'glue-easy-install-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  return project;
}
const run = (cwd, args = []) =>
  spawnSync(process.execPath, [installer, ...args], {
    cwd,
    input: '',
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
  });

test('one command installs for the detected host and adds Glue files to .gitignore', t => {
  for (const [marker, directory, ignored] of [
    [null, '.agents/skills/glue', '.codex/config.toml'],
    ['.claude', '.claude/skills/glue', '.mcp.json'],
  ]) {
    const project = fixture(t);
    assert.equal(
      spawnSync('git', ['init', '--quiet', project], { encoding: 'utf8', windowsHide: true })
        .status,
      0,
    );
    writeFileSync(join(project, '.gitignore'), 'node_modules/');
    if (marker) mkdirSync(join(project, marker));
    const child = run(project);
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, /is installed with 6 tools/);
    assert.equal(existsSync(join(project, directory, 'installation.json')), true);
    const lines = readFileSync(join(project, '.gitignore'), 'utf8').split('\n');
    for (const line of ['node_modules/', '.glue/', directory + '/', ignored])
      assert.ok(lines.includes(line), line);
    const again = run(project);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /Nothing was installed/);
    assert.equal(
      readFileSync(join(project, '.gitignore'), 'utf8')
        .split('\n')
        .filter(line => line === '.glue/').length,
      1,
    );
  }
});

test('install.mjs refuses the source folder, a missing folder and Claude Desktop', t => {
  const project = fixture(t);
  const inSource = run(resolve('.'));
  assert.notEqual(inSource.status, 0);
  assert.match(inSource.stderr, /not from the Glue source folder/);
  const missing = run(project, [join(project, 'missing')]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /does not exist/);
  const desktop = run(project, ['--host', 'claude-desktop']);
  assert.notEqual(desktop.status, 0);
  assert.match(desktop.stderr, /\.mcpb/);
  assert.deepEqual(readdirSync(project), []);
});

function git(project, args) {
  const child = spawnSync('git', ['-C', project, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout;
}

test('an unusable .gitignore stops the install, and the install works once it is fixed', t => {
  for (const host of ['codex', 'claude-code']) {
    const project = fixture(t);
    git(project, ['init', '--quiet']);
    mkdirSync(join(project, '.gitignore'));
    mkdirSync(join(project, '.glue'));
    writeFileSync(join(project, '.glue', 'existing'), 'preserve saved bytes');
    const args = ['--host', host, '--yes'];
    const directory = host === 'codex' ? '.agents/skills/glue' : '.claude/skills/glue';
    const config = host === 'codex' ? '.codex/config.toml' : '.mcp.json';
    const failed = run(project, args);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Git exclusions/);
    assert.equal(existsSync(join(project, directory)), false);
    assert.equal(existsSync(join(project, config)), false);
    assert.equal(readFileSync(join(project, '.glue', 'existing'), 'utf8'), 'preserve saved bytes');
    rmdirSync(join(project, '.gitignore'));
    const fixed = run(project, args);
    assert.equal(fixed.status, 0, fixed.stderr);
    assert.equal(readFileSync(join(project, '.glue', 'existing'), 'utf8'), 'preserve saved bytes');
  }
});

test('a repository that already tracks .glue files stops the install without naming them', t => {
  const project = fixture(t);
  git(project, ['init', '--quiet']);
  mkdirSync(join(project, '.glue'));
  writeFileSync(join(project, '.glue', 'PRIVATE_FIXTURE_NAME'), 'PRIVATE_FIXTURE_BYTES');
  git(project, ['add', '.glue/PRIVATE_FIXTURE_NAME']);
  const before = git(project, ['ls-files', '--stage']);
  const child = run(project, ['--host', 'codex', '--yes']);
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /already tracks/);
  assert.equal((child.stdout + child.stderr).includes('PRIVATE_FIXTURE'), false);
  assert.equal(git(project, ['ls-files', '--stage']), before);
  assert.equal(existsSync(join(project, '.agents/skills/glue')), false);
});

test('exclusions work in nested repositories and override earlier negation rules', t => {
  const repository = fixture(t);
  git(repository, ['init', '--quiet']);
  const project = join(repository, 'nested');
  mkdirSync(project);
  const original = '# PRIVATE_IGNORE_FIXTURE\n.glue/\n!.glue/\n';
  writeFileSync(join(project, '.gitignore'), original);
  const child = run(project, ['--host', 'codex', '--yes']);
  assert.equal(child.status, 0, child.stderr);
  assert.equal((child.stdout + child.stderr).includes('PRIVATE_IGNORE_FIXTURE'), false);
  assert.ok(readFileSync(join(project, '.gitignore'), 'utf8').startsWith(original));
  for (const name of ['.glue/new-file', '.agents/skills/glue/runtime/mcp.js', '.codex/config.toml'])
    assert.equal(git(project, ['check-ignore', '--no-index', name]).trim(), name);
});

test('if .gitignore cannot be written or changes mid-install, only the new package is removed', t => {
  for (const host of ['codex', 'claude-code'])
    for (const failure of ['write', 'activation']) {
      const project = fixture(t);
      git(project, ['init', '--quiet']);
      const directory = host === 'codex' ? '.agents/skills/glue' : '.claude/skills/glue';
      const config = host === 'codex' ? '.codex/config.toml' : '.mcp.json';
      if (host === 'codex') mkdirSync(join(project, '.codex'));
      const configBytes =
        host === 'codex'
          ? '# unrelated setting\n'
          : '{"mcpServers":{"other":{"command":"preserve"}}}\n';
      writeFileSync(join(project, config), configBytes);
      mkdirSync(join(project, '.glue'));
      writeFileSync(join(project, '.glue', 'existing'), 'unchanged');
      const harness = `
      import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; import {join} from 'node:path';
      const project=process.argv[1],host=process.argv[2],failure=process.argv[3],directory=process.argv[4];
      const append=fs.appendFileSync,rename=fs.renameSync;
      fs.appendFileSync=(file,...args)=>{if(failure==='write' && file===join(project,'.gitignore'))throw Error('PRIVATE_IGNORE_FIXTURE');return append(file,...args);};
      fs.renameSync=(from,to)=>{const result=rename(from,to);if(failure==='activation' && to===join(project,directory))fs.writeFileSync(join(project,'.gitignore'),'# PRIVATE_IGNORE_FIXTURE\\n');return result;};
      syncBuiltinESMExports();
      process.argv=[process.execPath,'scripts/install-skill.mjs',project,'--host',host,'--protect-git'];
      await import('./scripts/install-skill.mjs');
    `;
      const child = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', harness, project, host, failure, directory],
        { cwd: resolve('.'), encoding: 'utf8', windowsHide: true, timeout: 30000 },
      );
      assert.notEqual(child.status, 0);
      assert.match(child.stderr, /Git exclusions/);
      assert.equal(child.stderr.includes('PRIVATE_IGNORE_FIXTURE'), false);
      assert.equal(existsSync(join(project, directory)), false);
      assert.equal(readFileSync(join(project, config), 'utf8'), configBytes);
      assert.equal(readFileSync(join(project, '.glue', 'existing'), 'utf8'), 'unchanged');
      assert.equal(
        readdirSync(project).some(name => name.startsWith('.glue-install-')),
        false,
      );
    }
});

test('a .glue/* rule with exceptions still leaves no saved file unignored', t => {
  const project = fixture(t);
  git(project, ['init', '--quiet']);
  mkdirSync(join(project, '.glue'));
  writeFileSync(join(project, '.glue', 'keep'), 'preserved');
  writeFileSync(join(project, '.gitignore'), '.glue/*\n!.glue/keep\n');
  const child = run(project, ['--host', 'codex', '--yes']);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(git(project, ['check-ignore', '--no-index', '.glue/keep']).trim(), '.glue/keep');
  assert.equal(readFileSync(join(project, '.glue', 'keep'), 'utf8'), 'preserved');
});

test('checking .gitignore runs no hooks or commands from the repository', async t => {
  const { protectProjectGit } = await import('../scripts/project-exclusions.mjs');
  const project = fixture(t);
  git(project, ['init', '--quiet']);
  const marker = join(project, 'executed'),
    script = join(project, 'monitor.cjs');
  writeFileSync(
    script,
    'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "ran")\n',
  );
  const command =
    '"' + process.execPath.replaceAll('\\', '/') + '" "' + script.replaceAll('\\', '/') + '"';
  writeFileSync(join(project, 'tracked.txt'), 'tracked');
  git(project, ['add', 'tracked.txt']);
  git(project, ['config', 'core.fsmonitor', command]);
  mkdirSync(join(project, '.git', 'hooks'), { recursive: true });
  writeFileSync(
    join(project, '.git', 'hooks', 'post-index-change'),
    '#!/bin/sh\n' + command + '\n',
    { mode: 0o755 },
  );
  // Confirm that this Git would run the configured command, so the assertion below is meaningful.
  spawnSync('git', ['-C', project, 'ls-files'], { encoding: 'utf8', windowsHide: true });
  if (!existsSync(marker)) {
    t.skip('this Git does not run a configured fsmonitor command');
    return;
  }
  rmSync(marker);
  protectProjectGit(project, 'claude-code').verify();
  assert.equal(existsSync(marker), false);
  assert.match(readFileSync(join(project, '.gitignore'), 'utf8'), /^\.glue\/$/m);
});
