import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Handoffs, digest } from './handoff.js';
import { readRequest } from './input.js';
import { z } from 'zod';
export function run(args: string[]) {
  const [workspace, file, ...extra] = args;
  if (!workspace || !file || extra.length) throw Error('Usage: recovery.js WORKSPACE REQUEST.json|-');
  const input = readRequest(file === '-' ? 0 : resolve(file)) as Record<string, unknown>, store = new Handoffs(workspace);
  const { action, ...request } = input;
  if (action === 'inspect') { const r = z.object({ context: z.string() }).strict().parse(request); return store.inspect(r.context); }
  if (action === 'restore') { const r = z.object({ context: z.string(), version: digest, expectedHeadHash: digest.nullable(), workingCopyHash: digest.nullable() }).strict().parse(request); return store.restore(r.context, r.version, r.expectedHeadHash, r.workingCopyHash); }
  throw Error('Unknown action. Use inspect or restore.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(run(process.argv.slice(2))) + '\n'); }
  catch (error) { process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n'); process.exitCode = 1; }
}
