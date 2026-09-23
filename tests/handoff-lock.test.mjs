import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withInstallationLock } from '../scripts/installation-lock.mjs';
import { acquireLock, withWriteLock } from '../dist/storage.js';
import { Handoffs } from '../dist/handoff.js';
import { Transfers } from '../dist/transfer.js';

function fixture(t) {
  const workspace = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'glue-lock-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return workspace;
}
// step 'unlinkSync' keeps owner.json; step 'rmdirSync' removes owner.json and keeps the empty lock
// directory.
function withLockRemovalDenied(run, step = 'unlinkSync', code = 'EPERM') {
  const original = fs[step],
    target = step === 'unlinkSync' ? join('.write-lock', 'owner.json') : '.write-lock';
  try {
    fs[step] = (file, ...args) => {
      if (String(file).endsWith(target)) throw Object.assign(new Error('delete denied'), { code });
      return original(file, ...args);
    };
    syncBuiltinESMExports();
    return run();
  } finally {
    fs[step] = original;
    syncBuiltinESMExports();
  }
}
const first = {
  context: 'notes/a.md',
  expectedVersion: null,
  markdown: 'Saved text',
  evidence: [],
};

test('a write lock that cannot be removed does not hide a committed save', t => {
  const workspace = fixture(t),
    store = new Handoffs(workspace);
  const saved = withLockRemovalDenied(() => store.save(first));
  assert.equal(saved.committed, true);
  assert.match(saved.lockNotReleased, /EPERM.*The work above is saved/);
  const view = store.resume({ context: 'notes/a.md' });
  assert.equal(view.version, saved.version);
  assert.equal(view.markdown, 'Saved text');
  assert.throws(
    () => store.save({ ...first, expectedVersion: saved.version, markdown: 'Second' }),
    error => error.code === 'EEXIST' && error.retryable === true,
  );
});

test('a lock directory that outlives its owner file is reported the same way', t => {
  const workspace = fixture(t),
    store = new Handoffs(workspace);
  const saved = withLockRemovalDenied(() => store.save(first), 'rmdirSync', 'EBUSY');
  assert.equal(saved.committed, true);
  assert.match(saved.lockNotReleased, /EBUSY/);
  assert.equal(store.resume({ context: 'notes/a.md' }).version, saved.version);
});

test('a restore reports a lock it could not remove', t => {
  const workspace = fixture(t),
    store = new Handoffs(workspace),
    saved = store.save(first);
  store.save({ ...first, expectedVersion: saved.version, markdown: 'Later text' });
  const inspection = store.inspect('notes/a.md');
  const restored = withLockRemovalDenied(() =>
    store.restore('notes/a.md', saved.version, inspection.headHash, inspection.workingCopyHash),
  );
  assert.equal(restored.restored, true);
  assert.match(restored.lockNotReleased, /EPERM/);
  assert.equal(store.resume({ context: 'notes/a.md' }).markdown, 'Saved text');
});

test('an operation failure is reported with the lock it left behind', t => {
  const workspace = fixture(t),
    failure = new Error('operation failed');
  assert.throws(
    () =>
      withLockRemovalDenied(() =>
        withWriteLock(workspace, () => {
          throw failure;
        }),
      ),
    error =>
      error === failure &&
      /EPERM/.test(error.lockNotReleased) &&
      !/work above is saved/.test(error.lockNotReleased),
  );
  const clean = new Error('operation failed');
  assert.throws(
    () =>
      withWriteLock(fixture(t), () => {
        throw clean;
      }),
    error => error === clean && !('lockNotReleased' in error),
  );
});

test('a rejected first save names the lock that now blocks new contexts', t => {
  const workspace = fixture(t),
    store = new Handoffs(workspace);
  assert.throws(
    () => withLockRemovalDenied(() => store.save({ ...first, evidence: ['missing.txt'] })),
    error =>
      error.code === 'ENOENT' && /blocks creating any new context/.test(error.lockNotReleased),
  );
  assert.throws(
    () => store.save({ ...first, context: 'notes/b.md' }),
    /unavailable saved identity/,
  );
});

test('release is attempted once and never throws', t => {
  const workspace = fixture(t),
    lock = join(workspace, '.write-lock');
  const release = acquireLock(workspace, '.write-lock', 'busy');
  assert.match(
    withLockRemovalDenied(() => release()),
    /EPERM/,
  );
  assert.equal(release(), undefined);
  assert.ok(fs.existsSync(join(lock, 'owner.json')));
});

