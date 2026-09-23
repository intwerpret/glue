import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Handoffs, hash } from '../dist/handoff.js';
import { pathKey } from '../dist/identity.js';
import { Knowledge } from '../dist/knowledge.js';

function fixture(t) {
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), 'glue-portable-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  return { workspace, store: new Handoffs(workspace) };
}
function legacy(workspace, context, markdown = 'Legacy selected work', working = true) {
  const directory = join(workspace, '.glue', 'contexts', hash(context));
  mkdirSync(join(directory, 'revisions'), { recursive: true });
  const bytes = JSON.stringify({
    format: 1,
    context,
    parent: null,
    request: hash('legacy request ' + context),
    at: '2026-01-01T00:00:00.000Z',
    markdown,
    evidence: [],
  });
  const version = hash(bytes),
    revision = join(directory, 'revisions', version + '.json');
  writeFileSync(revision, bytes);
  writeFileSync(join(directory, 'HEAD.json'), JSON.stringify({ format: 1, version }));
  writeFileSync(join(directory, '.initialized'), 'Glue handoff initialized\n');
  if (working) {
    mkdirSync(dirname(join(workspace, context)), { recursive: true });
    writeFileSync(join(workspace, context), markdown);
  }
  return { version, revision, bytes, directory };
}

test('portable context aliases preserve one identity and actual case/Unicode filename', t => {
  const { workspace, store } = fixture(t);
  const context = 'Nótes/Café.MD',
    alias = 'no\u0301tes/cafe\u0301.md';
  const a = store.save({ context, expectedVersion: null, markdown: 'First' });
  const view = store.resume({ context: alias });
  assert.equal(view.version, a.version);
  assert.equal(view.context, pathKey(context));
  const b = store.save({ context: alias, expectedVersion: a.version, markdown: 'Second' });
  assert.equal(store.resume({ context }).version, b.version);
  assert.equal(readFileSync(join(workspace, context), 'utf8'), 'Second');
  assert.equal(readdirSync(join(workspace, '.glue', 'contexts')).length, 1);
});

test('legacy mixed-case history survives relocation and alias saves without revision rewriting', t => {
  const original = fixture(t),
    moved = fixture(t);
  const prior = legacy(original.workspace, 'Notes/Decision.MD');
  cpSync(original.workspace, moved.workspace, { recursive: true });
  const store = new Handoffs(moved.workspace);
  const view = store.resume({ context: 'notes/decision.md' });
  assert.equal(view.context, 'Notes/Decision.MD');
  assert.equal(view.version, prior.version);
  const receipt = store.save({
    context: 'NOTES/DECISION.MD',
    expectedVersion: prior.version,
    markdown: 'Continued after relocation',
  });
  const location = store.location('notes/decision.md');
  assert.equal(
    location.directory,
    join(moved.workspace, '.glue', 'contexts', hash('Notes/Decision.MD')),
  );
  assert.equal(store.revision(location.directory, receipt.version).parent, prior.version);
  assert.equal(
    readFileSync(join(location.directory, 'revisions', prior.version + '.json'), 'utf8'),
    prior.bytes,
  );
  assert.equal(readFileSync(prior.revision, 'utf8'), prior.bytes);
  assert.equal(
    readFileSync(join(moved.workspace, 'Notes/Decision.MD'), 'utf8'),
    'Continued after relocation',
  );
  assert.equal(readdirSync(join(moved.workspace, '.glue', 'contexts')).length, 1);
});

test('legacy identity lookup survives a missing working file and caches only validated identities', t => {
  const { workspace, store } = fixture(t);
  const prior = legacy(workspace, 'Notes/Decision.MD');
  unlinkSync(join(workspace, 'Notes/Decision.MD'));
  assert.equal(store.resume({ context: 'notes/decision.md' }).version, prior.version);
  const original = store.revision.bind(store),
    reads = [];
  store.revision = (directory, version) => {
    reads.push(version);
    return original(directory, version);
  };
  assert.equal(store.resume({ context: 'notes/decision.md' }).workingCopy.status, 'missing');
  assert.deepEqual(reads, [prior.version]);
});

