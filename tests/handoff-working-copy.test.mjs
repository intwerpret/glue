import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Handoffs } from '../dist/handoff.js';

const protocolStart = [
  {
    jsonrpc: '2.0',
    id: 'test-initialize',
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'glue-test', version: '1' },
    },
  },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
]
  .map(value => JSON.stringify(value) + '\n')
  .join('');
function mcpRun(workspace, options) {
  const input = Buffer.concat([
    Buffer.from(protocolStart),
    Buffer.isBuffer(options.input) ? options.input : Buffer.from(options.input),
  ]);
  const child = spawnSync(process.execPath, ['dist/mcp.js', workspace], {
    ...options,
    input,
    windowsHide: true,
  });
  child.stdout = (child.stdout ?? '')
    .split('\n')
    .filter(line => line && JSON.parse(line).id !== 'test-initialize')
    .join('\n');
  return child;
}

function fixture(t) {
  const workspace = mkdtempSync(join(fs.realpathSync(tmpdir()), 'glue-working-copy-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  return { workspace, store: new Handoffs(workspace) };
}
function failRename(t, target) {
  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === target) throw new Error('Injected rename failure');
    return original(from, to);
  };
  syncBuiltinESMExports();
  const restore = () => {
    fs.renameSync = original;
    syncBuiltinESMExports();
  };
  t.after(restore);
  return restore;
}
const first = (markdown = '# Context\nOriginal user decision.') => ({
  context: 'notes/handoff.md',
  expectedVersion: null,
  markdown,
  evidence: [],
});

test('saving over a hand-edited file needs its hash, and the edited text is kept in history', t => {
  const { workspace, store } = fixture(t);
  mkdirSync(join(workspace, 'notes'));
  const file = join(workspace, 'notes/handoff.md');
  writeFileSync(file, 'Manual baseline');
  assert.throws(() => store.save(first()), /Working copy changed/);
  const a = store.save({
    ...first('Adopted with explicit reconciliation'),
    workingCopyHash: store.resume({ context: 'notes/handoff.md' }).workingCopy.hash,
  });
  writeFileSync(file, 'External correction');
  const read = store.resume({ context: 'notes/handoff.md' });
  assert.equal(read.workingCopy.status, 'edited');
  assert.throws(
    () =>
      store.save({
        context: 'notes/handoff.md',
        expectedVersion: a.version,
        markdown: 'Lost edit',
      }),
    /Working copy/,
  );
  const b = store.save({
    context: 'notes/handoff.md',
    expectedVersion: a.version,
    workingCopyHash: read.workingCopy.hash,
    markdown: 'Reconciled external correction',
  });
  assert.equal(
    store.revision(store.location('notes/handoff.md').directory, b.version).workingCopyBefore,
    'External correction',
  );
});

test('a byte-order mark counts as an edit, and its exact bytes are kept', t => {
  const { workspace, store } = fixture(t);
  mkdirSync(join(workspace, 'notes'));
  const file = join(workspace, 'notes/handoff.md');
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const exact = r =>
    Buffer.from(
      store.revision(store.location('notes/handoff.md').directory, r.version).workingCopyBefore,
      'utf8',
    );
  // First save over an existing BOM-prefixed file whose text equals the proposed Markdown.
  const original = Buffer.concat([bom, Buffer.from('# Context\nOriginal user decision.')]);
  writeFileSync(file, original);
  assert.equal(store.resume({ context: 'notes/handoff.md' }).workingCopy.status, 'edited');
  assert.throws(() => store.save(first()), /Working copy changed/);
  assert.deepEqual(readFileSync(file), original);
  const a = store.save({
    ...first(),
    workingCopyHash: store.resume({ context: 'notes/handoff.md' }).workingCopy.hash,
  });
  assert.deepEqual(exact(a), original);
  assert.equal(readFileSync(file, 'utf8'), '# Context\nOriginal user decision.');
  // Update: a BOM added to otherwise-unchanged saved text is an edit, not a silent match.
  const edited = Buffer.concat([bom, Buffer.from('# Context\nOriginal user decision.')]);
  writeFileSync(file, edited);
  const read = store.resume({ context: 'notes/handoff.md' });
  assert.equal(read.workingCopy.status, 'edited');
  assert.throws(
    () =>
      store.save({
        context: 'notes/handoff.md',
        expectedVersion: a.version,
        markdown: 'Next decision',
      }),
    /Working copy changed/,
  );
  assert.deepEqual(readFileSync(file), edited);
  const b = store.save({
    context: 'notes/handoff.md',
    expectedVersion: a.version,
    workingCopyHash: read.workingCopy.hash,
    markdown: 'Next decision',
  });
  assert.deepEqual(exact(b), edited);
  assert.equal(readFileSync(file, 'utf8'), 'Next decision');
});

