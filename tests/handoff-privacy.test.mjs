import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Handoffs, hash } from '../dist/handoff.js';
import { Knowledge } from '../dist/knowledge.js';
import { Transfers } from '../dist/transfer.js';

function fixture(t) {
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), 'glue-privacy-test-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const store = new Handoffs(workspace);
  return { workspace, store, knowledge: new Knowledge(store) };
}
function contents(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? contents(file) : [readFileSync(file)];
  });
}
function assertAbsent(directory, marker) {
  for (const bytes of contents(directory)) {
    assert.equal(
      bytes.includes(Buffer.from(marker)),
      false,
      'Private marker survived in generated data',
    );
    assert.equal(
      bytes.includes(Buffer.from(Buffer.from(marker).toString('base64'))),
      false,
      'Encoded private marker survived in generated data',
    );
  }
}
const capture = (body, extra = {}) => ({
  id: 'source',
  label: 'Selected source',
  representation: 'original-bytes',
  basis: 'Selected bytes',
  scope: 'This synthetic project only',
  base64: Buffer.from(body).toString('base64'),
  ...extra,
});
const save = (store, extra = {}) =>
  store.save({
    context: 'handoff.md',
    expectedVersion: null,
    markdown: 'Public-safe fixture',
    ...extra,
  });

test('blocked mixed captures leave no sensitive bytes in Glue data or diagnostic text', t => {
  const { workspace, store } = fixture(t),
    marker = 'SYNTHETIC_PRIVATE_CAPTURE_987654';
  const failure = () =>
    save(store, {
      captures: [capture('safe text'), capture(marker, { id: 'credential', label: '.env' })],
    });
  assert.throws(failure, error => {
    assert.match(error.message, /sensitive material/);
    assert.equal(error.message.includes(marker), false);
    return true;
  });
  assertAbsent(workspace, marker);
  assert.equal(store.resume({ context: 'handoff.md' }).version, null);
});

test('sensitive local-source exceptions cannot authorize siblings or changed source bytes', t => {
  const { workspace, store } = fixture(t),
    marker = 'SYNTHETIC_LOCAL_SECRET_123456';
  writeFileSync(join(workspace, '.env'), marker);
  writeFileSync(join(workspace, '.env.other'), marker + '_SIBLING');
  assert.throws(
    () =>
      save(store, {
        evidence: ['.env', '.env.other'],
        sensitiveEvidence: [{ path: '.env', hash: hash(marker) }],
      }),
    /sensitive material/,
  );
  assertAbsent(join(workspace, '.glue'), marker);
  const saved = save(store, {
    evidence: ['.env'],
    sensitiveEvidence: [{ path: '.env', hash: hash(marker) }],
  });
  const before = readFileSync(store.location('handoff.md').head);
  writeFileSync(join(workspace, '.env'), marker + '_CHANGED');
  assert.throws(
    () =>
      store.save({
        context: 'handoff.md',
        expectedVersion: saved.version,
        markdown: 'Must not commit',
        sensitiveEvidence: [{ path: '.env', hash: hash(marker) }],
        reviewedEvidence: [{ path: '.env', hash: hash(marker + '_CHANGED') }],
      }),
    /sensitive material/,
  );
  assert.deepEqual(readFileSync(store.location('handoff.md').head), before);
  assertAbsent(join(workspace, '.glue'), marker + '_CHANGED');
});

test('capture metadata rejects private machine paths and tokenized URLs without retaining them', t => {
  for (const locator of [
    'C:\\Users\\synthetic-person\\private.txt',
    '/home/synthetic-person/private.txt',
    '/Users/synthetic-person/private.txt',
    '\\\\synthetic-server\\share\\private.txt',
    '/var/synthetic-person/private.txt',
    'file:///home/synthetic-person/private.txt',
    'https://example.invalid/document?access_token=SYNTHETIC_TOKEN_123456',
  ]) {
    const { workspace, store } = fixture(t);
    assert.throws(
      () => save(store, { captures: [capture('safe bytes', { label: locator })] }),
      error => {
        assert.match(error.message, /private locator|credential/);
        assert.equal(error.message.includes(locator), false);
        return true;
      },
    );
    assertAbsent(workspace, 'synthetic-person');
    assertAbsent(workspace, 'SYNTHETIC_TOKEN_123456');
  }
});

