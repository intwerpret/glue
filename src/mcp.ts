import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Writable } from 'node:stream';
import { Handoffs, saveInput } from './handoff.js';
import { Knowledge } from './knowledge.js';
import { findInput, readInput, conditionalResumeInput } from './knowledge-schema.js';
import { captureCheckInput } from './captures.js';
import { Transfers, transferInputSchema } from './transfer.js';
import {
  SERVER_INSTRUCTIONS,
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
  WRITING_TOOLS,
  type ToolName,
} from './tools.js';
import { MAX_LINE_BYTES, MAX_QUEUED_INPUT_BYTES, MAX_QUEUED_INPUT_CHUNKS } from './limits.js';

// Only advertise revisions covered by this server's protocol tests.
const supportedVersions = ['2025-11-25'] as const;
const initializeParams = z
  .object({
    protocolVersion: z.string().min(1),
    capabilities: z.record(z.string(), z.unknown()),
    clientInfo: z.object({ name: z.string().min(1), version: z.string().min(1) }).passthrough(),
  })
  .passthrough();
const listParams = z.object({ cursor: z.string().optional() }).passthrough();
const callParams = z
  .object({ name: z.string().min(1), arguments: z.unknown().optional() })
  .passthrough();
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown): value is string | number =>
  typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));

function productVersion() {
  // Installed packages keep their manifest beside the runtime; development uses the root manifest.
  const adjacent = new URL('./package.json', import.meta.url);
  const manifest = existsSync(adjacent) ? adjacent : new URL('../package.json', import.meta.url);
  const value: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
  if (!isObject(value) || typeof value.version !== 'string' || !value.version)
    throw Error('Glue package version is missing. Rebuild or repair the installation.');
  return value.version;
}

// Validation guidance names the field and the expected shape. It never echoes submitted values.
function describeIssues(error: z.ZodError) {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const issue of error.issues) {
    const field = issue.path.length ? issue.path.map(String).join('.') : '(arguments)';
    // Zod issue variants carry different detail fields; read only the one each case names.
    const detail = issue as {
      expected?: string;
      values?: unknown[];
      format?: string;
      origin?: string;
      minimum?: unknown;
      maximum?: unknown;
      keys?: string[];
    };
    let expected: string;
    switch (issue.code) {
      case 'invalid_type': {
        const missing = issue.message.includes('received undefined') ? ' (missing)' : '';
        expected = 'expected ' + detail.expected + missing;
        break;
      }
      case 'invalid_value':
        expected =
          'expected one of: ' + (detail.values ?? []).map(v => JSON.stringify(v)).join(', ');
        break;
      case 'invalid_union':
        expected =
          field === 'action'
            ? 'unknown action'
            : 'no accepted shape matched; check the fields required for this action';
        break;
      case 'invalid_format': {
        const nullable = /^(expectedVersion|workingCopyHash)$/.test(field);
        const nullHint = nullable ? ' or JSON null (not the string "null")' : '';
        expected =
          detail.format === 'regex'
            ? 'expected the documented pattern (a 64-character lowercase hex digest, or the id/token pattern)' +
              nullHint
            : 'expected ' + detail.format;
        break;
      }
      case 'too_small':
        expected =
          'below the minimum ' + (detail.origin ?? 'size') + ' (' + String(detail.minimum) + ')';
        break;
      case 'too_big':
        expected =
          'above the maximum ' + (detail.origin ?? 'size') + ' (' + String(detail.maximum) + ')';
        break;
      // Key names are caller input and are not echoed; the count plus the documented field list is
      // enough to correct the call.
      case 'unrecognized_keys':
        expected =
          (detail.keys ?? []).length +
          ' unrecognized field(s); use only the documented fields for this tool and action';
        break;
      case 'custom':
        expected = issue.message;
        break;
      default:
        expected = issue.code;
    }
    const line = field + ': ' + expected;
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  }
  return lines;
}
function toolError(error: unknown, workspace: string) {
  const text = errorText(error, workspace);
  const leftover =
    error instanceof Error
      ? (error as Error & { lockNotReleased?: string }).lockNotReleased
      : undefined;
  return leftover ? text + ' ' + leftover : text;
}
function errorText(error: unknown, workspace: string) {
  if (error instanceof z.ZodError) {
    return (
      'Invalid Glue arguments. ' +
      describeIssues(error).join('; ') +
      '. Correct the named fields and retry; nothing was saved. Submitted values are not echoed.'
    );
  }
  if (!(error instanceof Error)) return 'Glue request failed';
  const code = (error as NodeJS.ErrnoException).code;
  if (code) {
    if (code === 'EEXIST' && (error as Error & { retryable?: boolean }).retryable)
      return 'Glue store is busy. Retry the same request; inspect the writer lock only if the writer has stopped.';
    const safe =
      /^(ENOENT|EACCES|EPERM|EISDIR|ENOTDIR|ELOOP|EEXIST|ENAMETOOLONG|ENOSPC|EIO|EBUSY|EMFILE|ENFILE|EROFS|EINVAL)$/.test(
        code,
      );
    return (
      'Filesystem operation failed' +
      (safe ? ' (' + code + ')' : '') +
      '. Check the selected project and its permissions.'
    );
  }
  // Core diagnostics may name workspace files. Keep their explanation without the host home path.
  let message = error.message;
  for (const root of new Set([
    workspace,
    workspace.replaceAll('\\', '/'),
    workspace.replaceAll('/', '\\'),
  ]))
    message = message.replaceAll(root, '[project]');
  return message;
}