test('a save is refused if the file changed again after you read its hash', t => {
  const { workspace, store } = fixture(t);
  const a = store.save(first());
  writeFileSync(join(workspace, 'notes/handoff.md'), 'one');
  const token = store.resume({ context: 'notes/handoff.md' }).workingCopy.hash;
  writeFileSync(join(workspace, 'notes/handoff.md'), 'two');
  assert.throws(
    () =>
      store.save({
        context: 'notes/handoff.md',
        expectedVersion: a.version,
        markdown: 'combined',
        workingCopyHash: token,
      }),
    /Working copy/,
  );
  assert.equal(readFileSync(join(workspace, 'notes/handoff.md'), 'utf8'), 'two');
});

test('an unreadable or oversized handoff file still resumes from history but blocks writes', t => {
  for (const damaged of [Buffer.from([0xff, 0xfe, 0x61]), Buffer.alloc(131073, 120)]) {
    const { workspace, store } = fixture(t),
      request = first(),
      saved = store.save(request),
      loc = store.location(request.context);
    writeFileSync(loc.file, damaged);
    const headBefore = readFileSync(loc.head),
      revisionNames = readdirSync(join(loc.directory, 'revisions'));
    const view = store.resume({ context: request.context });
    assert.equal(view.version, saved.version);
    assert.equal(view.markdown, request.markdown);
    assert.equal(view.workingCopy.status, 'unavailable');
    assert.equal('hash' in view.workingCopy, false);
    assert.match(view.workingCopy.error, /encoding|size limit/);
    const inspection = store.inspect(request.context);
    assert.equal(inspection.revisions.find(r => r.version === saved.version).valid, true);
    assert.equal(inspection.workingCopy.status, 'unavailable');
    assert.equal('workingCopyHash' in inspection, false);
    assert.throws(() =>
      store.save({
        ...request,
        expectedVersion: saved.version,
        markdown: 'Must not overwrite',
        workingCopyHash: null,
      }),
    );
    assert.throws(() => store.restore(request.context, saved.version, inspection.headHash, null));
    assert.deepEqual(readFileSync(loc.file), damaged);
    assert.deepEqual(readFileSync(loc.head), headBefore);
    assert.deepEqual(readdirSync(join(loc.directory, 'revisions')), revisionNames);
    assert.equal(
      readdirSync(loc.directory).some(name => name.startsWith('recovery-')),
      false,
    );
    // Preserving the external bytes and explicitly removing the damaged projection permits
    // recovery.
    writeFileSync(join(workspace, 'preserved-working-copy.bin'), damaged);
    unlinkSync(loc.file);
    const missing = store.inspect(request.context);
    assert.equal(missing.workingCopyHash, null);
    assert.equal(
      store.restore(request.context, saved.version, missing.headHash, missing.workingCopyHash)
        .workingCopyUpdated,
      true,
    );
    assert.deepEqual(readFileSync(join(workspace, 'preserved-working-copy.bin')), damaged);
    assert.equal(store.resume({ context: request.context }).workingCopy.status, 'matches');
  }
});

test('a broken handoff file does not hide corrupt saved revisions or evidence', t => {
  const { workspace, store } = fixture(t);
  writeFileSync(join(workspace, 'source.txt'), 'evidence');
  const request = { ...first(), evidence: ['source.txt'] },
    saved = store.save(request),
    loc = store.location(request.context);
  const snapshot = store.resume({ context: request.context }).evidence[0].snapshot;
  writeFileSync(loc.file, Buffer.from([255]));
  writeFileSync(snapshot, 'tampered');
  assert.throws(() => store.resume({ context: request.context }), /integrity/);
  assert.equal(
    store.inspect(request.context).revisions.find(r => r.version === saved.version).valid,
    false,
  );
  writeFileSync(join(loc.directory, 'revisions', saved.version + '.json'), '{}');
  assert.throws(() => store.resume({ context: request.context }), /integrity/);
});