test('safe public source URLs remain usable as portable capture metadata', t => {
  const { store } = fixture(t),
    url = 'https://example.invalid/public-document';
  const saved = save(store, {
    captures: [
      capture('Safe public text', { basis: url, scope: 'Public example', transfer: 'allowed' }),
    ],
  });
  const preview = new Transfers(store).run({
    action: 'preview',
    context: 'handoff.md',
    version: saved.version,
    captures: ['source'],
  });
  assert.equal(preview.manifest.captures[0].label, 'Selected source');
  assert.equal(store.head('handoff.md').saved.captures[0].basis, url);
});

test('host capture checks remain attributed observations and do not adopt new bytes', t => {
  const { store, knowledge } = fixture(t);
  const origin = { namespace: 'synthetic', id: 'document', version: 'one' };
  const saved = save(store, {
    captures: [capture('original bytes', { origin, retrievedAt: '2020-01-01T00:00:00.000Z' })],
  });
  const old = knowledge.read({ context: 'handoff.md', capture: 'source' });
  assert.equal(old.captures[0].retrievedAt, '2020-01-01T00:00:00.000Z');
  assert.notEqual(old.captures[0].receivedAt, old.captures[0].retrievedAt);
  const request = {
    context: 'handoff.md',
    capture: 'source',
    hash: hash('changed bytes'),
    representation: 'original-bytes',
    basis: 'Selected bytes',
    origin,
    retrievedAt: '2020-01-01T00:00:00.000Z',
  };
  const checked = knowledge.checkCapture(request);
  assert.equal(checked.comparison, 'supplied_bytes_changed');
  assert.equal(checked.originalFreshness, 'host_asserted_only');
  assert.equal(checked.changedStoredContent, false);
  assert.equal(checked.hostDeclaredRetrievedAt, request.retrievedAt);
  assert.equal(
    knowledge.checkCapture({ ...request, basis: 'Different extraction' }).comparison,
    'basis_changed',
  );
  assert.equal(knowledge.read({ context: 'handoff.md', capture: 'source' }).text, 'original bytes');
  assert.equal(store.head('handoff.md').version, saved.version);
});

test('binary capture paging preserves exact bytes and duplicate IDs do not commit', t => {
  const { workspace, store, knowledge } = fixture(t),
    bytes = Buffer.from([0, 255, 240, 159, 153, 130, 13, 10, 128, 1]);
  const request = {
    context: 'binary.md',
    expectedVersion: null,
    markdown: 'Binary source',
    captures: [capture(bytes)],
  };
  assert.throws(
    () => store.save({ ...request, captures: [capture(bytes), capture('other bytes')] }),
    /distinct/,
  );
  assert.equal(store.resume({ context: 'binary.md' }).version, null);
  const saved = store.save(request),
    parts = [];
  let offset = 0;
  do {
    const page = knowledge.read({
      context: 'binary.md',
      version: saved.version,
      capture: 'source',
      offset,
      limit: 3,
      representation: 'base64',
    });
    assert.equal(page.hash, hash(bytes));
    parts.push(Buffer.from(page.base64, 'base64'));
    offset = page.nextOffset;
  } while (offset !== null);
  assert.deepEqual(Buffer.concat(parts), bytes);
  assert.equal(existsSync(join(workspace, 'binary.md')), true);
});

test('capture selection omission retains, explicit clearing preserves historical bytes, and retries stay identical', t => {
  const { store, knowledge } = fixture(t);
  const request = {
    context: 'handoff.md',
    expectedVersion: null,
    markdown: 'First capture',
    captures: [capture('exact retained capture')],
  };
  const first = store.save(request);
  const replay = store.save(request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.version, first.version);
  const retained = store.save({
    context: request.context,
    expectedVersion: first.version,
    markdown: 'Later progress',
  });
  assert.equal(
    knowledge.read({ context: request.context, capture: 'source' }).text,
    'exact retained capture',
  );
  const cleared = store.save({
    context: request.context,
    expectedVersion: retained.version,
    markdown: 'Selection cleared',
    captures: [],
  });
  assert.deepEqual(knowledge.resume({ context: request.context }).captures, []);
  assert.throws(
    () => knowledge.read({ context: request.context, capture: 'source' }),
    /not selected/,
  );
  assert.equal(
    knowledge.read({ context: request.context, version: first.version, capture: 'source' }).text,
    'exact retained capture',
  );
  const oldRetry = store.save(request);
  assert.equal(oldRetry.version, first.version);
  assert.equal(oldRetry.currentVersion, cleared.version);
  assert.equal(store.head(request.context).version, cleared.version);
});