// Preserve native stream backpressure; bundled hosts may expose only data events.
async function* inputChunks(
  input: NodeJS.ReadableStream,
  aborted: AbortSignal,
): AsyncIterable<Buffer | string> {
  if (aborted.aborted) return;
  const native = input as NodeJS.ReadableStream & { destroy?: () => void };
  if (typeof input[Symbol.asyncIterator] === 'function' && typeof native.destroy === 'function') {
    const stop = () => native.destroy!();
    aborted.addEventListener('abort', stop, { once: true });
    try {
      yield* input;
    } finally {
      aborted.removeEventListener('abort', stop);
    }
    return;
  }
  const chunks: Buffer[] = [];
  let queuedBytes = 0,
    ended = false,
    failure: Error | undefined,
    wake: (() => void) | undefined;
  const signal = () => {
    const resume = wake;
    wake = undefined;
    resume?.();
  };
  const onError = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error('Input failed.');
    chunks.length = 0;
    queuedBytes = 0;
    signal();
  };
  const onData = (chunk: Buffer | string) => {
    if (failure || ended) return;
    const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    if (!size) return;
    if (queuedBytes + size > MAX_QUEUED_INPUT_BYTES || chunks.length >= MAX_QUEUED_INPUT_CHUNKS) {
      onError(new Error('Input queue limit exceeded.'));
      return;
    }
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    queuedBytes += size;
    signal();
  };
  const finish = () => {
    ended = true;
    signal();
  };
  const stop = () => {
    chunks.length = 0;
    queuedBytes = 0;
    finish();
  };
  aborted.addEventListener('abort', stop, { once: true });
  input.on('data', onData);
  input.on('end', finish);
  input.on('close', finish);
  input.on('error', onError);
  try {
    while (true) {
      if (failure) throw failure;
      const chunk = chunks.shift();
      if (chunk) {
        queuedBytes -= chunk.length;
        yield chunk;
        continue;
      }
      if (ended) return;
      await new Promise<void>(resolve => {
        wake = resolve;
      });
    }
  } finally {
    aborted.removeEventListener('abort', stop);
    input.removeListener('data', onData);
    input.removeListener('end', finish);
    input.removeListener('close', finish);
    input.removeListener('error', onError);
    chunks.length = 0;
  }
}

