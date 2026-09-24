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
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Handoffs, hash } from '../dist/handoff.js';
import { Knowledge } from '../dist/knowledge.js';
import { collectFiles } from '../scripts/installation-files.mjs';

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
  const workspace = mkdtempSync(join(fs.realpathSync(tmpdir()), 'glue-recovery-'));
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

test('a restore still counts when writing the handoff file fails', t => {
  const { store } = fixture(t),
    request = first(),
    saved = store.save(request);
  store.save({ ...request, expectedVersion: saved.version, markdown: 'Current text' });
  const loc = store.location(request.context),
    inspection = store.inspect(request.context);
  failRename(t, loc.file);
  const working = store.working.bind(store);
  let reads = 0;
  store.working = file => {
    reads++;
    return working(file);
  };
  const receipt = store.restore(
    request.context,
    saved.version,
    inspection.headHash,
    inspection.workingCopyHash,
  );
  assert.equal(reads, 2);
  assert.equal(receipt.restored, true);
  assert.equal(receipt.workingCopyUpdated, false);
  assert.equal(store.head(request.context).version, saved.version);
  assert.equal(readFileSync(loc.file, 'utf8'), 'Current text');
});

test('a damaged HEAD needs an explicit restore, which backs up the damaged bytes and your text', t => {
  const { workspace, store } = fixture(t),
    a = store.save(first()),
    loc = store.location('notes/handoff.md');
  writeFileSync(loc.head, 'corrupt');
  writeFileSync(join(workspace, 'notes/handoff.md'), 'manual text');
  assert.throws(() => store.resume({ context: 'notes/handoff.md' }));
  assert.throws(() => store.save(first('reset attempt')));
  const inspection = store.inspect('notes/handoff.md');
  assert.equal(inspection.revisions.find(r => r.version === a.version).valid, true);
  assert.throws(
    () => store.restore('notes/handoff.md', a.version, null, inspection.workingCopyHash),
    /changed/,
  );
  store.restore('notes/handoff.md', a.version, inspection.headHash, inspection.workingCopyHash);
  assert.equal(store.resume({ context: 'notes/handoff.md' }).version, a.version);
  const backup = readdirSync(loc.directory).find(n => n.startsWith('recovery-'));
  const contents = JSON.parse(readFileSync(join(loc.directory, backup), 'utf8'));
  assert.equal(Buffer.from(contents.head, 'base64').toString(), 'corrupt');
  assert.equal(contents.workingCopy, 'manual text');
  unlinkSync(loc.head);
  assert.throws(() => store.resume({ context: 'notes/handoff.md' }), /HEAD is missing/);
});

test('an edit made during a restore is kept, and the earlier text is backed up', t => {
  const { store } = fixture(t),
    request = first(),
    a = store.save(request);
  store.save({ ...request, expectedVersion: a.version, markdown: 'Current before recovery' });
  const loc = store.location(request.context),
    inspection = store.inspect(request.context),
    headBefore = readFileSync(loc.head);
  const verify = store.verifyEvidence.bind(store),
    working = store.working.bind(store);
  let workingReads = 0;
  store.working = file => {
    workingReads++;
    return working(file);
  };
  store.verifyEvidence = (...args) => {
    verify(...args);
    writeFileSync(loc.file, 'External edit during recovery');
  };
  const receipt = store.restore(
    request.context,
    a.version,
    inspection.headHash,
    inspection.workingCopyHash,
  );
  assert.equal(receipt.restored, true);
  assert.equal(receipt.workingCopyUpdated, false);
  assert.equal(workingReads, 2);
  assert.equal(store.head(request.context).version, a.version);
  assert.equal(readFileSync(loc.file, 'utf8'), 'External edit during recovery');
  const backup = readdirSync(loc.directory).find(name => name.startsWith('recovery-'));
  const preserved = JSON.parse(readFileSync(join(loc.directory, backup), 'utf8'));
  assert.equal(preserved.workingCopy, 'Current before recovery');
  assert.deepEqual(Buffer.from(preserved.head, 'base64'), headBefore);
});