test('corrupt capture snapshots fail resume and exact reads instead of returning unchecked bytes', t => {
  const { store, knowledge } = fixture(t);
  const saved = save(store, { captures: [capture('verified capture')] });
  const loc = store.location('handoff.md'),
    item = store.head('handoff.md').saved.captures[0];
  writeFileSync(join(loc.directory, 'evidence', item.snapshot), 'tampered capture');
  assert.throws(() => knowledge.resume({ context: 'handoff.md' }), /integrity/i);
  assert.throws(() => knowledge.read({ context: 'handoff.md', capture: 'source' }), /integrity/i);
  assert.equal(store.head('handoff.md').version, saved.version);
});

test('missing, saved and unreadable-working-copy resumes omit absolute workspace locators', t => {
  const { workspace, store, knowledge } = fixture(t);
  const strings = value =>
    typeof value === 'string'
      ? [value]
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(strings)
        : [];
  const check = view => {
    for (const value of strings(view)) {
      assert.equal(
        value.replaceAll('\\', '/').includes(workspace.replaceAll('\\', '/')),
        false,
        'Response leaked the absolute workspace locator',
      );
    }
  };
  check(knowledge.resume({ context: 'handoff.md' }));
  save(store, { captures: [capture('selected capture')] });
  check(knowledge.resume({ context: 'handoff.md' }));
  writeFileSync(join(workspace, 'handoff.md'), Buffer.from([255]));
  const unavailable = knowledge.resume({ context: 'handoff.md' });
  assert.equal(unavailable.workingCopy.status, 'unavailable');
  check(unavailable);
});

test('selected clean-store rebuild excludes old snapshots, manual text and recovery while preserving the original', t => {
  const source = fixture(t),
    target = fixture(t),
    marker = 'SYNTHETIC_RETIRED_HISTORY_654321';
  writeFileSync(join(source.workspace, 'old-evidence.txt'), marker + '_EVIDENCE');
  const old = save(source.store, {
    markdown: marker + '_MARKDOWN',
    evidence: ['old-evidence.txt'],
  });
  writeFileSync(join(source.workspace, 'handoff.md'), marker + '_MANUAL');
  const clean = source.store.save({
    context: 'handoff.md',
    expectedVersion: old.version,
    markdown: 'Clean selected continuation',
    evidence: [],
    workingCopyHash: hash(marker + '_MANUAL'),
    captures: [
      capture('Reviewed selected support', {
        transfer: 'allowed',
        scope: 'Reusable synthetic example',
      }),
    ],
  });
  // Deliberately produce a recovery record containing earlier private working text.
  writeFileSync(join(source.workspace, 'handoff.md'), marker + '_RECOVERY');
  const inspection = source.store.inspect('handoff.md');
  source.store.restore(
    'handoff.md',
    clean.version,
    inspection.headHash,
    inspection.workingCopyHash,
  );
  const loc = source.store.location('handoff.md');
  assert.equal(
    contents(loc.directory).some(bytes => bytes.includes(Buffer.from(marker))),
    true,
  );
  const sourceHead = readFileSync(loc.head),
    sourceHistory = contents(loc.directory)
      .map(bytes => hash(bytes))
      .sort();
  const transfer = new Transfers(source.store),
    receiving = new Transfers(target.store);
  const selection = {
    context: 'handoff.md',
    version: clean.version,
    captures: ['source'],
    evidence: [],
  };
  const preview = transfer.run({ action: 'preview', ...selection });
  assert.equal('bundle' in preview, false);
  assert.equal(JSON.stringify(preview).includes(marker), false);
  const exported = transfer.run({
    action: 'export',
    ...selection,
    reviewedHash: preview.payloadHash,
  });
  assert.equal(JSON.stringify(exported).includes(marker), false);
  const importPreview = receiving.run({ action: 'preview-import', bundle: exported.bundle });
  // Interrupted review/rejected adoption cannot create a selected destination head.
  assert.throws(
    () =>
      receiving.run({
        action: 'import',
        bundle: exported.bundle,
        reviewedHash: '0'.repeat(64),
        context: 'rebuilt.md',
        expectedVersion: null,
      }),
    /reviewed/,
  );
  assert.equal(target.store.resume({ context: 'rebuilt.md' }).version, null);
  assert.deepEqual(readFileSync(loc.head), sourceHead);
  const imported = receiving.run({
    action: 'import',
    bundle: exported.bundle,
    reviewedHash: importPreview.payloadHash,
    context: 'rebuilt.md',
    expectedVersion: null,
  });
  assert.equal(imported.committed, true);
  assert.equal(
    target.knowledge.read({ context: 'rebuilt.md' }).text,
    'Clean selected continuation',
  );
  assert.equal(
    target.knowledge.read({ context: 'rebuilt.md', capture: 'source' }).text,
    'Reviewed selected support',
  );
  assert.equal(target.store.inspect('rebuilt.md').revisions.length, 1);
  assertAbsent(target.workspace, marker);
  // The procedure deliberately leaves original contaminated data intact until separate retirement.
  assert.deepEqual(readFileSync(loc.head), sourceHead);
  assert.deepEqual(
    contents(loc.directory)
      .map(bytes => hash(bytes))
      .sort(),
    sourceHistory,
  );
  assert.equal(
    contents(loc.directory).some(bytes => bytes.includes(Buffer.from(marker))),
    true,
  );
});