// Bound bytes before a newline arrives; readline would accumulate an unlimited line first.
async function* requests(input: NodeJS.ReadableStream, aborted: AbortSignal) {
  // An oversized line is discarded up to its newline and reported as null, so the connection
  // survives.
  let pending = Buffer.alloc(0),
    pendingBytes = 0,
    oversized = false;
  for await (const chunk of inputChunks(input, aborted)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < bytes.length) {
      if (aborted.aborted) return;
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      const required = pendingBytes + end - start;
      if (oversized || required > MAX_LINE_BYTES) {
        oversized = true;
        pending = Buffer.alloc(0);
        pendingBytes = 0;
      } else if (end > start) {
        if (required > pending.length) {
          // Grow geometrically so small input fragments cannot cause quadratic copying.
          const grown = Buffer.allocUnsafe(
            Math.min(MAX_LINE_BYTES, Math.max(1024, pending.length * 2, required)),
          );
          pending.copy(grown, 0, 0, pendingBytes);
          pending = grown;
        }
        bytes.copy(pending, pendingBytes, start, end);
        pendingBytes = required;
      }
      if (newline < 0) break;
      const line = oversized ? null : pending.subarray(0, pendingBytes);
      pending = Buffer.alloc(0);
      pendingBytes = 0;
      oversized = false;
      start = newline + 1;
      yield line;
    }
  }
  if (aborted.aborted) return;
  if (oversized) yield null;
  else if (pendingBytes) yield pending.subarray(0, pendingBytes);
}

