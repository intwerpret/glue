import { z } from 'zod';
import {
  captureId,
  contextPath,
  digest,
  recordKind,
  recordProvenance,
  recordStatus,
  recordStatusValues,
  sourcePath,
} from './schemas.js';
import {
  DEFAULT_FIND_RESULTS,
  DEFAULT_READ_BYTES,
  MAX_FIND_RESULTS,
  MAX_QUERY_LENGTH,
  MAX_READ_BYTES,
  MAX_SCOPE_LENGTH,
  MAX_TITLE_LENGTH,
} from './limits.js';

export const referenceSchema = z.object({ context: contextPath, version: digest }).strict();
export const recordSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE_LENGTH).describe('Short name for the record.'),
    kind: recordKind.describe('decision, finding, note or artifact.'),
    scope: z
      .string()
      .trim()
      .min(1)
      .max(MAX_SCOPE_LENGTH)
      .describe('Where and when this record applies.'),
    provenance: recordProvenance.describe(
      'Where it came from: user, assistant, source or unknown.',
    ),
    status: recordStatus.describe('active, proposed, superseded or withdrawn.'),
    supersededBy: referenceSchema
      .optional()
      .describe('Required when status is superseded: the {context, version} that replaces it.'),
  })
  .strict()
  .refine(
    r => (r.status === 'superseded') === (r.supersededBy !== undefined),
    'A superseded record requires supersededBy; other statuses must omit it.',
  );
export type Reference = z.infer<typeof referenceSchema>;

export const recordStatuses = [...recordStatusValues, 'none'] as const;
export const findInput = z
  .object({
    query: z
      .string()
      .max(MAX_QUERY_LENGTH)
      .default('')
      .describe(
        'Words to search for (any word matches, case-insensitive). Empty lists saved work.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_FIND_RESULTS)
      .default(DEFAULT_FIND_RESULTS)
      .describe(
        'Records per page: 10 by default, 20 at most. A larger page does not search skipped evidence.',
      ),
    detail: z
      .enum(['compact', 'concise', 'full'])
      .optional()
      .describe(
        'compact (no excerpts), concise (short excerpts) or full (longer excerpts, more matches). Defaults to compact for listings, concise for searches. Read the exact text before relying on an excerpt.',
      ),
    includeHistory: z
      .boolean()
      .default(false)
      .describe('Also search earlier revisions of each handoff.'),
    view: z
      .enum(['all', 'open'])
      .default('all')
      .describe(
        'all (default), or open to hide superseded and withdrawn records. open does not track whether tasks are finished.',
      ),
    status: z
      .array(z.enum(recordStatuses))
      .min(1)
      .max(5)
      .optional()
      .describe(
        'Filter by record status; "none" matches handoffs without a record. Overrides view.',
      ),
    cursor: z
      .union([
        z.object({ contextId: digest, version: digest, head: digest }).strict(),
        z.object({ afterContextId: digest }).strict(),
      ])
      .optional()
      .describe('The next value from the previous page. Keep the other arguments unchanged.'),
  })
  .strict();
export const conditionalResumeInput = z
  .object({
    context: contextPath.describe(
      'Path of the handoff within the project, for example notes/handoff.md.',
    ),
    knownVersion: digest
      .optional()
      .describe(
        'Version whose Markdown you still hold, to leave it out of the result. Checks still run. Omit in a new session.',
      ),
  })
  .strict();
export const readInput = z
  .object({
    context: contextPath.describe(
      'Path of the handoff within the project, for example notes/handoff.md.',
    ),
    version: digest.optional().describe('Revision to read. Omit for the current version.'),
    source: sourcePath
      .optional()
      .describe('Path of a saved evidence file to read instead of the Markdown.'),
    capture: captureId
      .optional()
      .describe('Id of a saved capture to read instead of the Markdown.'),
    offset: z.number().int().min(0).default(0).describe('Byte offset to start reading from.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_READ_BYTES)
      .default(DEFAULT_READ_BYTES)
      .describe(
        'Bytes per page: 4096 by default, 8192 at most. Continue from nextOffset with the returned version and the same source or capture.',
      ),
    representation: z
      .enum(['both', 'text', 'base64'])
      .default('text')
      .describe(
        'text (default), base64 or both. Pages that are not valid UTF-8 always include base64.',
      ),
    allowSensitive: z
      .boolean()
      .default(false)
      .describe(
        'Return content Glue flagged as sensitive. Use only when the user has authorized reading it.',
      ),
  })
  .strict()
  .refine(r => !(r.source && r.capture), 'Select either source or capture, not both.');