test('inspect reads a shared snapshot once per call and checks it again on the next call', t => {
  const { workspace, store } = fixture(t),
    request = first();
  writeFileSync(join(workspace, 'source.txt'), 'shared evidence');
  let version = null;
  for (let i = 0; i < 20; i++)
    version = store.save({
      ...request,
      expectedVersion: version,
      markdown: 'Revision ' + i,
      evidence: ['source.txt'],
    }).version;
  const snapshot = store.resume({ context: request.context }).evidence[0].snapshot,
    loc = store.location(request.context);
  const manifest = store.revision(loc.directory, version).evidence[0];
  const open = fs.openSync;
  let reads = 0;
  fs.openSync = function (file, ...args) {
    if (String(file) === snapshot && args[0] === 'r') reads++;
    return open.call(this, file, ...args);
  };
  syncBuiltinESMExports();
  try {
    const view = store.inspect(request.context);
    assert.ok(view.revisions.every(r => r.valid));
    assert.equal(reads, 1);
    const checked = new Map();
    store.verifyEvidence(loc.directory, [manifest], checked);
    assert.throws(
      () =>
        store.verifyEvidence(loc.directory, [{ ...manifest, bytes: manifest.bytes + 1 }], checked),
      /integrity/,
    );
    assert.throws(
      () => store.verifyEvidence(loc.directory, [{ ...manifest, hash: '0'.repeat(64) }], checked),
      /snapshot path|integrity/,
    );
    assert.throws(() =>
      store.verifyEvidence(loc.directory, [{ ...manifest, path: '../outside.txt' }], checked),
    );
    // Same byte length ensures the second inspection must check the content hash.
    writeFileSync(snapshot, 'SHARED EVIDENCE');
    reads = 0;
    assert.ok(store.inspect(request.context).revisions.every(r => !r.valid));
    assert.equal(reads, 1);
  } finally {
    fs.openSync = open;
    syncBuiltinESMExports();
  }
});

test('inspect reports which revisions HEAD can reach, reading each revision once', t => {
  const { store } = fixture(t),
    request = first();
  assert.equal(store.inspect(request.context).ancestry.status, 'empty');
  const a = store.save(request),
    b = store.save({ ...request, expectedVersion: a.version, markdown: 'Second' });
  let view = store.inspect(request.context);
  assert.equal(view.ancestry.status, 'complete');
  assert.deepEqual(view.ancestry.missingParents, []);
  assert.ok(view.revisions.every(r => r.reachableFromHead === true));
  store.restore(request.context, a.version, view.headHash, view.workingCopyHash);
  const original = store.revision.bind(store),
    reads = [];
  store.revision = (directory, version) => {
    reads.push(version);
    return original(directory, version);
  };
  view = store.inspect(request.context);
  assert.equal(view.ancestry.headVersion, a.version);
  assert.equal(view.ancestry.status, 'complete');
  assert.equal(view.revisions.find(r => r.version === a.version).reachableFromHead, true);
  assert.equal(view.revisions.find(r => r.version === b.version).reachableFromHead, false);
  assert.equal(view.revisions.find(r => r.version === b.version).valid, true);
  assert.deepEqual(reads.sort(), [a.version, b.version].sort());
});

test('inspect tells a missing revision, a corrupt revision and a bad HEAD apart', t => {
  const { store } = fixture(t),
    request = first(),
    a = store.save(request),
    b = store.save({ ...request, expectedVersion: a.version, markdown: 'Second' });
  const loc = store.location(request.context),
    oldFile = join(loc.directory, 'revisions', a.version + '.json'),
    oldBytes = readFileSync(oldFile),
    headBytes = readFileSync(loc.head);
  renameSync(oldFile, oldFile + '.held');
  let view = store.inspect(request.context);
  assert.equal(view.ancestry.status, 'incomplete');
  assert.equal(view.ancestry.reason, 'missing_revision');
  assert.equal(view.ancestry.blockedAt, a.version);
  assert.deepEqual(view.ancestry.missingParents, [{ version: b.version, parent: a.version }]);
  assert.equal(view.revisions[0].valid, true);
  assert.equal(view.revisions[0].reachableFromHead, true);
  writeFileSync(oldFile, 'corrupt');
  view = store.inspect(request.context);
  assert.equal(view.ancestry.reason, 'invalid_revision');
  assert.equal(view.revisions.find(r => r.version === a.version).valid, false);
  assert.equal(view.revisions.find(r => r.version === a.version).reachableFromHead, true);
  writeFileSync(loc.head, 'corrupt');
  view = store.inspect(request.context);
  assert.equal(view.ancestry.status, 'unavailable');
  assert.equal(view.ancestry.reason, 'invalid_head');
  assert.ok(view.revisions.every(r => r.reachableFromHead === null));
  unlinkSync(loc.head);
  assert.equal(store.inspect(request.context).ancestry.reason, 'missing_head');
  writeFileSync(oldFile, oldBytes);
  writeFileSync(loc.head, headBytes);
  assert.equal(store.inspect(request.context).ancestry.status, 'complete');
});