test('JSON credentials under an innocuous capture label are refused without retaining the value', t => {
  const { workspace, store } = fixture(t),
    marker = 'SYNTHETIC_JSON_CREDENTIAL_112233';
  const body = JSON.stringify({ password: marker });
  assert.throws(
    () => save(store, { captures: [capture(body, { label: 'Ordinary document' })] }),
    error => {
      assert.match(error.message, /sensitive material/);
      assert.equal(error.message.includes(marker), false);
      return true;
    },
  );
  assertAbsent(workspace, marker);
  assert.equal(store.resume({ context: 'handoff.md' }).version, null);
});

test('read and search recheck captures whose saved sensitivity flag predates the current detector', t => {
  const { store, knowledge } = fixture(t),
    body = 'password=SYNTHETIC_SECRET_112233';
  save(store, { captures: [capture(body, { sensitiveAcknowledgement: hash(body) })] });
  const loc = store.location('handoff.md');
  // Model a valid older revision whose detector did not yet mark these bytes sensitive.
  const oldRevision = structuredClone(store.head('handoff.md').saved);
  oldRevision.captures[0].sensitive = false;
  const bytes = JSON.stringify(oldRevision),
    version = hash(bytes);
  writeFileSync(join(loc.directory, 'revisions', version + '.json'), bytes);
  writeFileSync(loc.head, JSON.stringify({ format: 1, version }));

  assert.throws(
    () => knowledge.read({ context: 'handoff.md', capture: 'source' }),
    error => {
      assert.match(error.message, /withheld unless allowSensitive:true/);
      assert.equal(error.message.includes(body), false);
      return true;
    },
  );
  const bodySearch = knowledge.find({ query: 'SYNTHETIC_SECRET_112233' });
  assert.deepEqual(bodySearch.results, []);
  assert.equal(bodySearch.skippedSensitiveBodies, 1);
  const labelSearch = knowledge.find({ query: 'Selected source', detail: 'full' });
  assert.equal(labelSearch.results[0].sources[0].sensitive, true);
  assert.equal(labelSearch.results[0].sources[0].excerpt, undefined);
  const approved = knowledge.read({
    context: 'handoff.md',
    capture: 'source',
    allowSensitive: true,
  });
  assert.equal(approved.text, body);
  assert.equal(approved.sensitive, true);
  assert.equal(approved.captures[0].sensitive, true);
});

test('portable metadata screening stays fast on long adversarial runs', async () => {
  const { assertPortableMetadata } = await import('../dist/captures.js');
  for (const flagged of [
    'mail person@example.invalid now',
    'see https://example.invalid/page?id=1',
    'at C:\\data\\file.txt',
    'in /home/person/file',
    'at \\\\server\\share\\file',
    'in /var/internal/file',
    'file:///home/person/file',
  ])
    assert.throws(() => assertPortableMetadata(flagged), /private locator/);
  assert.doesNotThrow(() => assertPortableMetadata('An ordinary label with no locator'));
  assert.doesNotThrow(() => assertPortableMetadata('https://example.invalid/public-document'));
  const size = 400000;
  for (const run of [
    'a'.repeat(size),
    'a.b-'.repeat(size / 4),
    'x@'.repeat(size / 2),
    'ftp//'.repeat(size / 5) + ' ' + '@a.'.repeat(size / 3),
  ]) {
    const started = performance.now();
    try {
      assertPortableMetadata(run);
    } catch {
      /* only duration matters here */
    }
    assert.ok(performance.now() - started < 2000, 'screening took too long');
  }
});
