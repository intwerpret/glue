import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const referenceSchema = z
  .object({ context: z.string().min(1).max(500), version: digest })
  .strict();
export const recordSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    kind: z.enum(['decision', 'finding', 'note', 'artifact']),
    scope: z.string().trim().min(1).max(2000),
    provenance: z.enum(['user', 'assistant', 'source', 'unknown']),
    status: z.enum(['active', 'proposed', 'superseded', 'withdrawn']),
    supersededBy: referenceSchema.optional(),
  })
  .strict()
  .refine(
    r => (r.status === 'superseded') === (r.supersededBy !== undefined),
    'A superseded record requires supersededBy; other statuses must omit it.',
  );
export type Reference = z.infer<typeof referenceSchema>;

export const recordStatuses = ['active', 'proposed', 'superseded', 'withdrawn', 'none'] as const;
export const findInput = z
  .object({
    query: z.string().max(500).default('').describe('Lexical terms; empty lists records.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(10)
      .describe(
        'Records per page. Omit for 10; maximum 20. Pass the returned next as cursor with unchanged options; a larger limit does not resolve skipped evidence bodies.',
      ),
    detail: z
      .enum(['compact', 'concise', 'full'])
      .optional()
      .describe(
        'Default: compact for an empty query, concise matching evidence for search. full returns longer excerpts and source matches; compact omits excerpts. Snippets are navigation, not complete evidence.',
      ),
    includeHistory: z
      .boolean()
      .default(false)
      .describe('Also search committed earlier revisions of each context.'),
    view: z
      .enum(['all', 'open'])
      .default('all')
      .describe(
        'open: records that are active, proposed, or have no record metadata. This filters knowledge standing, not task completion; an active artifact may be finished. Withdrawn and superseded revisions stay readable by explicit context/version. all: every status.',
      ),
    status: z
      .array(z.enum(recordStatuses))
      .min(1)
      .max(5)
      .optional()
      .describe(
        'Explicit record-status filter; "none" matches revisions without record metadata. Overrides view. Keep filters identical across cursor pages.',
      ),
    cursor: z
      .union([
        z.object({ contextId: digest, version: digest, head: digest }).strict(),
        z.object({ afterContextId: digest }).strict(),
      ])
      .optional(),
  })
  .strict();
export const conditionalResumeInput = z
  .object({
    context: z.string().min(1).max(500),
    knownVersion: digest
      .optional()
      .describe(
        'Omit Markdown only if this exact revision is still held by the caller. Omit after context loss or in a fresh session. Live evidence and dependency checks still run.',
      ),
  })
  .strict();
export const readInput = z
  .object({
    context: z.string().min(1).max(500),
    version: digest.optional(),
    source: z.string().min(1).max(1000).optional(),
    capture: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/)
      .optional(),
    offset: z.number().int().min(0).default(0).describe('Byte offset into the exact saved bytes.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(8192)
      .default(4096)
      .describe(
        'Bytes per page. Omit for 4096; maximum 8192. For more bytes, follow nextOffset with the same context, the returned version, and the same source or capture.',
      ),
    representation: z
      .enum(['both', 'text', 'base64'])
      .default('text')
      .describe(
        'Default text omits duplicate base64 for valid UTF-8 pages; binary or split-character pages retain base64. Hashes and byte offsets are unchanged.',
      ),
    allowSensitive: z
      .boolean()
      .default(false)
      .describe(
        'Required true to return the bytes of a capture or evidence snapshot that Glue marks sensitive. Records caller intent only; it is not authentication or proof of permission.',
      ),
  })
  .strict()
  .refine(r => !(r.source && r.capture), 'Select either source or capture, not both.');