test('adding a competing legacy identity is detected even after cached canonical lookup', t => {
  const { workspace, store } = fixture(t);
  const receipt = store.save({ context: 'note.md', expectedVersion: null, markdown: 'Canonical' });
  assert.equal(store.resume({ context: 'NOTE.MD' }).version, receipt.version);
  const duplicate = legacy(workspace, 'NoTe.md', 'Different legacy history', false);
  assert.throws(() => store.resume({ context: 'note.md' }), /identity collision/);
  assert.throws(
    () =>
      store.save({
        context: 'note.md',
        expectedVersion: receipt.version,
        markdown: 'must not overwrite',
      }),
    /identity collision/,
  );
  assert.equal(readFileSync(join(workspace, 'note.md'), 'utf8'), 'Canonical');
  assert.equal(readFileSync(duplicate.revision, 'utf8'), duplicate.bytes);
});

test('multiple legacy aliases are refused without creating a new canonical history', t => {
  const { workspace, store } = fixture(t);
  legacy(workspace, 'Note.md', 'One', false);
  legacy(workspace, 'NOTE.md', 'Two', false);
  assert.throws(() => store.resume({ context: 'note.md' }), /identity collision/);
  assert.equal(existsSync(join(workspace, '.glue', 'contexts', hash('note.md'))), false);
});

test('unavailable unrelated identity does not hide known history but blocks unproven new identity', t => {
  const { workspace, store } = fixture(t);
  const receipt = store.save({ context: 'known.md', expectedVersion: null, markdown: 'Intact' });
  const unknown = join(workspace, '.glue', 'contexts', hash('unreadable-legacy'));
  mkdirSync(unknown, { recursive: true });
  writeFileSync(join(unknown, 'HEAD.json'), 'broken');
  assert.equal(store.resume({ context: 'known.md' }).version, receipt.version);
  assert.throws(
    () =>
      store.save({
        context: 'new.md',
        expectedVersion: null,
        markdown: 'Cannot establish identity',
      }),
    /unavailable saved identity/,
  );
  assert.equal(existsSync(join(workspace, '.glue', 'contexts', hash('new.md'))), false);
});

test('case-only filesystem rename does not fork a portable context', t => {
  const { workspace, store } = fixture(t);
  const receipt = store.save({
    context: 'Note.md',
    expectedVersion: null,
    markdown: 'Before rename',
  });
  renameSync(join(workspace, 'Note.md'), join(workspace, 'renaming.tmp'));
  renameSync(join(workspace, 'renaming.tmp'), join(workspace, 'NOTE.MD'));
  assert.equal(store.resume({ context: 'note.md' }).version, receipt.version);
  store.save({ context: 'Note.md', expectedVersion: receipt.version, markdown: 'After rename' });
  assert.equal(readFileSync(join(workspace, 'NOTE.MD'), 'utf8'), 'After rename');
  assert.equal(readdirSync(join(workspace, '.glue', 'contexts')).length, 1);
});

