import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Handoffs, hash } from '../dist/handoff.js';
import { pathKey } from '../dist/identity.js';
import { Knowledge } from '../dist/knowledge.js';

function fixture(t) {
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), 'glue-paths-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  return { workspace, store: new Handoffs(workspace) };
}
const first = (markdown = '# Context\nOriginal user decision.') => ({
  context: 'notes/handoff.md',
  expectedVersion: null,
  markdown,
  evidence: [],
});

test('case and Unicode spellings of a path reach one handoff, and the file keeps its own spelling', t => {
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

test('a damaged handoff stays reported as damaged and does not affect other handoffs', t => {
  const { workspace, store } = fixture(t);
  const receipt = store.save({ context: 'known.md', expectedVersion: null, markdown: 'Intact' });
  const damaged = join(workspace, '.glue', 'contexts', hash('damaged.md'));
  mkdirSync(damaged, { recursive: true });
  writeFileSync(join(damaged, 'HEAD.json'), 'broken');
  assert.equal(store.resume({ context: 'known.md' }).version, receipt.version);
  const created = store.save({ context: 'new.md', expectedVersion: null, markdown: 'New work' });
  assert.equal(store.resume({ context: 'new.md' }).version, created.version);
  assert.throws(() => store.resume({ context: 'damaged.md' }));
  assert.throws(() =>
    store.save({ context: 'damaged.md', expectedVersion: null, markdown: 'Must not reset' }),
  );
  assert.equal(readFileSync(join(damaged, 'HEAD.json'), 'utf8'), 'broken');
});

test('renaming a handoff file by case only keeps its history', t => {
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

test('two files that differ only by case are refused where the filesystem allows both', t => {
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

test('evidence with a case or Unicode twin is reported unavailable, with the reason', t => {
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

test('two files that differ only by Unicode normalization are refused', t => {
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

test('a refused or interrupted first save blocks only its own handoff', t => {
  const { workspace, store } = fixture(t);
  assert.throws(() =>
    store.save({
      context: 'failed.md',
      expectedVersion: null,
      markdown: 'No saved revision',
      evidence: ['missing.txt'],
    }),
  );
  // A refused first save leaves no folder behind; an empty folder left by an older one is harmless.
  assert.equal(existsSync(join(workspace, '.glue', 'contexts', hash('failed.md'))), false);
  const empty = join(workspace, '.glue', 'contexts', hash('remnant.md'));
  mkdirSync(empty, { recursive: true });
  assert.deepEqual(readdirSync(empty), []);
  assert.equal(
    store.save({ context: 'remnant.md', expectedVersion: null, markdown: 'Saved' }).committed,
    true,
  );
  assert.equal(store.resume({ context: 'failed.md' }).version, null);
  // A first save interrupted while holding its lock blocks that handoff until the lock is cleared.
  const interrupted = join(workspace, '.glue', 'contexts', hash('interrupted.md'));
  mkdirSync(join(interrupted, '.write-lock'), { recursive: true });
  assert.throws(
    () =>
      store.save({
        context: 'interrupted.md',
        expectedVersion: null,
        markdown: 'Do not ignore an active writer',
      }),
    error => error.code === 'EEXIST',
  );
  const receipt = store.save({
    context: 'other.md',
    expectedVersion: null,
    markdown: 'Independent work',
  });
  assert.equal(store.resume({ context: 'other.md' }).version, receipt.version);
});

test('unsafe handoff paths, links and oversized Markdown are refused', t => {
  const { workspace, store } = fixture(t);
  for (const context of [
    '../outside.md',
    '.git/config.md',
    '.glue/other.md',
    'notes/x.md:stream',
    'CON.md',
    'a./x.md',
  ])
    assert.throws(() => store.resume({ context }));
  assert.throws(() => store.save({ ...first(), markdown: '🙂'.repeat(17000) }));
  const target = join(workspace, 'target');
  mkdirSync(target);
  symlinkSync(target, join(workspace, 'linked'), 'junction');
  assert.throws(() => store.resume({ context: 'linked/handoff.md' }), /linked/);
});

test('nested .git folders, host instruction files and Windows short names are refused', t => {
  const { workspace, store } = fixture(t);
  mkdirSync(join(workspace, 'sub', '.git'), { recursive: true });
  writeFileSync(join(workspace, 'sub', '.git', 'config'), 'nested');
  assert.throws(() => store.save({ ...first(), evidence: ['sub/.git/config'] }), /outside \.git/);
  for (const context of [
    'AGENTS.md',
    'CLAUDE.md',
    'docs/claude.local.md',
    'skills/x/SKILL.md',
    '.github/workflows/note.md',
    '.cursor/rules/note.md',
    'notes/.hidden/x.md',
  ]) {
    assert.throws(() => store.save({ ...first(), context }), /host instruction file/);
    assert.throws(() => store.resume({ context }), /host instruction file/);
  }
  writeFileSync(join(workspace, 'AGENTS.md'), '# Project instructions');
  assert.equal(store.save({ ...first(), evidence: ['AGENTS.md'] }).committed, true);
  assert.equal(readFileSync(join(workspace, 'AGENTS.md'), 'utf8'), '# Project instructions');
  mkdirSync(join(workspace, 'longdirectoryname'));
  writeFileSync(join(workspace, 'longdirectoryname', 'source.txt'), 'source');
  // Short names exist only on some Windows volumes.
  if (existsSync(join(workspace, 'LONGDI~1', 'source.txt'))) {
    assert.throws(
      () =>
        store.save({
          context: 'notes/alias.md',
          expectedVersion: null,
          markdown: '# Alias',
          evidence: ['LONGDI~1/source.txt'],
        }),
      /ambiguous/,
    );
    assert.throws(
      () =>
        store.save({
          context: 'LONGDI~1/alias.md',
          expectedVersion: null,
          markdown: '# Alias',
          evidence: [],
        }),
      /ambiguous/,
    );
  }
});
