import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Handoffs, digest } from './handoff.js';
import {
  captureMetadata,
  originSchema,
  contentHash,
  assertPortableMetadata,
  isSensitive,
} from './captures.js';
import { assertUnlinked, atomicWrite, withWriteLock } from './storage.js';

const maximumBundleBytes = 1024 * 1024;
const restrictedScope = (scope: string) =>
  /\bproject[- ]only\b|\bdo not (?:share|transfer|export)\b/i.test(scope);
const portableCapture = captureMetadata
  .extend({ base64: z.string().max(1400000), hash: digest })
  .strict();
const sourceMetadata = z
  .object({
    title: z.string().min(1).max(200),
    scope: z.string().min(1).max(2000),
    kind: z.enum(['decision', 'finding', 'note', 'artifact']),
    provenance: z.enum(['user', 'assistant', 'source', 'unknown']),
    status: z.enum(['active', 'proposed', 'superseded', 'withdrawn', 'unspecified']),
  })
  .strict();
export const transferBundle = z
  .object({
    format: z.literal(1),
    origin: originSchema,
    source: sourceMetadata,
    markdown: z.string().min(1).max(32768),
    markdownHash: digest,
    derived: z.boolean(),
    captures: z.array(portableCapture).max(16),
    omittedSupport: z.number().int().nonnegative(),
  })
  .strict();
type Bundle = z.infer<typeof transferBundle>;
const selection = z
  .object({
    context: z.string().min(1).max(500),
    version: digest,
    captures: z.array(captureMetadata.shape.id).max(16).default([]),
    evidence: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1000),
            id: captureMetadata.shape.id,
            label: captureMetadata.shape.label,
            scope: captureMetadata.shape.scope,
          })
          .strict(),
      )
      .max(16)
      .default([]),
    derivativeMarkdown: z.string().min(1).max(32768).optional(),
  })
  .strict();
export const transferInput = z.discriminatedUnion('action', [
  selection.extend({ action: z.literal('preview') }),
  selection.extend({ action: z.literal('export'), reviewedHash: digest }),
  z.object({ action: z.literal('preview-import'), bundle: transferBundle }).strict(),
  z
    .object({
      action: z.literal('check'),
      context: z.string().min(1).max(500),
      version: digest.optional(),
      upstream: originSchema.nullable(),
    })
    .strict(),
  z
    .object({
      action: z.literal('import'),
      bundle: transferBundle,
      reviewedHash: digest,
      context: z.string().min(1).max(500),
      expectedVersion: digest.nullable(),
      workingCopyHash: digest.nullable().optional(),
    })
    .strict(),
]);
export const transferActions = ['preview', 'export', 'preview-import', 'check', 'import'] as const;
/** Fields each action accepts. Validation stays action-specific; this is for discovery and guidance. */
export const transferFields: Record<
  (typeof transferActions)[number],
  { required: string[]; optional: string[] }
