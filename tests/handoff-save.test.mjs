import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Handoffs } from '../dist/handoff.js';
import { Knowledge } from '../dist/knowledge.js';

function fixture(t) {
  const workspace = mkdtempSync(join(fs.realpathSync(tmpdir()), 'glue-save-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const store = new Handoffs(workspace);
  return { workspace, store, knowledge: new Knowledge(store) };
}
const first = (markdown = '# Context\nOriginal user decision.') => ({
  context: 'notes/handoff.md',
  expectedVersion: null,
  markdown,
  evidence: [],
});
const SECRET = 'password=FAKE_SYNTHETIC_SECRET_VALUE_1234';
const capture = (id, text) => ({
  id,
  label: 'Fictional capture',
  representation: 'excerpt',
  basis: 'synthetic',
  scope: 'test',
  base64: Buffer.from(text).toString('base64'),
});

test('resume writes nothing, a save keeps the exact text, and repeating the save replays it', t => {
  const { store, workspace } = fixture(t);
  assert.equal(store.resume({ context: 'notes/handoff.md' }).version, null);
  assert.equal(existsSync(join(workspace, '.glue')), false);
  const request = first('# 计划\n  Exact user wording 🙂\n'),
    r = store.save(request);
  assert.equal(r.committed, true);
  assert.equal(r.workingCopyUpdated, true);
  assert.equal(
    store.resume({ context: 'notes/handoff.md' }).markdown,
    '# 计划\n  Exact user wording 🙂\n',
  );
  assert.equal(
    readFileSync(join(workspace, 'notes/handoff.md'), 'utf8'),
    '# 计划\n  Exact user wording 🙂\n',
  );
  const replay = store.save(request);
  assert.equal(replay.committed, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.workingCopyUpdated, false);
  assert.equal(replay.version, r.version);
  assert.equal('next' in replay, false);
  assert.equal(store.resume({ context: request.context }).workingCopy.status, 'matches');
  assert.equal(readdirSync(join(store.location(request.context).directory, 'revisions')).length, 1);
});

test('a retried save after newer work replays the original; a different stale save is refused', t => {
  const { store } = fixture(t),
    request = first(),
    a = store.save(request);
  const b = store.save({
    context: request.context,
    expectedVersion: a.version,
    markdown: 'Second checkpoint',
    evidence: [],
  });
  const replay = store.save(request);
  assert.equal(replay.version, a.version);
  assert.equal(replay.replayed, true);
  assert.equal(replay.currentVersion, b.version);
  assert.equal(replay.workingCopyUpdated, false);
  assert.equal(store.resume({ context: request.context }).workingCopy.status, 'matches');
  assert.throws(
    () => store.save({ ...request, markdown: 'stale alternative' }),
    /Version conflict/,
  );
  assert.equal(store.resume({ context: request.context }).markdown, 'Second checkpoint');
});

test('a corrupt older revision does not block new saves, but a corrupt current revision does', t => {
  const { store } = fixture(t),
    request = first(),
    a = store.save(request);
  const b = store.save({
      ...request,
      expectedVersion: a.version,
      markdown: 'Healthy current revision',
    }),
    loc = store.location(request.context);
  writeFileSync(join(loc.directory, 'revisions', a.version + '.json'), 'corrupt older revision');
  const original = store.revision.bind(store),
    reads = [];
  store.revision = (directory, version) => {
    reads.push(version);
    return original(directory, version);
  };
  const c = store.save({ ...request, expectedVersion: b.version, markdown: 'New work' });
  assert.equal(c.committed, true);
  assert.equal(c.replayed, false);
  assert.deepEqual(reads, [b.version]);
  const inspection = store.inspect(request.context);
  assert.equal(inspection.revisions.find(r => r.version === a.version).valid, false);
  assert.equal(inspection.revisions.find(r => r.version === c.version).valid, true);
  assert.throws(() => store.save(request), /integrity/);
  assert.equal(store.head(request.context).version, c.version);
  writeFileSync(join(loc.directory, 'revisions', c.version + '.json'), 'corrupt current revision');
  assert.throws(
    () =>
      store.save({
        ...request,
        expectedVersion: c.version,
        markdown: 'Must not ignore damaged HEAD',
      }),
    /integrity/,
  );
});

test('after a restore, only saves still in the restored history count as retries', t => {
  const { store } = fixture(t),
    request = first(),
    a = store.save(request);
  const second = { ...request, expectedVersion: a.version, markdown: 'Second revision' },
    b = store.save(second);
  const third = { ...request, expectedVersion: b.version, markdown: 'Third revision' };
  store.save(third);
  const inspection = store.inspect(request.context);
  store.restore(request.context, a.version, inspection.headHash, inspection.workingCopyHash);
  assert.throws(() => store.save(third), /Version conflict/);
  assert.equal(store.head(request.context).version, a.version);
  const reapplied = store.save(second);
  assert.equal(reapplied.committed, true);
  assert.equal(reapplied.replayed, false);
  assert.equal(store.resume({ context: request.context }).markdown, second.markdown);
});

test('each handoff has its own versions and content', t => {
  const { store } = fixture(t),
    a = store.save(first('A'));
  store.save({ ...first('B'), context: 'other.md' });
  assert.throws(
    () =>
      store.save({ context: 'other.md', expectedVersion: a.version, markdown: 'wrong version' }),
    /conflict/,
  );
  assert.equal(store.resume({ context: 'notes/handoff.md' }).markdown, 'A');
  assert.equal(store.resume({ context: 'other.md' }).markdown, 'B');
});

test('when two processes save on the same version at once, only one succeeds', async t => {
  const { workspace, store } = fixture(t),
    a = store.save(first());
  const script = `import {Handoffs} from ${JSON.stringify(pathToFileURL(resolve('dist/handoff.js')).href)};try { console.log(JSON.stringify(new Handoffs(process.argv[1]).save(JSON.parse(process.argv[2])))); } catch(e) {console.error(e.message);process.exitCode=1}`;
  const execute = markdown =>
    new Promise(resolve => {
      const p = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          script,
          workspace,
          JSON.stringify({ context: 'notes/handoff.md', expectedVersion: a.version, markdown }),
        ],
        { windowsHide: true },
      );
      let out = '';
      p.stdout.on('data', b => (out += b));
      p.stderr.on('data', b => (out += b));
      p.on('close', code => resolve({ code, out }));
    });
  const results = await Promise.all([execute('Writer A'), execute('Writer B')]);
  assert.equal(results.filter(r => r.code === 0).length, 1);
  assert.match(results.find(r => r.code !== 0).out, /busy|conflict/);
  assert.match(store.resume({ context: 'notes/handoff.md' }).markdown, /Writer [AB]/);
});