test('the MCP server and the recovery tool both return history when the handoff file is unreadable', t => {
  const { workspace, store } = fixture(t),
    request = first(),
    saved = store.save(request);
  writeFileSync(join(workspace, request.context), Buffer.from([255]));
  const call = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'glue_resume', arguments: { context: request.context } },
  };
  const mcp = mcpRun(workspace, {
    input: JSON.stringify(call) + '\n',
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(mcp.status, 0, mcp.stderr);
  const result = JSON.parse(mcp.stdout).result;
  assert.notEqual(result.isError, true);
  const view = JSON.parse(result.content[0].text);
  assert.equal(view.markdown, request.markdown);
  assert.equal(view.workingCopy.status, 'unavailable');
  const cli = spawnSync(process.execPath, ['dist/recovery.js', workspace, '-'], {
    input: JSON.stringify({ action: 'inspect', context: request.context }),
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(cli.status, 0, cli.stderr);
  const inspection = JSON.parse(cli.stdout);
  assert.equal(inspection.revisions.find(r => r.version === saved.version).valid, true);
  assert.equal(inspection.workingCopy.status, 'unavailable');
  assert.equal('workingCopyHash' in inspection, false);
});

test('if writing the handoff file fails after a save, the save still counts and can be repaired', t => {
  const { workspace, store } = fixture(t);
  const restoreRename = failRename(t, join(workspace, 'notes/handoff.md'));
  const request = first(),
    a = store.save(request);
  assert.equal(a.committed, true);
  assert.equal(a.replayed, false);
  assert.equal(a.workingCopyUpdated, false);
  assert.match(a.next, /Resume and reconcile/);
  const replay = store.save(request);
  assert.equal(replay.committed, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.workingCopyUpdated, false);
  assert.equal(replay.version, a.version);
  assert.equal(store.resume({ context: request.context }).workingCopy.status, 'missing');
  assert.equal(store.resume({ context: 'notes/handoff.md' }).markdown, first().markdown);
  restoreRename();
  const b = store.save({
    context: 'notes/handoff.md',
    expectedVersion: a.version,
    markdown: first().markdown,
    workingCopyHash: null,
  });
  assert.equal(b.workingCopyUpdated, true);
});

test('an edit made during a save is kept, not overwritten', t => {
  const { store } = fixture(t),
    request = first(),
    saved = store.save(request),
    loc = store.location(request.context);
  const working = store.working.bind(store);
  let reads = 0;
  store.working = file => {
    if (++reads === 2) {
      assert.notEqual(store.head(request.context).version, saved.version);
      writeFileSync(file, 'External edit during save');
    }
    return working(file);
  };
  const receipt = store.save({
    ...request,
    expectedVersion: saved.version,
    markdown: 'New saved text',
  });
  assert.equal(reads, 2);
  assert.equal(receipt.committed, true);
  assert.equal(receipt.workingCopyUpdated, false);
  assert.equal(store.head(request.context).version, receipt.version);
  assert.equal(store.head(request.context).saved.markdown, 'New saved text');
  assert.equal(readFileSync(loc.file, 'utf8'), 'External edit during save');
});

test('saving and restoring leave a nearby .tmp file alone', t => {
  const { workspace, store } = fixture(t),
    request = first(),
    loc = store.location(request.context);
  mkdirSync(join(workspace, 'notes'));
  writeFileSync(loc.file + '.tmp', 'Editor recovery text');
  const firstSave = store.save(request);
  assert.equal(firstSave.workingCopyUpdated, true);
  store.save({ ...request, expectedVersion: firstSave.version, markdown: 'Later text' });
  const inspection = store.inspect(request.context);
  assert.equal(
    store.restore(
      request.context,
      firstSave.version,
      inspection.headHash,
      inspection.workingCopyHash,
    ).workingCopyUpdated,
    true,
  );
  assert.equal(readFileSync(loc.file + '.tmp', 'utf8'), 'Editor recovery text');
  assert.equal(readFileSync(loc.file, 'utf8'), request.markdown);
  assert.deepEqual(readdirSync(join(workspace, 'notes')).sort(), ['handoff.md', 'handoff.md.tmp']);
});
