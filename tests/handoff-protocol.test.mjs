import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const initialize = (id = 'initialize', protocolVersion = '2025-11-25') => ({
  jsonrpc: '2.0', id, method: 'initialize',
  params: { protocolVersion, capabilities: {}, clientInfo: { name: 'protocol-fixture', version: '1.0' } },
});
const ready = { jsonrpc: '2.0', method: 'notifications/initialized' };
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
function fixture(t) {
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), 'glue-protocol-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const run = messages => {
    const input = messages.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n';
    const child = spawnSync(process.execPath, ['dist/mcp.js', workspace], { input, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '');
    return child.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
  };
  return { workspace, run };
}

test('MCP negotiates an implemented version, reports package identity and accepts host metadata', t => {
  const { workspace, run } = fixture(t);
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  for (const offered of ['2025-11-25', 'unknown-protocol', '2024-11-05']) {
    const init = initialize(0, offered);
    init.params.clientInfo.title = 'Independent host';
    init.params.capabilities = { roots: { listChanged: true }, experimental: { future: {} } };
    const rows = run([init, ready, request('list', 'tools/list', { _meta: { progressToken: 'test' } })]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, 0);
    assert.equal(rows[0].result.protocolVersion, '2025-11-25');
    assert.equal(rows[0].result.serverInfo.version, version);
    assert.equal(rows[0].result.instructions.includes('Codex'), false);
    assert.deepEqual(rows[0].result.capabilities, { tools: {} });
    assert.deepEqual(rows[1].result.tools.map(tool => tool.name), ['glue_resume', 'glue_checkpoint', 'glue_find', 'glue_read', 'glue_check_capture', 'glue_transfer']);
  }
  assert.deepEqual(readdirSync(workspace), []);
});

test('MCP rejects malformed initialization without changing state and requires initialized notification', t => {
  const { workspace, run } = fixture(t);
  const rows = run([
    request(1, 'tools/call', { name: 'glue_checkpoint', arguments: { context: 'unexpected.md', expectedVersion: null, markdown: 'must not save' } }),
    request(2, 'ping'),
    request(3, 'initialize', { protocolVersion: 123, capabilities: {}, clientInfo: { name: 'fixture', version: '1' } }),
    request(4, 'initialize', { protocolVersion: '2025-11-25' }),
    initialize(5), request(6, 'tools/list'),
    { ...ready, params: [] }, request(7, 'tools/list'),
    ready, request(8, 'tools/list'), initialize(9), request(10, 'ping'),
  ]);
  const byId = new Map(rows.map(row => [row.id, row]));
  assert.equal(byId.get(1).error.code, -32002);
  assert.deepEqual(byId.get(2).result, {});
  assert.equal(byId.get(3).error.code, -32602);
  assert.equal(byId.get(4).error.code, -32602);
  assert.ok(byId.get(5).result.serverInfo);
  assert.equal(byId.get(6).error.code, -32002);
  assert.equal(byId.get(7).error.code, -32002);
  assert.ok(byId.get(8).result.tools);
  assert.equal(byId.get(9).error.code, -32600);
  assert.deepEqual(byId.get(10).result, {});
  assert.deepEqual(readdirSync(workspace), []);
});

test('MCP distinguishes parse, envelope, method and parameter failures and keeps serving', t => {
  const { workspace, run } = fixture(t);
  const rows = run([
    '{broken', null, [], 7,
    { id: 1, method: 'ping' }, { jsonrpc: '1.0', id: 2, method: 'ping' },
    request(null, 'ping'), request(true, 'ping'), request(1.5, 'ping'),
    { ...request(3, 'ping'), result: {} },
    initialize(), ready,
    request('params', 'ping', []), request('method', 'missing/method'),
    request('call', 'tools/call', {}), request('unknown', 'tools/call', { name: 'missing' }),
    request('cursor', 'tools/list', { cursor: 'invented' }), request('last', 'ping'),
  ]);
  assert.equal(rows[0].error.code, -32700);
  for (const row of rows.slice(1, 10)) { assert.equal(row.error.code, -32600); assert.equal(row.id, null); }
  const byId = new Map(rows.map(row => [row.id, row]));
  assert.equal(byId.get('params').error.code, -32602);
  assert.equal(byId.get('method').error.code, -32601);
  assert.equal(byId.get('call').error.code, -32602);
  assert.equal(byId.get('unknown').error.code, -32602);
  assert.equal(byId.get('cursor').error.code, -32602);
  assert.deepEqual(byId.get('last').result, {});
  assert.deepEqual(readdirSync(workspace), []);
});

