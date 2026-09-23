import { z } from 'zod';
import {
  captureId,
  contextPath,
  digest,
  recordProvenance,
  sha256,
  sourceStatus,
} from './schemas.js';
import {
  MAX_BASIS_LENGTH,
  MAX_CAPTURE_BASE64_LENGTH,
  MAX_CAPTURE_BYTES,
  MAX_LABEL_LENGTH,
  MAX_SCOPE_LENGTH,
} from './limits.js';

const token = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const originSchema = z.object({ namespace: token, id: token, version: token }).strict();
export const importedSchema = z
  .object({
    origin: originSchema,
    payloadHash: digest,
    omittedSupport: z.number().int().nonnegative(),
    sourceStatus,
    derived: z.boolean(),
    sourceProvenance: recordProvenance.optional(),
    localModified: z.boolean().optional(),
  })
  .strict();
export const captureMetadata = z
  .object({
    id: captureId.describe(
      'Short lowercase id, unique within the handoff (letters, digits, - and _).',
    ),
    label: z
      .string()
      .min(1)
      .max(MAX_LABEL_LENGTH)
      .describe('Readable name. Keep private URLs and account names out.'),
    representation: z
      .enum(['original-bytes', 'extracted-text', 'excerpt', 'derived'])
      .describe('What the bytes are: original-bytes, extracted-text, excerpt or derived.'),
    basis: z
      .string()
      .min(1)
      .max(MAX_BASIS_LENGTH)
      .describe('How the bytes were selected or extracted.'),
    origin: originSchema
      .optional()
      .describe('Optional opaque source identity {namespace, id, version}.'),
    retrievedAt: z
      .string()
      .datetime()
      .optional()
      .describe('When your host retrieved the material (ISO 8601).'),
    originReceivedAt: z
      .string()
      .datetime()
      .optional()
      .describe('Set by transfer imports; leave unset.'),
    scope: z
      .string()
      .min(1)
      .max(MAX_SCOPE_LENGTH)
      .describe('What the material applies to and any limits on its use.'),
    transfer: z
      .enum(['allowed', 'project-only'])
      .default('project-only')
      .describe(
        'project-only (default) or allowed, which makes it selectable for a later transfer.',
      ),
  })
  .strict();
export const captureInput = captureMetadata
  .extend({
    base64: z
      .string()
      .max(MAX_CAPTURE_BASE64_LENGTH)
      .describe('The selected bytes, base64-encoded (up to 1 MiB decoded).'),
    sensitiveAcknowledgement: digest
      .optional()
      .describe(
        'Hash of these exact bytes, when the user allowed saving content flagged as sensitive.',
      ),
  })
  .strict();
export const savedCapture = captureMetadata
  .extend({
    hash: digest,
    bytes: z.number().int().min(0).max(MAX_CAPTURE_BYTES),
    snapshot: digest,
    receivedAt: z.string().datetime(),
    sensitive: z.boolean(),
  })
  .strict();
type Capture = z.infer<typeof savedCapture>;

// Each test is linear in the input. An unanchored address or URL pattern would rescan a long run
// from every offset. A drive letter needs a boundary: without one, the trailing "s:/" in "https://"
// looks like a drive path.
const drivePath = /(?:^|[^a-z0-9])[a-z]:[\\/]/i;
const networkPath = /(?:^|[\s"'(=])(?:\\\\|\/\/)[^\s\\/]+[\\/]/;
const privateUnixPath =
  /(?:^|[\s"'(=])\/(?:home|users|private|tmp|var|etc|root|mnt|volumes)(?:\/|$)/i;
const privateFileUri = /\b(?:file|smb|nfs):\/\//i;
const address = /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
function urlWithQuery(value: string) {
  const scheme = /https?:\/\//gi,
    rest = /[^\s?#]*/y;
  while (scheme.exec(value)) {
    rest.lastIndex = scheme.lastIndex;
    rest.exec(value);
    if (rest.lastIndex < value.length && /[?#]/.test(value[rest.lastIndex]!)) return true;
    // A later scheme inside the scanned run would end at the same character.
    scheme.lastIndex = rest.lastIndex;
  }
  return false;
}
const privateLocator = {
  test: (value: string) =>
    drivePath.test(value) ||
    networkPath.test(value) ||
    privateUnixPath.test(value) ||
    privateFileUri.test(value) ||
    address.test(value) ||
    urlWithQuery(value),
};
const credential =
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-[a-zA-Z0-9_-]{20,}|gh[pousr]_[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16})\b|(?:password|api[_-]?key|access[_-]?token|secret)["']?\s*[:=]\s*["']?[^\s"']{8,}/i;
const secretName = (name: string) =>
  /(?:^|[\\/])(?:\.env(?:\..*)?|\.npmrc|\.pypirc|id_(?:rsa|ed25519)|credentials(?:\.json)?|[^/\\]+\.(?:pem|key|p12|pfx))$/i.test(
    name,
  );

export function assertPortableMetadata(value: unknown) {
  if (typeof value === 'string' && (privateLocator.test(value) || credential.test(value)))
    throw Error(
      'Portable metadata may contain a private locator or credential. Supply a reviewed safe label and opaque origin instead.',
    );
  if (Array.isArray(value)) value.forEach(assertPortableMetadata);
  else if (value !== null && typeof value === 'object')
    Object.entries(value).forEach(([key, item]) => {
      assertPortableMetadata(key);
      assertPortableMetadata(item);
    });
}

export function isSensitive(bytes: Buffer, label = '') {
  return secretName(label) || credential.test(bytes.toString('utf8'));
}

export function prepareCapture(input: z.infer<typeof captureInput>, receivedAt: string) {
  const { base64, sensitiveAcknowledgement, ...metadata } = input;
  assertPortableMetadata(metadata);
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_CAPTURE_BYTES || bytes.toString('base64') !== base64)
    throw Error(
      'Capture requires canonical base64 for at most 1 MiB. Split larger material into explicitly labeled captures.',
    );
  const hash = sha256(bytes),
    sensitive = isSensitive(bytes, metadata.label);
  if (sensitive && sensitiveAcknowledgement !== hash)
    throw Error(
      'Capture may contain sensitive material. Review it and provide an exact-content acknowledgment only for an authorized exception.',
    );
  return {
    bytes,
    item: {
      ...metadata,
      hash,
      bytes: bytes.length,
      snapshot: hash,
      receivedAt,
      sensitive,
    } satisfies Capture,
  };
}

export const captureCheckInput = z
  .object({
    context: contextPath.describe('Path of the handoff that holds the capture.'),
    version: digest
      .optional()
      .describe('Revision holding the capture. Omit for the current version.'),
    capture: captureId.describe('Id of the saved capture.'),
    hash: digest.describe('SHA-256 of the bytes you just re-fetched.'),
    representation: captureMetadata.shape.representation,
    basis: z
      .string()
      .min(1)
      .max(MAX_BASIS_LENGTH)
      .describe(
        'How you selected or extracted the new bytes. A different basis makes the comparison inconclusive.',
      ),
    origin: originSchema
      .optional()
      .describe('Optional current source identity {namespace, id, version}.'),
    retrievedAt: z
      .string()
      .datetime()
      .describe('When your host retrieved the new bytes (ISO 8601).'),
  })
  .strict();