test('distinct filesystem aliases are rejected on volumes that permit them', t => {
  const { workspace, store } = fixture(t);
  writeFileSync(join(workspace, 'Note.md'), 'First');
  try {
    writeFileSync(join(workspace, 'note.md'), 'Second', { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      assert.equal(store.path('note.md').file, join(workspace, 'Note.md'));
      return;
    }
    throw error;
  }
  assert.throws(() => store.resume({ context: 'note.md' }), /Portable path collision/);
  assert.equal(readFileSync(join(workspace, 'Note.md'), 'utf8'), 'First');
  assert.equal(readFileSync(join(workspace, 'note.md'), 'utf8'), 'Second');
  assert.equal(existsSync(join(workspace, '.glue')), false);
});

test('resume names a path collision as the reason selected evidence is unavailable', t => {
  const { workspace, store } = fixture(t);
  const composed = 'Caf\u00e9.txt',
    decomposed = 'Cafe\u0301.txt';
  writeFileSync(join(workspace, composed), 'Composed');
  const receipt = store.save({
    context: 'note.md',
    expectedVersion: null,
    markdown: 'Pinned source',
    evidence: [composed],
  });
  store.save({
    context: 'root.md',
    expectedVersion: null,
    markdown: 'Depends on the note',
    dependsOn: [{ context: 'note.md', version: receipt.version }],
  });
  assert.equal(store.resume({ context: 'note.md' }).evidence[0].status, 'unchanged');
  try {
    writeFileSync(join(workspace, decomposed), 'Decomposed', { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      t.skip('this volume folds Unicode aliases, so two such names cannot coexist');
      return;
    }
    throw error;
  }
  const [item] = store.resume({ context: 'note.md' }).evidence;
  assert.equal(item.status, 'unavailable');
  assert.equal(item.reason, 'path_collision');
  const issue = {
    version: receipt.version,
    reason: 'live_source_path_collision',
    source: pathKey(composed),
  };
  assert.deepEqual(new Knowledge(store).resume({ context: 'note.md' }).basis.issues, [
    { context: 'note.md', via: [], ...issue },
  ]);
  assert.deepEqual(new Knowledge(store).resume({ context: 'root.md' }).basis.issues, [
    { context: 'note.md', via: ['root.md'], ...issue },
  ]);
});

test('Unicode normalization collisions are refused when distinct entries coexist', t => {
  const { workspace, store } = fixture(t);
  const composed = 'Caf\u00e9.md',
    decomposed = 'Cafe\u0301.md';
  writeFileSync(join(workspace, composed), 'Composed');
  try {
    writeFileSync(join(workspace, decomposed), 'Decomposed', { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      assert.equal(store.path(decomposed).rel, pathKey(composed));
      return;
    }
    throw error;
  }
  assert.throws(() => store.resume({ context: composed }), /Portable path collision/);
  assert.equal(readFileSync(join(workspace, composed), 'utf8'), 'Composed');
  assert.equal(readFileSync(join(workspace, decomposed), 'utf8'), 'Decomposed');
  assert.equal(existsSync(join(workspace, '.glue')), false);
});

test('a failed first save leaves no historical identity that blocks unrelated new work', t => {
  const { workspace, store } = fixture(t);
  assert.throws(() =>
    store.save({
      context: 'failed.md',
      expectedVersion: null,
      markdown: 'No saved revision',
      evidence: ['missing.txt'],
    }),
  );
  // A rejected first save leaves no identity directory; a pre-existing empty remnant is still
  // tolerated by identity lookup.
  assert.equal(existsSync(join(workspace, '.glue', 'contexts', hash('failed.md'))), false);
  const empty = join(workspace, '.glue', 'contexts', hash('remnant.md'));
  mkdirSync(empty, { recursive: true });
  assert.deepEqual(readdirSync(empty), []);
  const receipt = store.save({
    context: 'other.md',
    expectedVersion: null,
    markdown: 'Independent work',
  });
  assert.equal(store.resume({ context: 'other.md' }).version, receipt.version);
  assert.equal(store.resume({ context: 'failed.md' }).version, null);
  const interrupted = join(workspace, '.glue', 'contexts', hash('unknown-legacy-identity'));
  mkdirSync(join(interrupted, '.write-lock'), { recursive: true });
  assert.throws(
    () =>
      store.save({
        context: 'another.md',
        expectedVersion: null,
        markdown: 'Do not ignore an active writer',
      }),
    /unavailable saved identity/,
  );
  assert.equal(existsSync(join(workspace, '.glue', 'contexts', hash('another.md'))), false);
});