> = {
  preview: {
    required: ['context', 'version'],
    optional: ['captures', 'evidence', 'derivativeMarkdown'],
  },
  export: {
    required: ['context', 'version', 'reviewedHash'],
    optional: ['captures', 'evidence', 'derivativeMarkdown'],
  },
  'preview-import': { required: ['bundle'], optional: [] },
  import: {
    required: ['bundle', 'reviewedHash', 'context', 'expectedVersion'],
    optional: ['workingCopyHash'],
  },
  check: { required: ['context', 'upstream'], optional: ['version'] },
};
// Advertised to hosts as one flat object: a discriminated union serializes without top-level properties,
// which some hosts render as an empty schema. Every field is documented here; strict per-action parsing still applies.
export const transferInputSchema = z
  .object({
    action: z
      .enum(transferActions)
      .describe(
        'Sequence: preview (or preview-import) -> review the manifest and read the exact selected content -> export/import with the returned payloadHash as reviewedHash. check compares a caller-supplied upstream origin with an imported record.',
      ),
    context: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe(
        'preview/export/check: the saved source context path (Markdown file). import: the destination context path to create or update.',
      ),
    version: digest
      .optional()
      .describe(
        'preview/export: the current saved head version of the source (required; export refuses a stale version). check: optional committed version of the imported record.',
      ),
    captures: z
      .array(captureMetadata.shape.id)
      .max(16)
      .optional()
      .describe(
        'preview/export: capture ids to include. Only captures saved with transfer:"allowed" and not marked sensitive can be selected; transfer:"allowed" permits selection, it does not include a capture automatically. Omitted captures count in omittedSupport.',
      ),
    evidence: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1000),
            id: captureMetadata.shape.id,
            label: captureMetadata.shape.label,
            scope: captureMetadata.shape.scope,
          })
          .strict(),
      )
      .max(16)
      .optional()
      .describe(
        'preview/export: selected evidence snapshots to carry as captures, each with a new portable id, label and scope (private paths are not exported).',
      ),
    derivativeMarkdown: z
      .string()
      .min(1)
      .max(32768)
      .optional()
      .describe(
        'preview/export: reviewed replacement text when the saved Markdown embeds material that must not leave the project; marks the bundle derived.',
      ),
    reviewedHash: digest
      .optional()
      .describe(
        'export/import: the payloadHash returned by the matching preview/preview-import of this exact selection or bundle.',
      ),
    bundle: transferBundle
      .optional()
      .describe(
        'preview-import/import: the bundle object exactly as export returned it (an object, not a JSON string).',
      ),
    expectedVersion: digest
      .nullable()
      .optional()
      .describe(
        "import: null to create only if the destination context does not already exist; otherwise the destination's current saved version.",
      ),
    workingCopyHash: digest
      .nullable()
      .optional()
      .describe(
        'import: observed working-copy hash from resume when reconciling a diverged destination file.',
      ),
    upstream: originSchema
      .nullable()
      .optional()
      .describe(
        'check: the origin {namespace,id,version} re-obtained from the upstream project, or null when unavailable.',
      ),
  })
  .strict();

// Namespace identifies this selected local store, not a machine, account or path.
function projectNamespace(store: Handoffs) {
  const directory = join(store.workspace, '.glue'),
    file = join(directory, 'PROJECT.json');
  assertUnlinked(directory);
  mkdirSync(directory, { recursive: true });
  const read = () => {
    assertUnlinked(file);
    if (!statSync(file).isFile() || statSync(file).size > 4096)
      throw Error('Invalid project namespace metadata.');
    try {
      return z
        .object({ format: z.literal(1), namespace: z.string().uuid() })
        .strict()
        .parse(JSON.parse(readFileSync(file, 'utf8'))).namespace;
    } catch {
      throw Error(
        'Invalid project namespace metadata. Preserve it and inspect before transferring.',
      );
    }
  };
  // PROJECT.json appears atomically and is never rewritten, so only its creation needs the lock.
  // A lock left over from that one creation then blocks nothing.
  if (existsSync(file)) return read();
  return withWriteLock(directory, () => {
    if (!existsSync(file))
      atomicWrite(file, JSON.stringify({ format: 1, namespace: randomUUID() }));
    return read();
  }).value;
}

function validateBundle(input: unknown): Bundle {
  // Bound serialized input before decoding captures or inspecting content.
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > maximumBundleBytes)
    throw Error('Transfer bundle exceeds 1 MiB. Select less material.');
  const bundle = transferBundle.parse(input);
  if (
    Buffer.byteLength(bundle.markdown, 'utf8') > 32768 ||
    contentHash(bundle.markdown) !== bundle.markdownHash
  )
    throw Error('Transfer Markdown integrity or size check failed.');
  assertPortableMetadata(bundle.source);
  assertPortableMetadata(bundle.origin);
  assertPortableMetadata(bundle.markdown);
  if (isSensitive(Buffer.from(bundle.markdown)))
    throw Error(
      'Selected transfer text may contain sensitive material. Supply an explicitly reviewed derivative.',
    );
  if (restrictedScope(bundle.source.scope))
    throw Error('Source scope restricts transfer. Resolve that restriction before sharing.');
  const ids = new Set<string>();
  for (const capture of bundle.captures) {
    const { base64, hash, ...metadata } = capture;
    if (ids.has(capture.id)) throw Error('Transfer capture identifiers must be distinct.');
    ids.add(capture.id);
    assertPortableMetadata(metadata);
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.toString('base64') !== base64 || contentHash(bytes) !== hash)
      throw Error('Transfer capture integrity check failed.');
    if (
      capture.transfer !== 'allowed' ||
      restrictedScope(capture.scope) ||
      isSensitive(bytes, capture.label)
    )
      throw Error('A selected capture is private or sensitive and cannot be transferred.');
    // Scan payload as well as labels: safe metadata cannot sanitize quoted content.
    assertPortableMetadata(bytes.toString('utf8'));
  }
  return bundle;
}

