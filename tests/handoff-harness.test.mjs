import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync as require_read,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Handoffs, hash } from '../dist/handoff.js';
import { Knowledge } from '../dist/knowledge.js';
import { Transfers } from '../dist/transfer.js';

function fixture(t, prefix = 'glue-test-') {
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), prefix));
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
  label: 'Fictional capture',
  representation: 'excerpt',
  basis: 'synthetic',
  scope: 'test',
  base64: Buffer.from(text).toString('base64'),
  ...extra,
});
const SECRET = 'password=FAKE_SYNTHETIC_SECRET_VALUE_1234';

test('transfer advertises one flat object schema naming every action and field', t => {
  const { workspace } = fixture(t);
  const rows = mcp(workspace, [
    initialize,
    ready,
    { jsonrpc: '2.0', id: 'list', method: 'tools/list' },
  ]);
  const tools = rows[1].result.tools;
  const transfer = tools.find(tool => tool.name === 'glue_transfer');
  assert.equal(transfer.inputSchema.type, 'object');
  assert.equal(Object.hasOwn(transfer.inputSchema, 'anyOf'), false);
  assert.deepEqual(transfer.inputSchema.required, ['action']);
  assert.deepEqual(transfer.inputSchema.properties.action.enum, [
    'preview',
    'export',
    'preview-import',
    'check',
    'import',
  ]);
  for (const field of [
    'context',
    'version',
    'captures',
    'evidence',
    'derivativeMarkdown',
    'reviewedHash',
    'bundle',
    'expectedVersion',
    'workingCopyHash',
    'upstream',
  ])
    assert.ok(transfer.inputSchema.properties[field]?.description, field + ' is documented');
  assert.match(
    transfer.inputSchema.properties.captures.description,
    /does not include a capture automatically/,
  );
  assert.match(transfer.inputSchema.properties.expectedVersion.description, /create only if/);
  // Checkpoint documents the create-only meaning of null too.
  const checkpoint = tools.find(tool => tool.name === 'glue_checkpoint');
  assert.match(
    checkpoint.inputSchema.properties.expectedVersion.description,
    /create only if this context does not already exist/,
  );
  assert.match(
    checkpoint.inputSchema.properties.captures.description,
    /only permits later selection/,
  );
  // Every advertised tool has properties at the top level (no bare unions).
  for (const tool of tools)
    assert.ok(Object.keys(tool.inputSchema.properties ?? {}).length > 0, tool.name);
});

test('validation errors name the field and expected shape without echoing values', t => {
  const { workspace } = fixture(t);
  const marker = 'PRIVATE_SUBMITTED_VALUE_9';
  const rows = mcp(workspace, [
    initialize,
    ready,
    call(1, 'glue_transfer', {}),
    call(2, 'glue_transfer', { action: marker }),
    call(3, 'glue_transfer', { action: 'preview' }),
    call(4, 'glue_transfer', {
      action: 'import',
      bundle: marker,
      reviewedHash: marker,
      context: 'a.md',
      expectedVersion: 'null',
    }),
    call(5, 'glue_transfer', { action: 'check', context: 'a.md', upstream: null, [marker]: 1 }),
    call(6, 'glue_checkpoint', { context: 'a.md', expectedVersion: 'null', markdown: 'x' }),
  ]);
  const texts = rows.slice(1).map(row => {
    assert.equal(row.result.isError, true);
    return row.result.content[0].text;
  });
  for (const text of texts) assert.equal(text.includes(marker), false, text);
  assert.match(texts[0], /action, one of: preview, export, preview-import, check, import/);
  assert.match(texts[0], /import requires bundle, reviewedHash, context, expectedVersion/);
  assert.match(texts[1], /action, one of/);
  assert.match(
    texts[2],
    /context: expected string \(missing\); version: expected string \(missing\)/,
  );
  assert.match(texts[3], /bundle: expected object/);
  assert.match(texts[3], /expectedVersion: .*or JSON null \(not the string "null"\)/);
  assert.match(texts[4], /1 unrecognized field/);
  assert.match(texts[5], /expectedVersion: .*JSON null/);
});