test('a refused save leaves nothing behind, and resuming a missing handoff writes nothing', t => {
  const { workspace, store, knowledge } = fixture(t);
  const contexts = join(workspace, '.glue', 'contexts');
  assert.equal(knowledge.resume({ context: 'never.md' }).version, null);
  assert.equal(existsSync(contexts), false);
  const ok = store.save({ context: 'ok.md', expectedVersion: null, markdown: 'fine' });
  const before = readdirSync(contexts);
  assert.throws(
    () =>
      store.save({
        context: 'gamma.md',
        expectedVersion: null,
        markdown: 'bad pin',
        dependsOn: [{ context: 'ok.md', version: '0'.repeat(64) }],
      }),
    /Dependency changed or missing/,
  );
  assert.throws(() =>
    store.save({
      context: 'delta.md',
      expectedVersion: null,
      markdown: 'bad evidence',
      evidence: ['missing.txt'],
    }),
  );
  assert.throws(
    () =>
      store.save({
        context: 'eps.md',
        expectedVersion: null,
        markdown: 'secret',
        captures: [capture('s', SECRET)],
      }),
    /sensitive/,
  );
  assert.deepEqual(readdirSync(contexts), before);
  assert.equal(knowledge.resume({ context: 'gamma.md' }).version, null);
  assert.deepEqual(knowledge.find({}).gaps, []);
  // A failed later save of an existing context keeps its history untouched.
  assert.throws(() =>
    store.save({
      context: 'ok.md',
      expectedVersion: ok.version,
      markdown: 'bad',
      evidence: ['missing.txt'],
    }),
  );
  assert.equal(store.head('ok.md').version, ok.version);
});