function payloadHash(bundle: Bundle) {
  return contentHash(JSON.stringify(bundle));
}
function preview(bundle: Bundle) {
  return {
    payloadHash: payloadHash(bundle),
    reviewRequired: true,
    manifest: {
      origin: bundle.origin,
      source: bundle.source,
      markdownHash: bundle.markdownHash,
      derived: bundle.derived,
      captures: bundle.captures.map(({ id, label, hash, base64, representation, scope }) => ({
        id,
        label,
        hash,
        bytes: Buffer.from(base64, 'base64').length,
        representation,
        scope,
      })),
      omittedSupport: bundle.omittedSupport,
    },
    limits:
      'Review the selected source text and every selected capture before export. Heuristic checks cannot certify privacy. Copies are independent and not revocable upstream.',
  };
}

export class Transfers {
  constructor(private readonly store: Handoffs) {}
  private selected(input: z.infer<typeof selection>): Bundle {
    const head = this.store.head(input.context);
    if (!head.saved || head.version !== input.version)
      throw Error(
        'Transfer requires the current saved source version. Resume and review the source.',
      );
    const saved = head.saved;
    if (
      new Set(input.captures).size !== input.captures.length ||
      new Set(input.evidence.map(item => this.store.resolvePath(item.path).rel)).size !==
        input.evidence.length
    )
      throw Error('Select each source only once.');
    const captures: Bundle['captures'] = [];
    let selectedBytes = 0;
    const reserve = (bytes: number) => {
      selectedBytes += bytes;
      if (selectedBytes > maximumBundleBytes)
        throw Error('Transfer bundle exceeds 1 MiB. Select less material.');
    };
    for (const id of input.captures) {
      const item = saved.captures?.find(capture => capture.id === id);
      if (!item) throw Error('A selected capture is unavailable.');
      if (item.transfer !== 'allowed' || item.sensitive)
        throw Error('A selected capture is private or sensitive and cannot be transferred.');
      reserve(item.bytes);
      const bytes = this.store.captureBytes(head.directory, item);
      const { snapshot, receivedAt, sensitive, bytes: byteCount, hash, ...metadata } = item;
      captures.push({
        ...metadata,
        originReceivedAt: metadata.originReceivedAt ?? receivedAt,
        hash,
        base64: bytes.toString('base64'),
      });
    }
    for (const selected of input.evidence) {
      const key = this.store.resolvePath(selected.path).rel;
      const item = saved.evidence.find(
        evidence => this.store.resolvePath(evidence.path).rel === key,
      );
      if (!item) throw Error('A selected evidence snapshot is unavailable.');
      reserve(item.bytes);
      const bytes = this.store.evidenceBytes(head.directory, item);
      if (isSensitive(bytes, item.path))
        throw Error('A selected evidence snapshot may be sensitive and cannot be transferred.');
      captures.push({
        id: selected.id,
        label: selected.label,
        scope: selected.scope,
        representation: 'original-bytes',
        basis: 'Selected immutable evidence snapshot',
        transfer: 'allowed',
        hash: contentHash(bytes),
        base64: bytes.toString('base64'),
      });
    }
    const markdown = input.derivativeMarkdown ?? saved.markdown;
    const bundle: Bundle = {
      format: 1,
      origin: {
        namespace: projectNamespace(this.store),
        id: contentHash(head.rel),
        version: input.version,
      },
      source: {
        title: saved.record?.title ?? 'Selected record',
        scope: saved.record?.scope ?? 'Unspecified source scope',
        kind: saved.record?.kind ?? 'note',
        provenance: saved.record?.provenance ?? 'unknown',
        status: saved.record?.status ?? 'unspecified',
      },
      markdown,
      markdownHash: contentHash(markdown),
      derived: input.derivativeMarkdown !== undefined,
      captures,
      omittedSupport:
        (saved.imported?.omittedSupport ?? 0) +
        (saved.dependsOn?.length ?? 0) +
        (saved.record?.supersededBy ? 1 : 0) +
        saved.evidence.length -
        input.evidence.length +
        (saved.captures?.length ?? 0) -
        input.captures.length,
    };
    const canonical = validateBundle(bundle);
    if (this.store.head(input.context).version !== input.version)
      throw Error('Source changed during transfer preparation. Resume and review again.');
    return canonical;
  }
  run(value: unknown) {
    const action =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>).action
        : undefined;
    if (typeof action !== 'string' || !(transferActions as readonly string[]).includes(action))
      throw Error(
        'Transfer requires action, one of: ' +
          transferActions.join(', ') +
          '. Fields by action: ' +
          transferActions
            .map(
              name =>
                name +
                ' requires ' +
                transferFields[name].required.join(', ') +
                (transferFields[name].optional.length
                  ? ' (optional: ' + transferFields[name].optional.join(', ') + ')'
                  : ''),
            )
            .join('; ') +
          '.',
      );
    const input = transferInput.parse(value);
    if (input.action === 'check') {
      const saved = this.store.committed(input.context, input.version),
        origin = saved.saved.imported?.origin;
      if (!origin) throw Error('The selected record has no imported origin to compare.');
      const status =
        input.upstream === null
          ? 'unavailable'
          : input.upstream.namespace !== origin.namespace || input.upstream.id !== origin.id
            ? 'different_source'
            : input.upstream.version === origin.version
              ? 'unchanged'
              : 'changed';
      return {
        status,
        checkedAt: new Date().toISOString(),
        evidence: 'host_asserted_only',
        changedStoredContent: false,
        limits:
          'Compared host-supplied origin identity and version only. Glue did not contact or authenticate the upstream source.',
      };
    }
    if (input.action === 'preview' || input.action === 'export') {
      const bundle = this.selected(input),
        receipt = preview(bundle);
      if (input.action === 'preview') return receipt;
      if (input.reviewedHash !== receipt.payloadHash)
        throw Error(
          'Transfer payload changed or was not reviewed. Preview and review the exact selection.',
        );
      return { bundle, payloadHash: receipt.payloadHash, independentCopy: true };
    }
    const bundle = validateBundle(input.bundle),
      receipt = preview(bundle);
    if (input.action === 'preview-import') return receipt;
    if (input.reviewedHash !== receipt.payloadHash)
      throw Error('Import payload was not reviewed at its exact hash.');
    const { source } = bundle;
    const result = this.store.save(
      {
        context: input.context,
        expectedVersion: input.expectedVersion,
        markdown: bundle.markdown,
        ...(input.workingCopyHash === undefined ? {} : { workingCopyHash: input.workingCopyHash }),
        evidence: [],
        dependsOn: [],
        captures: bundle.captures.map(({ hash, ...capture }) => capture),
        record: {
          title: source.title,
          scope: source.scope,
          kind: source.kind,
          provenance: 'source',
          status: 'proposed',
        },
      },
      {
        origin: bundle.origin,
        payloadHash: receipt.payloadHash,
        omittedSupport: bundle.omittedSupport,
        sourceStatus: source.status,
        sourceProvenance: source.provenance,
        localModified: false,
        derived: bundle.derived,
      },
    );
    return {
      ...result,
      origin: bundle.origin,
      independentCopy: true,
      upstreamStatus: 'not-checked',
    };
  }
}
