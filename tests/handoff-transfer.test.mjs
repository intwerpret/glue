import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Handoffs, hash } from '../dist/handoff.js';
import { Knowledge } from '../dist/knowledge.js';
import { Transfers } from '../dist/transfer.js';

function fixture(t) {
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), 'glue-transfer-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const store = new Handoffs(workspace);
  return { workspace, store, knowledge: new Knowledge(store), transfers: new Transfers(store) };
}
const initialize = {
  jsonrpc: '2.0',
  id: 'init',
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1' },
  },
};
const ready = { jsonrpc: '2.0', method: 'notifications/initialized' };
const call = (id, name, args) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});
function mcp(workspace, messages) {
  const input = messages.map(value => JSON.stringify(value)).join('\n') + '\n';
  const child = spawnSync(process.execPath, ['dist/mcp.js', workspace], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
}
const capture = (id, text, extra = {}) => ({
  id,
  label: 'Selected source',
  representation: 'excerpt',
  basis: 'Selected paragraph',
  scope: 'Applies to the named experiment only.',
  transfer: 'allowed',
  base64: Buffer.from(text).toString('base64'),
  ...extra,
});
const save = (store, markdown, extra = {}) =>
  store.save({ context: 'note.md', expectedVersion: null, markdown, ...extra });
function exported(transfers, selection) {
  const preview = transfers.run({ action: 'preview', ...selection });
  return transfers.run({ action: 'export', ...selection, reviewedHash: preview.payloadHash });
}

test('preview shows hashes but no content, and export needs the previewed hash', t => {
  const { store, transfers } = fixture(t),
    receipt = save(store, 'SELECTED_MARKDOWN_CONTENT', {
      captures: [capture('a', 'SELECTED_CAPTURE_CONTENT')],
    });
  const selection = { context: 'note.md', version: receipt.version, captures: ['a'] };
  const preview = transfers.run({ action: 'preview', ...selection });
  assert.doesNotMatch(
    JSON.stringify(preview),
    /SELECTED_MARKDOWN_CONTENT|SELECTED_CAPTURE_CONTENT/,
  );
  assert.equal(Object.hasOwn(preview, 'bundle'), false);
  assert.equal(preview.manifest.captures.length, 1);
  assert.throws(
    () => transfers.run({ action: 'export', ...selection, reviewedHash: hash('wrong') }),
    /not reviewed/,
  );
  const result = transfers.run({
    action: 'export',
    ...selection,
    reviewedHash: preview.payloadHash,
  });
  assert.equal(result.bundle.markdown, 'SELECTED_MARKDOWN_CONTENT');
  assert.equal(result.independentCopy, true);
  assert.equal(transfers.run({ action: 'preview', ...selection }).payloadHash, preview.payloadHash);
});

test('an export carries only what you selected, and the import becomes a proposed copy', t => {
  const source = fixture(t),
    target = fixture(t);
  writeFileSync(join(source.workspace, 'excluded-private-name.txt'), 'EXCLUDED_PRIVATE_PAYLOAD');
  const dependency = source.store.save({
    context: 'private-dependency.md',
    expectedVersion: null,
    markdown: 'PRIVATE_DEPENDENCY_PAYLOAD',
  });
  const first = save(source.store, 'OLD_PRIVATE_HISTORY');
  const current = source.store.save({
    context: 'note.md',
    expectedVersion: first.version,
    markdown: 'Reviewed current summary',
    evidence: ['excluded-private-name.txt'],
    captures: [
      capture('a', 'Selected support'),
      capture('b', 'UNSELECTED_CAPTURE_PAYLOAD', { transfer: 'project-only' }),
    ],
    dependsOn: [{ context: 'private-dependency.md', version: dependency.version }],
    record: {
      title: 'Bounded finding',
      scope: 'Only the named experiment.',
      kind: 'finding',
      provenance: 'user',
      status: 'active',
    },
  });
  const { bundle, payloadHash } = exported(source.transfers, {
    context: 'note.md',
    version: current.version,
    captures: ['a'],
  });
  assert.equal(bundle.omittedSupport, 3);
  assert.doesNotMatch(
    JSON.stringify(bundle),
    /OLD_PRIVATE_HISTORY|PRIVATE_DEPENDENCY|private-dependency|excluded-private-name|EXCLUDED_PRIVATE|UNSELECTED_CAPTURE/,
  );
  const reviewed = target.transfers.run({ action: 'preview-import', bundle });
  assert.equal(reviewed.payloadHash, payloadHash);
  const input = {
    action: 'import',
    bundle,
    reviewedHash: payloadHash,
    context: 'reused.md',
    expectedVersion: null,
  };
  const imported = target.transfers.run(input);
  assert.equal(imported.committed, true);
  assert.equal(imported.upstreamStatus, 'not-checked');
  const saved = target.store.head('reused.md').saved;
  assert.equal(saved.record.status, 'proposed');
  assert.equal(saved.record.provenance, 'source');
  assert.equal(saved.imported.sourceStatus, 'active');
  assert.equal(saved.imported.sourceProvenance, 'user');
  assert.equal(saved.imported.localModified, false);
  assert.equal(saved.imported.payloadHash, payloadHash);
  assert.deepEqual(saved.dependsOn, []);
  assert.deepEqual(saved.evidence, []);
  assert.equal(saved.captures.length, 1);
  assert.equal(target.transfers.run(input).replayed, true);
  assert.equal(
    saved.captures[0].originReceivedAt,
    source.store.head('note.md').saved.captures[0].receivedAt,
  );
  assert.ok(saved.captures[0].receivedAt);
  const secondExport = exported(target.transfers, {
    context: 'reused.md',
    version: imported.version,
    captures: ['a'],
  });
  assert.equal(secondExport.bundle.omittedSupport, 3);
  assert.equal(
    secondExport.bundle.captures[0].originReceivedAt,
    saved.captures[0].originReceivedAt,
  );
  source.store.save({
    context: 'note.md',
    expectedVersion: current.version,
    markdown: 'Changed upstream',
  });
  assert.equal(target.store.resume({ context: 'reused.md' }).markdown, 'Reviewed current summary');
});

test('project-only, restricted or sensitive material cannot be exported', t => {
  for (const item of [
    capture('a', 'Ordinary private capture', { transfer: 'project-only' }),
    capture('a', 'Restricted', { scope: 'Do not share this capture' }),
    capture('a', 'password=FAKE_SYNTHETIC_SECRET', {
      sensitiveAcknowledgement: hash('password=FAKE_SYNTHETIC_SECRET'),
    }),
  ]) {
    const { store, transfers } = fixture(t),
      receipt = save(store, 'A safe summary', { captures: [item] });
    assert.throws(
      () =>
        transfers.run({
          action: 'preview',
          context: 'note.md',
          version: receipt.version,
          captures: ['a'],
        }),
      /private or sensitive/,
    );
  }
  const { store, transfers } = fixture(t),
    receipt = save(store, 'Restricted finding', {
      record: {
        title: 'Finding',
        scope: 'Project-only exception',
        kind: 'finding',
        provenance: 'user',
        status: 'active',
      },
    });
  assert.throws(
    () => transfers.run({ action: 'preview', context: 'note.md', version: receipt.version }),
    /restricts transfer/,
  );
});

test('the handoff text is screened too, and a rewritten summary is marked as derived', t => {
  const { store, transfers } = fixture(t),
    receipt = save(store, 'Contact private.person@example.invalid for this work.');
  const selection = { context: 'note.md', version: receipt.version };
  assert.throws(() => transfers.run({ action: 'preview', ...selection }), /private locator/);
  const { bundle } = exported(transfers, {
    ...selection,
    derivativeMarkdown: 'A reviewed anonymous summary.',
  });
  assert.equal(bundle.derived, true);
  assert.equal(bundle.markdownHash, hash('A reviewed anonymous summary.'));
  assert.notEqual(bundle.markdownHash, hash(store.head('note.md').saved.markdown));
  assert.equal(bundle.origin.version, receipt.version);
});

test('exported evidence uses the label you give it, never its file path', t => {
  const { workspace, store, transfers } = fixture(t);
  writeFileSync(join(workspace, 'internal-source-name.txt'), 'Reviewed evidence');
  const receipt = save(store, 'A selected finding', { evidence: ['internal-source-name.txt'] });
  const { bundle } = exported(transfers, {
    context: 'note.md',
    version: receipt.version,
    evidence: [
      {
        path: 'internal-source-name.txt',
        id: 'source',
        label: 'Experiment extract',
        scope: 'This experiment only',
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(bundle), /internal-source-name/);
  assert.equal(bundle.captures[0].representation, 'original-bytes');
  assert.equal(Buffer.from(bundle.captures[0].base64, 'base64').toString(), 'Reviewed evidence');
  assert.throws(
    () =>
      transfers.run({
        action: 'preview',
        context: 'note.md',
        version: receipt.version,
        evidence: [
          { path: 'internal-source-name.txt', id: 'a', label: 'A', scope: 'This experiment' },
          { path: 'INTERNAL-SOURCE-NAME.TXT', id: 'b', label: 'B', scope: 'This experiment' },
        ],
      }),
    /only once/,
  );
});

test('a tampered, unreviewed or oversized bundle is refused, and nothing is imported', t => {
  const source = fixture(t),
    target = fixture(t),
    receipt = save(source.store, 'Safe content');
  const { bundle, payloadHash } = exported(source.transfers, {
    context: 'note.md',
    version: receipt.version,
  });
  assert.throws(
    () =>
      target.transfers.run({
        action: 'import',
        bundle,
        reviewedHash: hash('wrong'),
        context: 'target.md',
        expectedVersion: null,
      }),
    /not reviewed/,
  );
  assert.throws(
    () =>
      target.transfers.run({
        action: 'preview-import',
        bundle: { ...bundle, markdown: 'Altered' },
      }),
    /integrity/,
  );
  assert.equal(existsSync(join(target.workspace, '.glue')), false);
  const big = source.store.save({
    context: 'big.md',
    expectedVersion: null,
    markdown: 'Big selection',
    captures: [capture('large', 'x'.repeat(800000))],
  });
  assert.throws(
    () =>
      source.transfers.run({
        action: 'preview',
        context: 'big.md',
        version: big.version,
        captures: ['large'],
      }),
    /1 MiB/,
  );
  const changed = source.store.save({
    context: 'note.md',
    expectedVersion: receipt.version,
    markdown: 'New content',
  });
  assert.throws(
    () =>
      source.transfers.run({
        action: 'export',
        context: 'note.md',
        version: receipt.version,
        reviewedHash: payloadHash,
      }),
    /current saved/,
  );
  assert.notEqual(changed.version, receipt.version);
});

test('each project has a stable random ID that does not reveal its path', t => {
  const a = fixture(t),
    b = fixture(t),
    one = save(a.store, 'One'),
    two = save(b.store, 'One');
  const first = exported(a.transfers, { context: 'note.md', version: one.version }).bundle.origin;
  const next = exported(a.transfers, { context: 'note.md', version: one.version }).bundle.origin;
  const other = exported(b.transfers, { context: 'note.md', version: two.version }).bundle.origin;
  assert.equal(first.namespace, next.namespace);
  assert.notEqual(first.namespace, other.namespace);
  assert.match(first.namespace, /^[a-f0-9-]{36}$/);
  assert.equal(first.id, other.id);
  const stored = JSON.parse(readFileSync(join(a.workspace, '.glue/PROJECT.json'), 'utf8'));
  assert.equal(stored.namespace, first.namespace);
});

test('check compares against the version the host reports and never changes the copy', t => {
  const source = fixture(t),
    target = fixture(t),
    saved = save(source.store, 'Safe imported claim');
  const { bundle, payloadHash } = exported(source.transfers, {
    context: 'note.md',
    version: saved.version,
  });
  const imported = target.transfers.run({
    action: 'import',
    bundle,
    reviewedHash: payloadHash,
    context: 'reused.md',
    expectedVersion: null,
  });
  const before = JSON.stringify(target.store.head('reused.md').saved);
  for (const [upstream, status] of [
    [bundle.origin, 'unchanged'],
    [{ ...bundle.origin, version: hash('updated') }, 'changed'],
    [{ ...bundle.origin, id: 'different' }, 'different_source'],
    [null, 'unavailable'],
  ]) {
    const checked = target.transfers.run({
      action: 'check',
      context: 'reused.md',
      version: imported.version,
      upstream,
    });
    assert.equal(checked.status, status);
    assert.equal(checked.evidence, 'host_asserted_only');
    assert.equal(checked.changedStoredContent, false);
  }
  assert.equal(JSON.stringify(target.store.head('reused.md').saved), before);
  assert.equal(target.store.head('reused.md').version, imported.version);
});

test('editing an imported copy keeps its import record and marks it modified', t => {
  const source = fixture(t),
    target = fixture(t),
    saved = save(source.store, 'Original imported text');
  const { bundle, payloadHash } = exported(source.transfers, {
    context: 'note.md',
    version: saved.version,
  });
  const imported = target.transfers.run({
    action: 'import',
    bundle,
    reviewedHash: payloadHash,
    context: 'reused.md',
    expectedVersion: null,
  });
  assert.equal(target.store.head('reused.md').saved.imported.localModified, false);
  target.store.save({
    context: 'reused.md',
    expectedVersion: imported.version,
    markdown: 'Local interpretation with edits',
  });
  const metadata = target.store.head('reused.md').saved.imported;
  assert.equal(metadata.localModified, true);
  assert.equal(metadata.payloadHash, payloadHash);
  assert.equal(metadata.origin.version, saved.version);
});

test('only selected captures are exported, and the bundle imports through the MCP server', t => {
  const source = fixture(t),
    target = fixture(t);
  const receipt = source.store.save({
    context: 'note.md',
    expectedVersion: null,
    markdown: 'Reviewed summary',
    captures: [
      capture('allowed', 'Portable support', { transfer: 'allowed' }),
      capture('local', 'Project-only support', { transfer: 'project-only' }),
    ],
    record: {
      title: 'Sample record',
      kind: 'note',
      scope: 'test',
      provenance: 'assistant',
      status: 'active',
    },
  });
  const bare = source.transfers.run({
    action: 'preview',
    context: 'note.md',
    version: receipt.version,
  });
  assert.deepEqual(bare.manifest.captures, []);
  assert.equal(bare.manifest.omittedSupport, 2);
  const selection = { context: 'note.md', version: receipt.version, captures: ['allowed'] };
  const preview = source.transfers.run({ action: 'preview', ...selection });
  assert.equal(preview.manifest.captures.length, 1);
  assert.equal(preview.manifest.omittedSupport, 1);
  const { bundle, payloadHash } = source.transfers.run({
    action: 'export',
    ...selection,
    reviewedHash: preview.payloadHash,
  });
  assert.equal(bundle.captures[0].id, 'allowed');
  assert.throws(
    () => source.transfers.run({ action: 'preview', ...selection, captures: ['local'] }),
    /private or sensitive/,
  );
  // Round trip over the subprocess with real JSON types (object bundle, JSON null expectedVersion).
  const rows = mcp(target.workspace, [
    initialize,
    ready,
    call(1, 'glue_transfer', { action: 'preview-import', bundle }),
    call(2, 'glue_transfer', {
      action: 'import',
      bundle,
      reviewedHash: payloadHash,
      context: 'imported.md',
      expectedVersion: null,
    }),
    call(3, 'glue_resume', { context: 'imported.md' }),
  ]);
  assert.equal(JSON.parse(rows[1].result.content[0].text).payloadHash, payloadHash);
  const imported = JSON.parse(rows[2].result.content[0].text);
  assert.equal(imported.committed, true);
  assert.equal(imported.independentCopy, true);
  const resumed = JSON.parse(rows[3].result.content[0].text);
  assert.equal(resumed.record.status, 'proposed');
  assert.equal(resumed.captures.length, 1);
});

test('an imported copy never claims to match its source and never updates itself', t => {
  const a = fixture(t),
    b = fixture(t);
  const first = a.store.save({
    context: 'policy.md',
    expectedVersion: null,
    markdown: 'Alpha retention 30 days.',
  });
  const selection = { context: 'policy.md', version: first.version };
  const preview = a.transfers.run({ action: 'preview', ...selection });
  const exported = a.transfers.run({
    action: 'export',
    ...selection,
    reviewedHash: preview.payloadHash,
  });
  const received = b.transfers.run({ action: 'preview-import', bundle: exported.bundle });
  const copy = b.transfers.run({
    action: 'import',
    context: 'copy.md',
    expectedVersion: null,
    bundle: exported.bundle,
    reviewedHash: received.payloadHash,
  });
  a.store.save({
    context: 'policy.md',
    expectedVersion: first.version,
    markdown: 'Alpha retention 14 days.',
  });
  const local = b.knowledge.resume({ context: 'copy.md', knownVersion: copy.version });
  assert.equal(local.basis.status, 'review_needed');
  assert.deepEqual(
    local.basis.issues.map(i => i.reason),
    ['record_proposed'],
  );
  assert.equal(local.upstreamStatus, 'not-checked');
  const current = a.transfers.run({
    action: 'preview',
    context: 'policy.md',
    version: a.store.head('policy.md').version,
  });
  // The source identity is known from the received bundle; only the observed source head version
  // changed.
  const check = b.transfers.run({
    action: 'check',
    context: 'copy.md',
    upstream: { ...exported.bundle.origin, version: a.store.head('policy.md').version },
  });
  assert.equal(check.status, 'changed');
  assert.equal(check.changedStoredContent, false);
  assert.equal(
    b.transfers.run({ action: 'check', context: 'copy.md', upstream: null }).status,
    'unavailable',
  );
  assert.equal(b.store.head('copy.md').version, copy.version);
  assert.equal(b.knowledge.read({ context: 'copy.md' }).text, 'Alpha retention 30 days.');
  assert.ok(current.payloadHash);
});