test('MCP never executes tool notifications or responds to ordinary notifications', t => {
  const { workspace, run } = fixture(t);
  const rows = run([
    initialize(), ready,
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'glue_checkpoint', arguments: { context: 'unexpected.md', expectedVersion: null, markdown: 'must not save' } } },
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
    { jsonrpc: '2.0', method: 'unknown/notification' }, request('done', 'ping'),
  ]);
  assert.deepEqual(rows.map(row => row.id), ['initialize', 'done']);
  assert.deepEqual(readdirSync(workspace), []);
});

test('MCP tool validation and execution failures remain tool errors after initialization', t => {
  const { workspace, run } = fixture(t);
  const rows = run([
    initialize(), ready,
    request(1, 'tools/call', { name: 'glue_resume', arguments: { context: 17 } }),
    request(2, 'tools/call', { name: 'glue_checkpoint', arguments: { context: 'note.md', expectedVersion: 'a'.repeat(64), markdown: 'stale' } }),
    request(3, 'tools/call', { name: 'glue_resume', arguments: { context: 'note.md' }, _meta: { progressToken: 3 } }),
  ]);
  assert.equal(rows[1].result.isError, true);
  assert.equal(rows[2].result.isError, true);
  assert.equal(rows[1].error, undefined);
  assert.equal(JSON.parse(rows[3].result.content[0].text).version, null);
  assert.equal(readdirSync(workspace).includes('note.md'), false);
});


test('MCP error diagnostics omit malformed values and absolute project paths', t => {
  const { workspace, run } = fixture(t);
  const marker = 'private-malformed-value-42';
  const rows = run([
    initialize(), ready,
    request(1, 'tools/call', { name: 'glue_checkpoint', arguments: { context: 'note.md', expectedVersion: marker, markdown: 'safe', [marker]: marker } }),
    request(2, 'tools/call', { name: 'glue_checkpoint', arguments: { context: 'note.md', expectedVersion: null, markdown: 'safe', evidence: ['missing.txt'] } }),
    request(3, 'tools/call', { name: 'glue_check_capture', arguments: { context: 'note.md', capture: 'example', hash: marker, representation: marker, basis: 'full text', retrievedAt: marker } }),
  ]);
  for (const row of rows.slice(1)) {
    assert.equal(row.result.isError, true);
    const text = row.result.content[0].text;
    assert.equal(text.includes(marker), false);
    assert.equal(text.includes(workspace), false);
    assert.equal(text.includes(workspace.replaceAll('\\', '/')), false);
  }
  assert.match(rows[1].result.content[0].text, /Invalid Glue arguments/);
  assert.match(rows[2].result.content[0].text, /Filesystem operation failed \(ENOENT\)/);
});

const call = (id, name, args) => request(id, 'tools/call', { name, arguments: args });
const resultText = row => row.result.content[0].text;

test('checkpoint callers cannot declare import provenance; only a transfer import records it', t => {
  const { run } = fixture(t);
  const imported = { origin: { namespace: 'example', id: 'forged', version: 'v1' }, payloadHash: 'a'.repeat(64), omittedSupport: 0, sourceStatus: 'active', derived: false };
  const rows = run([initialize(), ready, request(1, 'tools/list'),
    call(2, 'glue_checkpoint', { context: 'note.md', expectedVersion: null, markdown: 'Plain note', imported }),
    call(3, 'glue_resume', { context: 'note.md' })]);
  const checkpoint = rows[1].result.tools.find(tool => tool.name === 'glue_checkpoint');
  assert.equal(Object.hasOwn(checkpoint.inputSchema.properties, 'imported'), false);
  assert.equal(rows[2].result.isError, true);
  assert.match(resultText(rows[2]), /Invalid Glue arguments.*unrecognized field/);
  assert.equal(JSON.parse(resultText(rows[3])).version, null);
});

test('damaged saved files are reported as damaged history, not as invalid caller arguments', t => {
  const { workspace, run } = fixture(t);
  run([initialize(), ready, call(1, 'glue_checkpoint', { context: 'note.md', expectedVersion: null, markdown: 'Saved note' })]);
  const contexts = join(workspace, '.glue', 'contexts'), directory = join(contexts, readdirSync(contexts)[0]);
  writeFileSync(join(directory, 'HEAD.json'), JSON.stringify({ format: 1, version: 'not-a-digest' }));
  const rows = run([initialize(), ready, call(1, 'glue_resume', { context: 'note.md' })]);
  assert.equal(rows[1].result.isError, true);
  assert.doesNotMatch(resultText(rows[1]), /Invalid Glue arguments|nothing was saved/);
  assert.match(resultText(rows[1]), /Saved Glue data is damaged.*recovery/);
  assert.equal(resultText(rows[1]).includes('not-a-digest'), false);
});