test('explicit capture selection exports, previews and imports through the flat interface', t => {
  const source = fixture(t),
    target = fixture(t);
  const receipt = source.store.save({
    context: 'note.md',
    expectedVersion: null,
    markdown: 'Reviewed summary',
    captures: [
      capture('allowed', 'Portable support', { transfer: 'allowed' }),
      capture('local', 'Project-only support'),
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

test('acknowledged sensitive material is retained but never searched, excerpted or read without opt-in', t => {
  const { workspace, store, knowledge } = fixture(t);
  writeFileSync(join(workspace, 'needle-config.txt'), SECRET + '\nordinary line with needle\n');
  const receipt = store.save({
    context: 'note.md',
    expectedVersion: null,
    markdown: 'Summary mentions needle',
    captures: [
      capture('secret', SECRET + ' needle', {
        sensitiveAcknowledgement: hash(SECRET + ' needle'),
        label: 'Config needle',
      }),
    ],
    evidence: ['needle-config.txt'],
    sensitiveEvidence: [
      { path: 'needle-config.txt', hash: hash(SECRET + '\nordinary line with needle\n') },
    ],
  });
  const found = knowledge.find({ query: 'needle FAKE_SYNTHETIC', detail: 'full' });
  assert.equal(JSON.stringify(found).includes('FAKE_SYNTHETIC'), false);
  assert.equal(found.skippedSensitiveBodies, 2);
  const sources = found.results[0].sources;
  const captureHit = sources.find(item => item.capture === 'secret');
  assert.equal(captureHit.sensitive, true);
  assert.equal(captureHit.excerptOmitted, 'sensitive');
  assert.equal(Object.hasOwn(captureHit, 'excerpt'), false);
  const evidenceHit = sources.find(item => item.path === 'needle-config.txt');
  assert.equal(evidenceHit.sensitive, true);
  assert.equal(Object.hasOwn(evidenceHit, 'excerpt'), false);
  // A term that occurs only in a sensitive body does not match.
  assert.deepEqual(knowledge.find({ query: 'FAKE_SYNTHETIC' }).results, []);
  for (const selector of [{ capture: 'secret' }, { source: 'needle-config.txt' }]) {
    assert.throws(
      () => knowledge.read({ context: 'note.md', ...selector }),
      /marked sensitive.*allowSensitive/,
    );
    const read = knowledge.read({ context: 'note.md', ...selector, allowSensitive: true });
    assert.equal(read.sensitive, true);
    assert.match(read.text, /FAKE_SYNTHETIC/);
  }
  // Ordinary content is unaffected and reports sensitive:false.
  assert.equal(knowledge.read({ context: 'note.md' }).sensitive, false);
  const resumed = knowledge.resume({ context: 'note.md' });
  assert.equal(resumed.captures[0].sensitive, true);
  assert.equal(JSON.stringify(resumed).includes('FAKE_SYNTHETIC'), false);
  assert.equal(resumed.version, receipt.version);
});

test('rejected first saves leave no directory; resume of a missing context changes nothing', t => {
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

test('gap diagnostics distinguish remnants, uninitialized and damaged histories, naming verified contexts', t => {
  const { workspace, store, knowledge } = fixture(t);
  const contexts = join(workspace, '.glue', 'contexts');
  store.save({ context: 'healthy.md', expectedVersion: null, markdown: 'fine' });
  mkdirSync(join(contexts, hash('empty.md')), { recursive: true });
  mkdirSync(join(contexts, hash('junk.md')), { recursive: true });
  writeFileSync(join(contexts, hash('junk.md'), 'stray.txt'), 'x');
  mkdirSync(join(contexts, hash('headless.md'), 'revisions'), { recursive: true });
  writeFileSync(join(contexts, hash('headless.md'), '.initialized'), 'Glue handoff initialized\n');
  // Verified revision whose context directory does not match its identity: path is known and reported.
  const other = fixture(t, 'glue-test-other-');
  const receipt = other.store.save({
    context: 'moved.md',
    expectedVersion: null,
    markdown: 'MOVED_PRIVATE_TEXT',
  });
  const from = join(other.workspace, '.glue', 'contexts', hash('moved.md')),
    to = join(contexts, hash('elsewhere.md'));
  mkdirSync(join(to, 'revisions'), { recursive: true });
  writeFileSync(join(to, 'HEAD.json'), JSON.stringify({ format: 1, version: receipt.version }));
  writeFileSync(
    join(to, 'revisions', receipt.version + '.json'),
    require_read(join(from, 'revisions', receipt.version + '.json')),
  );
  const gaps = Object.fromEntries(knowledge.find({}).gaps.map(gap => [gap.contextId, gap]));
  assert.equal(gaps[hash('empty.md')].reason, 'empty_directory');
  assert.equal(gaps[hash('junk.md')].reason, 'uninitialized');
  assert.equal(gaps[hash('headless.md')].reason, 'missing_head');
  assert.equal(gaps[hash('elsewhere.md')].reason, 'context_unavailable');
  assert.equal(gaps[hash('elsewhere.md')].context, 'moved.md');
  assert.equal(JSON.stringify(gaps).includes('MOVED_PRIVATE_TEXT'), false);
  for (const gap of Object.values(gaps)) assert.ok(gap.note);
});

test('byte pages explain omitted text for split characters versus binary content', t => {
  const { store, knowledge } = fixture(t);
  store.save({
    context: 'note.md',
    expectedVersion: null,
    markdown: 'ab日本語',
    captures: [
      capture('bin', '', {
        base64: Buffer.from([0xff, 0xfe, 0x00, 0x41]).toString('base64'),
        representation: 'original-bytes',
      }),
    ],
  });
  const whole = knowledge.read({ context: 'note.md' });
  assert.equal(whole.text, 'ab日本語');
  assert.equal(Object.hasOwn(whole, 'textOmitted'), false);
  const split = knowledge.read({ context: 'note.md', offset: 3, limit: 4 });
  assert.equal(Object.hasOwn(split, 'text'), false);
  assert.match(split.textOmitted, /inside a multi-byte UTF-8 character/);
  assert.equal(Buffer.from(split.base64, 'base64').length, 4);
  assert.equal(split.nextOffset, 7);
  const aligned = knowledge.read({ context: 'note.md', offset: 2, limit: 6 });
  assert.equal(aligned.text, '日本');
  const binary = knowledge.read({ context: 'note.md', capture: 'bin' });
  assert.match(binary.textOmitted, /not independently valid UTF-8/);
  assert.equal(binary.base64, Buffer.from([0xff, 0xfe, 0x00, 0x41]).toString('base64'));
});

test('status filtering hides withdrawn work reversibly while history and explicit reads remain', t => {
  const { store, knowledge } = fixture(t);
  const record = status => ({
    title: 'Sample',
    kind: 'note',
    scope: 'test',
    provenance: 'assistant',
    status,
  });
  const a = store.save({
    context: 'a.md',
    expectedVersion: null,
    markdown: 'sample alpha',
    record: record('active'),
  });
  const w = store.save({
    context: 'a.md',
    expectedVersion: a.version,
    markdown: 'sample alpha withdrawn',
    record: record('withdrawn'),
  });
  const b = store.save({
    context: 'b.md',
    expectedVersion: null,
    markdown: 'sample beta',
    record: record('proposed'),
  });
  const c = store.save({ context: 'c.md', expectedVersion: null, markdown: 'sample gamma' });
  const s = store.save({
    context: 'd.md',
    expectedVersion: null,
    markdown: 'sample delta',
    record: { ...record('superseded'), supersededBy: { context: 'b.md', version: b.version } },
  });
  const paths = page => page.results.map(item => item.context).sort();
  assert.deepEqual(paths(knowledge.find({ query: 'sample' })), ['a.md', 'b.md', 'c.md', 'd.md']);
  const open = knowledge.find({ query: 'sample', view: 'open' });
  assert.deepEqual(paths(open), ['b.md', 'c.md']);
  assert.deepEqual(open.filter, { view: 'open', statuses: ['active', 'proposed', 'none'] });
  assert.equal(open.scannedRevisions, 4);
  assert.deepEqual(paths(knowledge.find({ query: 'sample', status: ['withdrawn'] })), ['a.md']);
  assert.deepEqual(paths(knowledge.find({ query: 'sample', status: ['none'] })), ['c.md']);
  assert.deepEqual(
    paths(knowledge.find({ query: 'sample', status: ['superseded'], view: 'open' })),
    ['d.md'],
  );
  // History: the earlier active revision of a.md is open work again when history is included.
  const history = knowledge.find({ query: 'sample', view: 'open', includeHistory: true });
  assert.deepEqual(
    history.results.filter(item => item.context === 'a.md').map(item => item.version),
    [a.version],
  );
  // Paged open view with cursor keeps the filter and never duplicates.
  const seen = [];
  let cursor;
  do {
    const page = knowledge.find({
      query: 'sample',
      view: 'open',
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    seen.push(...page.results.map(r => r.context));
    cursor = page.next;
  } while (cursor);
  assert.deepEqual(seen.sort(), ['b.md', 'c.md']);
  // Withdrawn remains readable and resumable: nothing was deleted.
  assert.equal(knowledge.read({ context: 'a.md' }).version, w.version);
  assert.equal(knowledge.resume({ context: 'd.md' }).version, s.version);
});

test('short search modes preserve sensitive-body exclusion and MCP advertises detail', t => {
  const { workspace, store, knowledge } = fixture(t);
  store.save({
    context: 'sensitive.md',
    expectedVersion: null,
    markdown: 'Safe note',
    captures: [
      capture('secret', SECRET, { label: 'NamedNeedle', sensitiveAcknowledgement: hash(SECRET) }),
    ],
  });
  for (const detail of ['compact', 'concise', 'full']) {
    const page = knowledge.find({ query: 'NamedNeedle', detail });
    assert.equal(page.results.length, 1);
    assert.equal(page.skippedSensitiveBodies, 1);
    assert.ok(!JSON.stringify(page).includes(SECRET));
    assert.deepEqual(knowledge.find({ query: 'FAKE_SYNTHETIC', detail }).results, []);
  }
  assert.equal(
    knowledge.find({ query: 'NamedNeedle' }).results[0].match.excerptOmitted,
    'sensitive',
  );
  const rows = mcp(workspace, [
    initialize,
    ready,
    { jsonrpc: '2.0', id: 'list', method: 'tools/list' },
    call('find', 'glue_find', { query: 'NamedNeedle' }),
  ]);
  assert.deepEqual(
    rows[1].result.tools.find(x => x.name === 'glue_find').inputSchema.properties.detail.enum,
    ['compact', 'concise', 'full'],
  );
  assert.equal(JSON.parse(rows[2].result.content[0].text).detail, 'concise');
});

test('local import freshness cannot certify upstream currency or silently adopt a changed origin', t => {
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
  // The source identity is known from the received bundle; only the observed source head version changed.
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