export async function serveMcp(workspace: string) {
  const version = productVersion();
  const store = new Handoffs(workspace);
  const knowledge = new Knowledge(store);
  const transfers = new Transfers(store);
  const handlers: Record<ToolName, { schema: z.ZodType; run: (input: unknown) => unknown }> = {
    glue_resume: {
      schema: conditionalResumeInput,
      run: (input: unknown) => knowledge.resume(input),
    },
    glue_checkpoint: { schema: saveInput, run: (input: unknown) => store.save(input) },
    glue_find: { schema: findInput, run: (input: unknown) => knowledge.find(input) },
    glue_read: { schema: readInput, run: (input: unknown) => knowledge.read(input) },
    glue_check_capture: {
      schema: captureCheckInput,
      run: (input: unknown) => knowledge.checkCapture(input),
    },
    glue_transfer: { schema: transferInputSchema, run: (input: unknown) => transfers.run(input) },
  };
  const tools = TOOL_NAMES.map(name => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    ...handlers[name],
  }));
  const output = process.stdout;
  const abort = new AbortController();
  const disconnected = new Error('MCP output disconnected.');
  let pendingSend: ((error?: Error) => void) | undefined;
  const stop = () => {
    abort.abort();
    pendingSend?.(disconnected);
  };
  output.on('error', stop);
  output.on('close', stop);
  // Only the unmodified Node Writable contract guarantees callbacks. Host shims may ignore them.
  const nativeWrites = output instanceof Writable && output.write === Writable.prototype.write;
  const send = (value: unknown) =>
    new Promise<void>((done, reject) => {
      if (abort.signal.aborted) {
        reject(disconnected);
        return;
      }
      let settled = false;
      const drained = () => finish();
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        output.removeListener('drain', drained);
        pendingSend = undefined;
        if (error) reject(error);
        else done();
      };
      pendingSend = finish;
      try {
        const bytes = JSON.stringify(value) + '\n';
        if (nativeWrites) {
          output.write(bytes, error => {
            if (error) stop();
            else finish();
          });
        } else {
          const accepted = output.write(bytes);
          if (!settled) {
            if (accepted !== false) finish();
            else output.once('drain', drained);
          }
        }
      } catch {
        stop();
      }
    });
  const fail = (id: string | number | null, code: number, message: string) =>
    send({ jsonrpc: '2.0', id, error: { code, message } });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let phase: 'new' | 'initializing' | 'ready' = 'new';
  try {
    for await (const line of requests(process.stdin, abort.signal)) {
      if (abort.signal.aborted) break;
      if (line === null) {
        await fail(
          null,
          -32600,
          'Request exceeds the 2 MiB line limit. Send smaller requests; nothing was saved.',
        );
        continue;
      }
      let req: unknown;
      try {
        req = JSON.parse(decoder.decode(line));
      } catch {
        await fail(null, -32700, 'Invalid UTF-8 JSON request');
        continue;
      }
      if (
        !isObject(req) ||
        req.jsonrpc !== '2.0' ||
        typeof req.method !== 'string' ||
        'result' in req ||
        'error' in req ||
        ('id' in req && !validId(req.id))
      ) {
        await fail(null, -32600, 'Invalid JSON-RPC request');
        continue;
      }
      if (!('id' in req)) {
        // Notifications never produce responses or execute tools. No server-initiated requests
        // exist.
        if (
          req.method === 'notifications/initialized' &&
          phase === 'initializing' &&
          (req.params === undefined || isObject(req.params))
        )
          phase = 'ready';
        continue;
      }
      const id = req.id as string | number;
      if (req.params !== undefined && !isObject(req.params)) {
        await fail(id, -32602, 'Params must be an object');
        continue;
      }
      if (req.method === 'initialize') {
        if (phase !== 'new') {
          await fail(id, -32600, 'Connection is already initialized');
          continue;
        }
        const parsed = initializeParams.safeParse(req.params);
        if (!parsed.success) {
          await fail(
            id,
            -32602,
            'Initialize requires protocolVersion, capabilities and clientInfo name/version',
          );
          continue;
        }
        const requested = parsed.data.protocolVersion;
        const protocolVersion =
          supportedVersions.find(value => value === requested) ?? supportedVersions[0];
        await send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'glue', version },
            instructions: SERVER_INSTRUCTIONS,
          },
        });
        phase = 'initializing';
        continue;
      }
      if (req.method === 'ping') {
        await send({ jsonrpc: '2.0', id, result: {} });
        continue;
      }
      if (req.method !== 'tools/list' && req.method !== 'tools/call') {
        await fail(id, -32601, 'Method not found');
        continue;
      }
      if (phase !== 'ready') {
        await fail(id, -32002, 'Initialize and send notifications/initialized before using tools');
        continue;
      }
      if (req.method === 'tools/list') {
        const parsed = listParams.safeParse(req.params ?? {});
        if (!parsed.success || parsed.data.cursor !== undefined) {
          await fail(id, -32602, 'This tool list has no continuation cursor');
          continue;
        }
        await send({
          jsonrpc: '2.0',
          id,
          result: {
            tools: tools.map(tool => ({
              name: tool.name,
              description: tool.description,
              // Writes add revisions under .glue and replace the context Markdown only when its
              // current text is already saved or kept in the new revision; no network access.
              annotations: {
                readOnlyHint: !WRITING_TOOLS.includes(tool.name),
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
              },
              inputSchema: {
                ...z.toJSONSchema(tool.schema, { target: 'draft-7', io: 'input' }),
                type: 'object',
              },
            })),
          },
        });
        continue;
      }
      const parsed = callParams.safeParse(req.params);
      if (!parsed.success) {
        await fail(id, -32602, 'Tool call requires a name');
        continue;
      }
      const tool = tools.find(candidate => candidate.name === parsed.data.name);
      if (!tool) {
        await fail(id, -32602, 'Unknown Glue tool');
        continue;
      }
      // Tool input and execution failures are visible to the model as tool results, not protocol
      // errors.
      let result: { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
      try {
        result = {
          content: [{ type: 'text', text: JSON.stringify(tool.run(parsed.data.arguments)) }],
        };
      } catch (error) {
        result = {
          isError: true,
          content: [{ type: 'text', text: toolError(error, store.workspace) }],
        };
      }
      await send({ jsonrpc: '2.0', id, result });
    }
  } catch (error) {
    if (!abort.signal.aborted) throw error;
  } finally {
    abort.abort();
    // Allow a native write failure's error event to follow its callback before detaching.
    await new Promise<void>(resolve => setImmediate(resolve));
    output.removeListener('error', stop);
    output.removeListener('close', stop);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || process.argv[3]) throw Error('Usage: mcp.js WORKSPACE');
  // No top-level await, so this module also loads where a host's runtime does not support it.
  serveMcp(process.argv[2]).catch(error => {
    process.exitCode = 1;
    process.stderr.write(
      (error instanceof Error ? error.message : 'Glue could not serve.') + '\n',
      () => process.exit(1),
    );
  });
}
