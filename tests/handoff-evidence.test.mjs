import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Handoffs, hash } from '../dist/handoff.js';

function fixture(t) {
  const workspace = mkdtempSync(join(fs.realpathSync(tmpdir()), 'glue-evidence-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  return { workspace, store: new Handoffs(workspace) };
}
const first = (markdown = '# Context\nOriginal user decision.') => ({
  context: 'notes/handoff.md',
  expectedVersion: null,
  markdown,
  evidence: [],
});

test('resume flags changed and missing evidence, and a save must review or drop it', t => {
  const { workspace, store } = fixture(t);
  writeFileSync(join(workspace, 'source.txt'), 'original\r\n');
  const a = store.save({ ...first(), evidence: ['source.txt'] });
  writeFileSync(join(workspace, 'source.txt'), 'changed');
  let view = store.resume({ context: 'notes/handoff.md' });
  assert.equal(view.evidence[0].status, 'changed');
  assert.equal(readFileSync(view.evidence[0].snapshot, 'utf8'), 'original\r\n');
  assert.equal(view.evidence[0].savedHash, hash('original\r\n'));
  assert.equal(view.evidence[0].currentHash, hash('changed'));
  assert.throws(
    () =>
      store.save({
        context: 'notes/handoff.md',
        expectedVersion: a.version,
        markdown: 'Unrelated progress',
      }),
    /Evidence changed: source.txt/,
  );
  assert.equal(store.head('notes/handoff.md').version, a.version);
  const b = store.save({
    context: 'notes/handoff.md',
    expectedVersion: a.version,
    markdown: 'Explicit correction; unrelated constraints retained.',
    reviewedEvidence: [{ path: 'source.txt', hash: view.evidence[0].currentHash }],
  });
  assert.equal(store.resume({ context: 'notes/handoff.md' }).evidence[0].status, 'unchanged');
  assert.equal(
    store.revision(store.location('notes/handoff.md').directory, a.version).markdown,
    first().markdown,
  );
  unlinkSync(join(workspace, 'source.txt'));
  assert.equal(store.resume({ context: 'notes/handoff.md' }).evidence[0].status, 'missing');
  assert.throws(() =>
    store.save({ context: 'notes/handoff.md', expectedVersion: b.version, markdown: 'must fail' }),
  );
  assert.equal(store.head('notes/handoff.md').version, b.version);
  store.save({
    context: 'notes/handoff.md',
    expectedVersion: b.version,
    markdown: 'Source retired explicitly.',
    evidence: [],
  });
  assert.equal(store.resume({ context: 'notes/handoff.md' }).evidence.length, 0);
});

test('reviewed evidence must still match at save time, and a retry keeps the accepted snapshot', t => {
  const { workspace, store } = fixture(t);
  writeFileSync(join(workspace, 's.txt'), 'one');
  const a = store.save({ ...first(), evidence: ['s.txt'] });
  writeFileSync(join(workspace, 's.txt'), 'two');
  const observed = store.resume({ context: 'notes/handoff.md' }).evidence[0].currentHash;
  const request = {
    context: 'notes/handoff.md',
    expectedVersion: a.version,
    markdown: 'Reviewed two',
    evidence: ['s.txt'],
    reviewedEvidence: [{ path: 's.txt', hash: observed }],
  };
  writeFileSync(join(workspace, 's.txt'), 'three');
  assert.throws(() => store.save(request), /changed since review/);
  assert.equal(store.head(request.context).version, a.version);
  assert.equal(readFileSync(join(workspace, request.context), 'utf8'), first().markdown);
  writeFileSync(join(workspace, 's.txt'), 'two');
  const b = store.save(request);
  writeFileSync(join(workspace, 's.txt'), 'four');
  assert.equal(store.save(request).version, b.version);
  const view = store.resume({ context: request.context });
  assert.equal(view.evidence[0].status, 'changed');
  assert.equal(readFileSync(view.evidence[0].snapshot, 'utf8'), 'two');
  assert.throws(
    () => store.save({ ...request, expectedVersion: b.version, evidence: [] }),
    /selected evidence/,
  );
  assert.throws(
    () =>
      store.save({
        ...request,
        expectedVersion: b.version,
        reviewedEvidence: [request.reviewedEvidence[0], request.reviewedEvidence[0]],
      }),
    /at most once/,
  );
});

test('an interrupted snapshot write leaves no partial file, and the retry succeeds', t => {
  const { workspace, store } = fixture(t),
    body = Buffer.from('source bytes for a partial write');
  writeFileSync(join(workspace, 'source.txt'), body);
  const request = { ...first(), evidence: ['source.txt'] };
  const original = fs.writeFileSync;
  let injected = false;
  try {
    fs.writeFileSync = (file, bytes, ...args) => {
      if (!injected && typeof file === 'number' && Buffer.isBuffer(bytes) && bytes.equals(body)) {
        injected = true;
        original(file, bytes.subarray(0, 4));
        throw Error('Injected partial immutable write');
      }
      return original(file, bytes, ...args);
    };
    syncBuiltinESMExports();
    assert.throws(() => store.save(request), /Injected partial immutable write/);
  } finally {
    fs.writeFileSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
  const loc = store.location(request.context),
    snapshot = join(loc.directory, 'evidence', hash(body) + '.txt');
  assert.equal(existsSync(snapshot), false);
  assert.equal(store.inspect(request.context).revisions.length, 0);
  const retry = store.save(request);
  assert.equal(retry.committed, true);
  assert.deepEqual(readFileSync(snapshot), body);
});

test('an oversized file already at a snapshot path is refused, not read', t => {
  const { workspace, store } = fixture(t),
    body = Buffer.from('expected source');
  writeFileSync(join(workspace, 'source.txt'), body);
  const request = { ...first(), evidence: ['source.txt'] },
    loc = store.location(request.context);
  const evidenceDir = join(loc.directory, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });
  const snapshot = join(evidenceDir, hash(body) + '.txt');
  writeFileSync(snapshot, Buffer.alloc(1024 * 1024));
  assert.throws(() => store.save(request), /size limit/);
  assert.equal(store.inspect(request.context).revisions.length, 0);
  assert.equal(readFileSync(snapshot).length, 1024 * 1024);
});

test('a retry replays from saved snapshots even if the live source is now a link', t => {
  const { workspace, store } = fixture(t);
  mkdirSync(join(workspace, 'sources'));
  writeFileSync(join(workspace, 'sources/source.txt'), 'saved evidence');
  const request = { ...first(), evidence: ['sources/source.txt'] },
    a = store.save(request);
  const snapshot = store.resume({ context: request.context }).evidence[0].snapshot;
  const b = store.save({
    ...request,
    expectedVersion: a.version,
    markdown: 'Later work',
    evidence: [],
  });
  renameSync(join(workspace, 'sources'), join(workspace, 'moved-sources'));
  symlinkSync(join(workspace, 'moved-sources'), join(workspace, 'sources'), 'junction');
  const loc = store.location(request.context),
    headBefore = readFileSync(loc.head),
    filesBefore = readdirSync(join(loc.directory, 'revisions'));
  const replay = store.save(request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.version, a.version);
  assert.equal(replay.currentVersion, b.version);
  assert.deepEqual(readFileSync(loc.head), headBefore);
  assert.deepEqual(readdirSync(join(loc.directory, 'revisions')), filesBefore);
  assert.equal(readFileSync(loc.file, 'utf8'), 'Later work');
  assert.throws(
    () => store.save({ ...request, expectedVersion: b.version, markdown: 'New capture' }),
    /linked/,
  );
  writeFileSync(snapshot, 'corrupt snapshot');
  assert.throws(() => store.save(request), /integrity/);
  assert.deepEqual(readFileSync(loc.head), headBefore);
});

test('evidence behind a link is reported unavailable, but its saved snapshot still works', t => {
  const { workspace, store } = fixture(t),
    request = first();
  mkdirSync(join(workspace, 'sources'));
  writeFileSync(join(workspace, 'sources/source.txt'), 'original evidence');
  const saved = store.save({ ...request, evidence: ['sources/source.txt'] });
  renameSync(join(workspace, 'sources'), join(workspace, 'original-sources'));
  symlinkSync(join(workspace, 'original-sources'), join(workspace, 'sources'), 'junction');
  writeFileSync(join(workspace, 'original-sources/source.txt'), 'current live bytes');
  const view = store.resume({ context: request.context });
  assert.equal(view.version, saved.version);
  assert.equal(view.markdown, request.markdown);
  assert.equal(view.evidence[0].status, 'unavailable');
  assert.equal(readFileSync(view.evidence[0].snapshot, 'utf8'), 'original evidence');
  const inspection = store.inspect(request.context);
  assert.equal(inspection.revisions.find(r => r.version === saved.version).valid, true);
  assert.throws(
    () =>
      store.save({
        ...request,
        expectedVersion: saved.version,
        markdown: 'Must not capture linked source',
        evidence: ['sources/source.txt'],
      }),
    /linked/,
  );
  assert.throws(
    () =>
      store.save({
        context: request.context,
        expectedVersion: saved.version,
        markdown: 'Must not refresh linked source',
      }),
    /linked/,
  );
  assert.equal(
    store.restore(request.context, saved.version, inspection.headHash, inspection.workingCopyHash)
      .restored,
    true,
  );
  assert.equal(
    readFileSync(join(workspace, 'original-sources/source.txt'), 'utf8'),
    'current live bytes',
  );
  writeFileSync(view.evidence[0].snapshot, 'corrupt snapshot');
  assert.throws(() => store.resume({ context: request.context }), /integrity/);
  assert.equal(
    store.inspect(request.context).revisions.find(r => r.version === saved.version).valid,
    false,
  );
});

test('saved evidence with an unsafe path or a linked snapshot folder is refused', t => {
  const { workspace, store } = fixture(t);
  writeFileSync(join(workspace, 'source.txt'), 'evidence');
  const request = { ...first(), evidence: ['source.txt'] },
    saved = store.save(request),
    loc = store.location(request.context);
  const evidence = store.revision(loc.directory, saved.version).evidence;
  for (const path of ['../outside.txt', '.agents/secret.txt', 'CON.txt', 'source.txt:stream']) {
    assert.throws(() => store.verifyEvidence(loc.directory, [{ ...evidence[0], path }]));
  }
  assert.throws(
    () => store.verifyEvidence(loc.directory, [{ ...evidence[0], snapshot: '../outside.txt' }]),
    /snapshot path/,
  );
  const moved = join(workspace, 'moved-snapshots');
  renameSync(join(loc.directory, 'evidence'), moved);
  symlinkSync(moved, join(loc.directory, 'evidence'), 'junction');
  assert.throws(() => store.resume({ context: request.context }), /linked/);
  const inspection = store.inspect(request.context);
  assert.equal(inspection.revisions.find(r => r.version === saved.version).valid, false);
  assert.throws(
    () =>
      store.restore(
        request.context,
        saved.version,
        inspection.headHash,
        inspection.workingCopyHash,
      ),
    /linked/,
  );
});

test('tampered snapshots and revisions are refused, and restore never touches source files', t => {
  const { store, workspace } = fixture(t);
  writeFileSync(join(workspace, 's.txt'), 'one');
  const a = store.save({ ...first(), evidence: ['s.txt'] });
  writeFileSync(join(workspace, 's.txt'), 'two');
  const inspection = store.inspect('notes/handoff.md');
  store.restore('notes/handoff.md', a.version, inspection.headHash, inspection.workingCopyHash);
  assert.equal(readFileSync(join(workspace, 's.txt'), 'utf8'), 'two');
  const view = store.resume({ context: 'notes/handoff.md' });
  writeFileSync(view.evidence[0].snapshot, 'tampered');
  assert.throws(() => store.resume({ context: 'notes/handoff.md' }), /integrity/);
  writeFileSync(
    join(store.location('notes/handoff.md').directory, 'revisions', a.version + '.json'),
    '{}',
  );
  assert.throws(() => store.resume({ context: 'notes/handoff.md' }), /integrity/);
});

test('evidence from .git, .codex, .agents, .claude or .glue is refused without echoing the path', t => {
  const { workspace, store } = fixture(t),
    a = store.save(first());
  writeFileSync(join(workspace, 'source.txt'), 'ordinary evidence');
  for (const path of [
    '.git/config',
    '.codex/config.toml',
    '.agents/skills/glue/SKILL.md',
    '.claude/settings.json',
    '.glue/contexts/example',
  ]) {
    assert.throws(
      () =>
        store.save({
          context: 'notes/handoff.md',
          expectedVersion: a.version,
          markdown: 'Must not commit',
          evidence: ['source.txt', path],
        }),
      error => {
        assert.equal(error.message.includes(JSON.stringify(path)), false);
        assert.match(error.message, /ordinary workspace files/);
        return true;
      },
    );
    assert.equal(store.resume({ context: 'notes/handoff.md' }).version, a.version);
  }
  const b = store.save({
    context: 'notes/handoff.md',
    expectedVersion: a.version,
    markdown: 'Corrected evidence selection',
    evidence: ['source.txt'],
  });
  assert.equal(b.committed, true);
  assert.equal(store.resume({ context: 'notes/handoff.md' }).evidence[0].path, 'source.txt');
});