test('a corrupt snapshot marks its revision invalid without breaking the history chain', t => {
  const { workspace, store } = fixture(t);
  writeFileSync(join(workspace, 'source.txt'), 'evidence');
  const request = { ...first(), evidence: ['source.txt'] };
  store.save(request);
  writeFileSync(store.resume({ context: request.context }).evidence[0].snapshot, 'corrupt');
  const view = store.inspect(request.context);
  assert.equal(view.ancestry.status, 'complete');
  assert.equal(view.revisions[0].valid, false);
  assert.equal(view.revisions[0].reachableFromHead, true);
});

test('a first save interrupted before HEAD is written can be restored explicitly', t => {
  const { store } = fixture(t),
    loc = store.location('notes/handoff.md');
  const restoreRename = failRename(t, loc.head);
  assert.throws(() => store.save(first()));
  assert.throws(() => store.resume({ context: 'notes/handoff.md' }), /HEAD is missing/);
  const inspection = store.inspect('notes/handoff.md');
  assert.equal(inspection.revisions.length, 1);
  assert.equal(inspection.revisions[0].valid, true);
  restoreRename();
  const r = store.restore(
    'notes/handoff.md',
    inspection.revisions[0].version,
    inspection.headHash,
    inspection.workingCopyHash,
  );
  assert.equal(r.restored, true);
  assert.equal(store.resume({ context: 'notes/handoff.md' }).markdown, first().markdown);
});

test('restoring an interrupted first save also writes the marker that protects it later', t => {
  const { store } = fixture(t),
    request = first(),
    loc = store.location(request.context),
    marker = join(loc.directory, '.initialized');
  const original = fs.linkSync;
  let version;
  try {
    fs.linkSync = (from, to) => {
      if (to === marker) throw Error('Injected marker failure');
      return original(from, to);
    };
    syncBuiltinESMExports();
    assert.throws(() => store.save(request), /Injected marker failure/);
    const inspection = store.inspect(request.context);
    assert.equal(inspection.revisions.length, 1);
    assert.equal(inspection.revisions[0].valid, true);
    version = inspection.revisions[0].version;
    // Restore must not commit a new HEAD if its marker cannot be created.
    assert.throws(
      () =>
        store.restore(request.context, version, inspection.headHash, inspection.workingCopyHash),
      /Injected marker failure/,
    );
    assert.equal(existsSync(loc.head), false);
    assert.equal(existsSync(marker), false);
  } finally {
    fs.linkSync = original;
    syncBuiltinESMExports();
  }
  const inspection = store.inspect(request.context);
  assert.equal(
    store.restore(request.context, version, inspection.headHash, inspection.workingCopyHash)
      .restored,
    true,
  );
  assert.equal(readFileSync(marker, 'utf8'), 'Glue handoff initialized\n');
  assert.equal(store.resume({ context: request.context }).version, version);
  unlinkSync(loc.head);
  assert.throws(() => store.resume({ context: request.context }), /HEAD is missing/);
  assert.throws(
    () => store.save({ ...request, workingCopyHash: store.working(loc.file).hash }),
    /HEAD is missing/,
  );
  assert.deepEqual(readdirSync(join(loc.directory, 'revisions')), [version + '.json']);
  assert.equal(store.inspect(request.context).revisions[0].valid, true);
});