test('a partial owner write preserves its error and leaves no stale lock', t => {
  const workspace = fixture(t),
    owner = join(workspace, '.write-lock', 'owner.json');
  const originalOpen = fs.openSync,
    originalWrite = fs.writeFileSync;
  const failure = Object.assign(new Error('owner write failed'), { code: 'ENOSPC' });
  let ownerDescriptor;
  try {
    fs.openSync = (file, ...args) => {
      const fd = originalOpen(file, ...args);
      if (file === owner) ownerDescriptor = fd;
      return fd;
    };
    fs.writeFileSync = (file, bytes, ...args) => {
      if (file === ownerDescriptor) {
        originalWrite(file, '{');
        throw failure;
      }
      return originalWrite(file, bytes, ...args);
    };
    syncBuiltinESMExports();
    assert.throws(
      () => acquireLock(workspace, '.write-lock', 'busy'),
      error => error === failure,
    );
  } finally {
    fs.openSync = originalOpen;
    fs.writeFileSync = originalWrite;
    syncBuiltinESMExports();
  }
  assert.deepEqual(fs.readdirSync(workspace), []);
  const release = acquireLock(workspace, '.write-lock', 'busy');
  assert.equal(release(), undefined);
});

test('owner creation collision preserves a file this call did not create', t => {
  const workspace = fixture(t),
    owner = join(workspace, '.write-lock', 'owner.json');
  const originalOpen = fs.openSync;
  try {
    fs.openSync = (file, flags, ...args) => {
      if (file === owner) {
        const fd = originalOpen(file, 'wx', ...args);
        fs.writeFileSync(fd, 'other owner');
        fs.closeSync(fd);
      }
      return originalOpen(file, flags, ...args);
    };
    syncBuiltinESMExports();
    assert.throws(
      () => acquireLock(workspace, '.write-lock', 'busy'),
      error => error.code === 'EEXIST' && /clean up its lock/.test(error.lockNotReleased),
    );
  } finally {
    fs.openSync = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal(fs.readFileSync(owner, 'utf8'), 'other owner');
});

test('a namespace lock left by the first transfer does not block later transfers', t => {
  const workspace = fixture(t),
    store = new Handoffs(workspace),
    transfers = new Transfers(store),
    saved = store.save(first);
  const selection = {
    action: 'preview',
    context: 'notes/a.md',
    version: saved.version,
    captures: [],
    evidence: [],
  };
  const preview = withLockRemovalDenied(() => transfers.run(selection));
  assert.ok(fs.existsSync(join(workspace, '.glue', '.write-lock')));
  assert.equal(transfers.run(selection).payloadHash, preview.payloadHash);
});

test('installation lock rejects overlap without disturbing its owner and remains separate from write locks', t => {
  const workspace = fixture(t),
    owner = join(workspace, '.glue-install-lock/owner.json');
  assert.equal(
    withInstallationLock(workspace, () => {
      const before = fs.readFileSync(owner);
      assert.equal(JSON.parse(before).pid, process.pid);
      assert.throws(
        () => withInstallationLock(workspace, () => assert.fail('overlapping operation ran')),
        error =>
          error.code === 'EEXIST' &&
          error.retryable === true &&
          /Another installation operation/.test(error.message),
      );
      assert.deepEqual(fs.readFileSync(owner), before);
      assert.deepEqual(
        withWriteLock(workspace, () => 42),
        { value: 42 },
      );
      assert.ok(fs.existsSync(owner));
      return 'done';
    }),
    'done',
  );
  assert.deepEqual(fs.readdirSync(workspace), []);
});

test('installation lock releases after operation or owner creation failure', t => {
  const workspace = fixture(t),
    failure = new Error('operation failed');
  assert.throws(
    () =>
      withInstallationLock(workspace, () => {
        throw failure;
      }),
    error => error === failure,
  );
  assert.deepEqual(fs.readdirSync(workspace), []);
  const original = fs.openSync,
    denied = Object.assign(new Error('owner denied'), { code: 'EACCES' });
  try {
    fs.openSync = (file, ...args) => {
      if (file === join(workspace, '.glue-install-lock/owner.json')) throw denied;
      return original(file, ...args);
    };
    syncBuiltinESMExports();
    assert.throws(
      () => withInstallationLock(workspace, () => assert.fail('operation ran without owner')),
      error => error === denied,
    );
  } finally {
    fs.openSync = original;
    syncBuiltinESMExports();
  }
  assert.deepEqual(fs.readdirSync(workspace), []);
  assert.equal(
    withInstallationLock(workspace, () => true),
    true,
  );
});

test('installation lock reports permission failures without claiming contention', t => {
  const workspace = fixture(t),
    original = fs.mkdirSync,
    lock = join(workspace, '.glue-install-lock');
  try {
    for (const code of ['EACCES', 'EPERM']) {
      fs.mkdirSync = (file, ...args) => {
        if (file === lock) throw Object.assign(new Error('denied'), { code });
        return original(file, ...args);
      };
      syncBuiltinESMExports();
      assert.throws(
        () => withInstallationLock(workspace, () => assert.fail('operation ran without lock')),
        error =>
          error.code === code &&
          error.retryable === false &&
          error.path === lock &&
          /host write permissions/.test(error.message) &&
          !/Another installation/.test(error.message),
      );
    }
  } finally {
    fs.mkdirSync = original;
    syncBuiltinESMExports();
  }
  assert.deepEqual(fs.readdirSync(workspace), []);
});