test('MCP serves a host runtime whose stdin only emits data events and whose stdout ignores write callbacks', t => {
  const { workspace } = fixture(t);
  // Stand-in for a bundled host runtime: stdin is a bare event emitter, not an async-iterable stream.
  const harness = `
    import { EventEmitter } from 'node:events';
    const real = process.stdin, fake = new EventEmitter();
    Object.defineProperty(process, 'stdin', { value: fake });
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = chunk => write(chunk);
    const { serveMcp } = await import(${JSON.stringify(new URL('../dist/mcp.js', import.meta.url).href)});
    const serving = serveMcp(process.argv[1]);
    real.on('data', chunk => fake.emit('data', chunk));
    real.on('end', () => fake.emit('end'));
    await serving;
  `;
  const input = [initialize(), ready, request(1, 'tools/list')].map(value => JSON.stringify(value)).join('\n') + '\n';
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', harness, workspace], { input, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const rows = child.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].result.tools.length, 6);
});

test('event-only host input refuses an excessive queued burst without retaining an unlimited backlog', t => {
  const { workspace } = fixture(t);
  for (const [count, padding] of [[12, 512 * 1024], [2048, 0]]) {
    const harness = `
      import assert from 'node:assert/strict';
      import { EventEmitter } from 'node:events';
      const input = new EventEmitter();
      Object.defineProperty(process, 'stdin', { value: input });
      process.stdout.write = () => true;
      const { serveMcp } = await import(${JSON.stringify(new URL('../dist/mcp.js', import.meta.url).href)});
      const serving = serveMcp(process.argv[1]);
      const checked = assert.rejects(serving, /Input queue limit exceeded/);
      setImmediate(() => {
        const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { padding: 'x'.repeat(${padding}) } }) + String.fromCharCode(10);
        for (let i = 0; i < ${count}; i++) input.emit('data', Buffer.from(line));
        input.emit('end');
      });
      await checked;
      assert.equal(input.listenerCount('data'), 0);
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', harness, workspace], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
  }
  assert.deepEqual(readdirSync(workspace), []);
});

test('ordinary stdin applies backpressure and serves a burst larger than the host fallback queue limit', t => {
  const { run } = fixture(t);
  const rows = run(Array.from({ length: 12 }, (_, id) => request(id, 'ping', { padding: 'x'.repeat(512 * 1024) })));
  assert.deepEqual(rows.map(row => row.id), Array.from({ length: 12 }, (_, id) => id));
  for (const row of rows) assert.deepEqual(row.result, {});
});

test('output closure/errors settle pending or idle bundled-host service and remove listeners', t => {
  const { workspace } = fixture(t);
  for (const mode of ['close-blocked', 'error-blocked', 'error-accepted', 'close-idle']) {
    const harness = `
      import assert from 'node:assert/strict'; import {EventEmitter} from 'node:events';
      const input=new EventEmitter(),output=new EventEmitter(),mode=process.argv[2];
      Object.defineProperty(process,'stdin',{value:input}); Object.defineProperty(process,'stdout',{value:output});
      output.write=()=>{setImmediate(()=>output.emit(mode.startsWith('error')?'error':'close',new Error('synthetic closed output')));return mode==='error-accepted';};
      const {serveMcp}=await import(${JSON.stringify(new URL('../dist/mcp.js', import.meta.url).href)});
      const serving=serveMcp(process.argv[1]);
      setImmediate(()=>{if(mode==='close-idle')output.emit('close');else input.emit('data',Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'})+String.fromCharCode(10)));});
      const timer=setTimeout(()=>{process.stderr.write('Service did not settle');process.exit(9);},2000);
      await serving;clearTimeout(timer);
      for(const name of ['data','end','close','error'])assert.equal(input.listenerCount(name),0,name);
      for(const name of ['drain','close','error'])assert.equal(output.listenerCount(name),0,name);
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', harness, workspace, mode], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.equal(child.status, 0, child.stderr);
  }
});

test('closed native stdout ends cleanly instead of crashing on EPIPE', async t => {
  const { workspace } = fixture(t);
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['dist/mcp.js', workspace], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    child.stdout.destroy();
    child.stdin.end(JSON.stringify(initialize()) + '\n');
    const result = await closed;
    assert.equal(result.code, 0, stderr);
    assert.equal(result.signal, null);
    assert.equal(stderr, '');
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
});

test('lost checkpoint response retains the committed revision and an identical retry replays it', t => {
  const { workspace } = fixture(t);
  const save = { context: 'lost-response.md', expectedVersion: null, markdown: 'Committed before disconnect' };
  const messages = [initialize(), ready, request('save', 'tools/call', { name: 'glue_checkpoint', arguments: save }),
    request('not-saved', 'tools/call', { name: 'glue_checkpoint', arguments: { context: 'after-close.md', expectedVersion: null, markdown: 'must not execute' } })];
  const harness = `
    import {EventEmitter} from 'node:events';
    const input=new EventEmitter(),output=new EventEmitter();
    Object.defineProperty(process,'stdin',{value:input});Object.defineProperty(process,'stdout',{value:output});
    output.write=bytes=>{if(JSON.parse(bytes).id==='save'){setImmediate(()=>output.emit('close'));return false;}return true;};
    const {serveMcp}=await import(${JSON.stringify(new URL('../dist/mcp.js', import.meta.url).href)});
    const serving=serveMcp(process.argv[1]);
    setImmediate(()=>input.emit('data',Buffer.from(${JSON.stringify(messages.map(value => JSON.stringify(value)).join('\n') + '\n')})));
    const timer=setTimeout(()=>process.exit(9),2000);await serving;clearTimeout(timer);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', harness, workspace], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  // Reuse the same project through the ordinary native MCP entry point.
  const input = [initialize(), ready, request('retry', 'tools/call', { name: 'glue_checkpoint', arguments: save })].map(JSON.stringify).join('\n') + '\n';
  const replay = spawnSync(process.execPath, ['dist/mcp.js', workspace], { input, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(replay.status, 0, replay.stderr);
  const response = JSON.parse(replay.stdout.trim().split('\n').at(-1));
  assert.equal(JSON.parse(response.result.content[0].text).replayed, true);
  assert.equal(readFileSync(join(workspace, 'lost-response.md'), 'utf8'), save.markdown);
  assert.equal(readdirSync(workspace).includes('after-close.md'), false);
});

test('an oversized request line is refused without ending the connection', t => {
  const { workspace, run } = fixture(t);
  const responses = run([initialize(), ready, JSON.stringify(request('large', 'ping', { pad: 'x'.repeat(3 * 1024 * 1024) })), request('after', 'ping')]);
  assert.deepEqual(responses.map(response => response.id), ['initialize', null, 'after']);
  assert.equal(responses[1].error.code, -32600); assert.match(responses[1].error.message, /2 MiB/);
  assert.deepEqual(responses[2].result, {});
  assert.deepEqual(readdirSync(workspace), []);
});

test('MCP handles tiny input fragments with bounded copying and recovers after a fragmented oversized line', t => {
  const { workspace } = fixture(t);
  const harness = `
    import assert from 'node:assert/strict';
    import { Readable } from 'node:stream';
    const lines = [
      ${JSON.stringify(JSON.stringify(initialize()))},
      ${JSON.stringify(JSON.stringify(ready))},
      JSON.stringify({ jsonrpc: '2.0', id: 'near', method: 'ping', params: { pad: 'x'.repeat(256 * 1024) } }),
      JSON.stringify({ jsonrpc: '2.0', id: 'large', method: 'ping', params: { pad: 'x'.repeat(2 * 1024 * 1024) } }),
      JSON.stringify({ jsonrpc: '2.0', id: 'after', method: 'ping' }),
    ];
    const input = Buffer.from(lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
    function* fragments() {
      for (let offset = 0; offset < input.length; offset += 1024) yield input.subarray(offset, offset + 1024);
    }
    Object.defineProperty(process, 'stdin', { value: Readable.from(fragments()) });
    const originalConcat = Buffer.concat;
    let repeatedCopyBytes = 0;
    Buffer.concat = function(parts, length) {
      if (parts.length === 2 && parts[0].length >= 1024 && parts[1].length <= 1024)
        repeatedCopyBytes += parts[0].length;
      return originalConcat.call(Buffer, parts, length);
    };
    const { serveMcp } = await import(${JSON.stringify(new URL('../dist/mcp.js', import.meta.url).href)});
    await serveMcp(process.argv[1]);
    assert.ok(repeatedCopyBytes < 16 * 1024 * 1024, 'Input framing repeatedly copied prior fragments');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', harness, workspace], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const responses = child.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(responses.map(response => response.id), ['initialize', 'near', null, 'after']);
  assert.deepEqual(responses[1].result, {});
  assert.equal(responses[2].error.code, -32600);
  assert.deepEqual(responses[3].result, {});
  assert.deepEqual(readdirSync(workspace), []);
});