test('readers report busy during a first save and read it normally once it finishes', t => {
  const { workspace, store } = fixture(t),
    request = first(),
    loc = store.location(request.context),
    reader = new Handoffs(workspace),
    knowledge = new Knowledge(reader);
  const original = fs.renameSync;
  let observed = false;
  try {
    fs.renameSync = (from, to) => {
      if (to === loc.head) {
        observed = true;
        assert.equal(existsSync(join(loc.directory, '.initialized')), true);
        assert.equal(existsSync(loc.head), false);
        const before = collectFiles(workspace);
        assert.throws(
          () => reader.resume({ context: request.context }),
          error =>
            error.code === 'EEXIST' && error.retryable === true && /busy/.test(error.message),
        );
        const page = knowledge.find({});
        assert.equal(page.gaps[0].reason, 'busy');
        assert.equal('context' in page.gaps[0], false);
        const child = mcpRun(workspace, {
          input:
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name: 'glue_resume', arguments: { context: request.context } },
            }) + '\n',
          encoding: 'utf8',
          timeout: 10000,
        });
        assert.equal(child.status, 0, child.stderr);
        const response = JSON.parse(child.stdout);
        assert.equal(response.result.isError, true);
        assert.match(response.result.content[0].text, /Glue store is busy/);
        assert.doesNotMatch(response.result.content[0].text, /explicit recovery/);
        assert.equal(response.result.content[0].text.includes(workspace), false);
        assert.deepEqual(collectFiles(workspace), before);
      }
      return original(from, to);
    };
    syncBuiltinESMExports();
    assert.equal(store.save(request).committed, true);
  } finally {
    fs.renameSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(observed, true);
  assert.equal(reader.resume({ context: request.context }).markdown, request.markdown);
  assert.equal(knowledge.find({}).results.length, 1);
  assert.deepEqual(knowledge.find({}).gaps, []);
});

test('readers look again when HEAD appears while they are checking for it', t => {
  const { workspace, store } = fixture(t),
    request = first(),
    saved = store.save(request),
    loc = store.location(request.context),
    knowledge = new Knowledge(store);
  mkdirSync(join(loc.directory, '.write-lock'));
  const before = collectFiles(workspace),
    original = fs.existsSync;
  for (const read of [
    () => store.resume({ context: request.context }).version,
    () => knowledge.find({}).results[0].version,
  ]) {
    let firstCheck = true;
    try {
      fs.existsSync = file => {
        if (file === loc.head && firstCheck) {
          firstCheck = false;
          return false;
        }
        return original(file);
      };
      syncBuiltinESMExports();
      assert.equal(read(), saved.version);
      assert.equal(firstCheck, false);
    } finally {
      fs.existsSync = original;
      syncBuiltinESMExports();
    }
  }
  assert.equal(store.resume({ context: request.context }).version, saved.version);
  assert.deepEqual(collectFiles(workspace), before);
});

test('a first save killed mid-write keeps its lock and revision until you recover it', t => {
  const { workspace, store } = fixture(t),
    request = first(),
    loc = store.location(request.context);
  const harness = `
  import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
  const {Handoffs}=await import(${JSON.stringify(new URL('../dist/handoff.js', import.meta.url).href)});
  const store=new Handoffs(process.argv[1]),request=${JSON.stringify(request)},loc=store.location(request.context),original=fs.renameSync;
  fs.renameSync=(from,to)=>{if(to===loc.head)process.exit(0);return original(from,to);};syncBuiltinESMExports();
  store.save(request);process.exit(9);
 `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', harness, workspace], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr);
  const lock = join(loc.directory, '.write-lock');
  assert.equal(existsSync(lock), true);
  assert.equal(existsSync(join(loc.directory, '.initialized')), true);
  assert.equal(existsSync(loc.head), false);
  const before = collectFiles(workspace),
    knowledge = new Knowledge(store);
  assert.throws(
    () => store.resume({ context: request.context }),
    error => error.code === 'EEXIST' && error.retryable === true,
  );
  assert.equal(knowledge.find({}).gaps[0].reason, 'busy');
  assert.throws(
    () => store.save(request),
    error => error.code === 'EEXIST',
  );
  assert.deepEqual(collectFiles(workspace), before);
  // The child has exited; validate the exact fixture lock before operator removal.
  assert.equal(
    fs.realpathSync(lock),
    join(fs.realpathSync(workspace), '.glue', 'contexts', hash(request.context), '.write-lock'),
  );
  rmSync(lock, { recursive: true });
  const preserved = collectFiles(workspace);
  assert.throws(() => store.resume({ context: request.context }), /HEAD is missing/);
  assert.equal(knowledge.find({}).gaps[0].reason, 'missing_head');
  assert.throws(() => store.save(request), /HEAD is missing/);
  assert.deepEqual(collectFiles(workspace), preserved);
  const inspection = store.inspect(request.context);
  assert.equal(inspection.revisions.length, 1);
  assert.equal(inspection.revisions[0].valid, true);
  assert.equal(
    store.restore(
      request.context,
      inspection.revisions[0].version,
      inspection.headHash,
      inspection.workingCopyHash,
    ).restored,
    true,
  );
  assert.equal(store.resume({ context: request.context }).markdown, request.markdown);
});
