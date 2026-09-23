import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  rmdirSync,
  openSync,
  closeSync,
  fsyncSync,
  fstatSync,
  readSync,
  linkSync,
  unlinkSync,
  realpathSync,
} from 'node:fs';
import { relative, join, dirname, extname } from 'node:path';
import { z } from 'zod';
import { assertUnlinked, withWriteLock, atomicWrite } from './storage.js';
import { recordSchema, referenceSchema, type Reference } from './knowledge-schema.js';
import {
  assertContextPath,
  contextIdentity,
  lexicalPath,
  pathKey,
  portableFile,
  PathCollision,
} from './identity.js';
import {
  captureInput,
  savedCapture,
  prepareCapture,
  importedSchema,
  isSensitive,
} from './captures.js';
import { contextPath, digest, sha256, sourcePath } from './schemas.js';
import {
  MAX_CAPTURES,
  MAX_DEPENDENCIES,
  MAX_EVIDENCE_FILES,
  MAX_FILE_BYTES,
  MAX_HISTORY_REVISIONS,
  MAX_MARKDOWN_BYTES,
  MAX_POINTER_BYTES,
  MAX_REVISION_BYTES,
  MAX_SELECTED_BYTES,
  MAX_WORKING_COPY_BYTES,
} from './limits.js';

/** Kept as the compiled module's hash export. */
export { sha256 as hash };
const headSchema = z.object({ format: z.literal(1), version: digest }).strict();
const resumeInput = z
  .object({
    context: contextPath.describe(
      'Path of the handoff within the project, for example notes/handoff.md.',
    ),
  })
  .strict();
// The full request as it is hashed for retries. `imported` is set only by a transfer import, never
// by a tool caller.
const commitInput = resumeInput
  .extend({
    expectedVersion: digest
      .nullable()
      .describe(
        'Current version from resume. null: create only if this context does not already exist. A stale version is refused and nothing is saved.',
      ),
    markdown: z
      .string()
      .min(1)
      .max(MAX_MARKDOWN_BYTES)
      .describe('Complete new handoff text (UTF-8, up to 32 KiB). Replaces the previous text.'),
    evidence: z
      .array(sourcePath)
      .max(MAX_EVIDENCE_FILES)
      .optional()
      .describe(
        'Project files to keep exact copies of. Omit to keep the current selection; [] clears it.',
      ),
    reviewedEvidence: z
      .array(z.object({ path: sourcePath, hash: digest }).strict())
      .max(MAX_EVIDENCE_FILES)
      .optional()
      .describe(
        'For each selected file resume reported as changed: its path and current hash, confirming you reviewed it.',
      ),
    sensitiveEvidence: z
      .array(z.object({ path: sourcePath, hash: digest }).strict())
      .max(MAX_EVIDENCE_FILES)
      .optional()
      .describe(
        'Path and hash of a selected file the user explicitly allowed despite sensitive-content detection.',
      ),
    captures: z
      .array(captureInput)
      .max(MAX_CAPTURES)
      .optional()
      .describe(
        'Outside material your host fetched, as base64 with a description. Omit to keep current captures; [] clears them. transfer:"allowed" only permits later selection for transfer.',
      ),
    imported: importedSchema.optional(),
    record: recordSchema
      .nullable()
      .optional()
      .describe(
        'Labels that make this handoff findable and reusable: title, kind, scope, provenance, status. Omit to keep; null clears.',
      ),
    dependsOn: z
      .array(referenceSchema)
      .max(MAX_DEPENDENCIES)
      .optional()
      .describe(
        'Other handoffs this one relies on, each as {context, version} at its current version. Omit to keep; [] clears.',
      ),
    workingCopyHash: digest
      .nullable()
      .optional()
      .describe(
        'Hash of the handoff file on disk, from resume, when it was edited outside Glue. null if the file is missing.',
      ),
  })
  .strict();
export const saveInput = commitInput.omit({ imported: true });
const evidenceSchema = z
  .object({
    path: z.string(),
    hash: digest,
    bytes: z.number().int().nonnegative(),
    snapshot: z.string(),
  })
  .strict();
const revisionSchema = z
  .object({
    format: z.literal(1),
    context: z.string(),
    parent: digest.nullable(),
    request: digest,
    at: z.string(),
    markdown: z.string(),
    evidence: z.array(evidenceSchema),
    record: recordSchema.nullable().optional(),
    dependsOn: z.array(referenceSchema).max(MAX_DEPENDENCIES).optional(),
    captures: z.array(savedCapture).max(MAX_CAPTURES).optional(),
    imported: importedSchema.optional(),
    workingCopyBefore: z.string().optional(),
    restoredFrom: digest.optional(),
  })
  .strict();
type Revision = z.infer<typeof revisionSchema>;
// A malformed saved file is damage, not a caller mistake, and its contents are never echoed.
function stored<T>(schema: z.ZodType<T>, bytes: Buffer, name: string): T {
  try {
    return schema.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw Error(
      'Saved Glue data is damaged: ' +
        name +
        ' is not valid. Use explicit recovery; history was not reset.',
    );
  }
}
function read(file: string, max = MAX_FILE_BYTES) {
  assertUnlinked(file);
  const fd = openSync(file, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max)
      throw Error('Expected a regular file within the size limit: ' + file);
    // Read through one descriptor and at most one byte beyond the observed size.
    // A replaced or growing file cannot turn a bounded read into a large allocation.
    const bytes = Buffer.allocUnsafe(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size !== stat.size) throw Error('File changed during read: ' + file);
    return bytes.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}
function immutable(file: string, bytes: Buffer | string) {
  assertUnlinked(file);
  const expected = Buffer.from(bytes);
  const verifyExisting = () => {
    if (!read(file, expected.length).equals(expected))
      throw Error('Immutable bytes differ: ' + file);
  };
  if (existsSync(file)) {
    verifyExisting();
    return;
  }
  // Prepare complete bytes under a private name. Publishing a hard link is
  // atomic and refuses to replace an immutable file another writer created.
  const temporary = file + '.' + randomUUID() + '.tmp';
  assertUnlinked(temporary);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, expected);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      verifyExisting();
    }
  } finally {
    unlinkSync(temporary);
  }
}
export class Handoffs {
  readonly workspace: string;
  constructor(workspace: string) {
    this.workspace = realpathSync(workspace);
  }
  resolvePath(input: string, context = false) {
    const path = lexicalPath(this.workspace, input);
    if (context && extname(path.file).toLowerCase() !== '.md')
      throw Error('Context must name a Markdown file.');
    if (context) assertContextPath(path.rel);
    return path;
  }
  path(input: string, context = false) {
    this.resolvePath(input, context);
    return portableFile(this.workspace, input);
  }
  location(context: string) {
    const path = this.path(context, true),
      root = join(this.workspace, '.glue', 'contexts');
    const spelling = relative(this.workspace, path.file).replaceAll('\\', '/');
    const requested = relative(this.workspace, this.resolvePath(context, true).file).replaceAll(
      '\\',
      '/',
    );
    const known = contextIdentity(
      this,
      root,
      path.rel,
      [spelling, requested],
      sha256,
      directory => {
        const pointer = stored(
          headSchema,
          read(join(directory, 'HEAD.json'), MAX_POINTER_BYTES),
          'HEAD.json',
        );
        return this.revision(directory, pointer.version).context;
      },
    );
    const directory = join(root, sha256(known));
    assertUnlinked(directory);
    return { ...path, rel: known, directory, head: join(directory, 'HEAD.json') };
  }
  revision(directory: string, version: string): Revision {
    digest.parse(version);
    const bytes = read(join(directory, 'revisions', version + '.json'), MAX_REVISION_BYTES);
    if (sha256(bytes) !== version)
      throw Error('Revision integrity failure. Use explicit recovery; history was not reset.');
    return stored(revisionSchema, bytes, 'a revision');
  }
  head(context: string, writeLockHeld = false) {
    const loc = this.location(context);
    if (!existsSync(loc.head)) {
      const initialized = existsSync(join(loc.directory, '.initialized'));
      const lock = join(loc.directory, '.write-lock');
      const busy = !writeLockHeld && existsSync(lock);
      // A first writer may publish HEAD while these observations are being made.
      if (!existsSync(loc.head)) {
        if (busy)
          throw Object.assign(
            new Error(
              'Glue store is busy. Retry the same request; inspect the writer lock only if the writer has stopped.',
            ),
            { code: 'EEXIST', path: lock, retryable: true },
          );
        if (initialized)
          throw Error('Saved HEAD is missing. Use explicit recovery; history was not reset.');
        return { ...loc, version: null, saved: null };
      }
    }
    const parsed = stored(headSchema, read(loc.head), 'HEAD.json');
    const saved = this.revision(loc.directory, parsed.version);
    if (saved.context !== loc.rel) throw Error('Revision belongs to another context.');
    return { ...loc, version: parsed.version, saved };
  }
  working(file: string) {
    if (!existsSync(file)) return { hash: null, text: null };
    const bytes = read(file, MAX_WORKING_COPY_BYTES);
    // Keep a leading BOM so a BOM-prefixed copy counts as diverged and its exact bytes are
    // preserved.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { hash: sha256(bytes), text };
  }
  observeWorking(file: string) {
    try {
      return { available: true as const, ...this.working(file) };
    } catch (error) {
      return {
        available: false as const,
        error: error instanceof Error ? error.message : 'Working copy could not be read.',
      };
    }
  }
  private updateWorkingCopy(file: string, expectedHash: string | null, markdown: string): boolean {
    // Call only after committing HEAD. Failure here must not undo saved history.
    try {
      // Do not knowingly overwrite a native edit. The documented filesystem race limit still
      // applies.
      if (this.working(file).hash !== expectedHash) return false;
      mkdirSync(dirname(file), { recursive: true });
      atomicWrite(file, markdown);
      return true;
    } catch {
      return false;
    }
  }
  verifyEvidence(
    directory: string,
    evidence: Revision['evidence'],
    checked?: Map<string, { hash: string; bytes: number }>,
  ) {
    for (const item of evidence) {
      // Saved integrity depends on the recorded path and snapshot, not the live source.
      const file = this.snapshotFile(directory, item);
      let actual = checked?.get(file);
      if (!actual) {
        const bytes = read(file);
        actual = { hash: sha256(bytes), bytes: bytes.length };
        checked?.set(file, actual);
      }
      if (actual.bytes !== item.bytes || actual.hash !== item.hash)
        throw Error('Evidence snapshot integrity failure: ' + item.path);
    }
  }
  verifyCaptures(directory: string, captures: NonNullable<Revision['captures']>) {
    for (const item of captures) this.captureBytes(directory, item);
  }
  captureBytes(directory: string, item: z.infer<typeof savedCapture>) {
    savedCapture.parse(item);
    const bytes = read(join(directory, 'evidence', item.snapshot));
    if (bytes.length !== item.bytes || sha256(bytes) !== item.hash || item.snapshot !== item.hash)
      throw Error('Capture snapshot integrity failure.');
    return bytes;
  }
  private snapshotFile(directory: string, item: Revision['evidence'][number]) {
    this.resolvePath(item.path);
    if (
      !/^[a-f0-9]{64}(\.[a-z0-9]{1,12})?$/.test(item.snapshot) ||
      !item.snapshot.startsWith(item.hash)
    )
      throw Error(
        'A saved revision has an invalid snapshot path, so the store may be damaged. See the recovery guide.',
      );
    return join(directory, 'evidence', item.snapshot);
  }
  evidenceBytes(directory: string, item: Revision['evidence'][number]) {
    const bytes = read(this.snapshotFile(directory, item));
    if (bytes.length !== item.bytes || sha256(bytes) !== item.hash)
      throw Error('Evidence snapshot integrity failure: ' + item.path);
    return bytes;
  }
  committed(context: string, version?: string) {
    const head = this.head(context);
    if (!head.saved || !head.version) throw Error('No saved context: ' + context);
    const target = version ?? head.version;
    digest.parse(target);
    let current: string | null = head.version;
    const visited = new Set<string>();
    while (current) {
      if (visited.has(current))
        throw Error(
          'Saved history loops back on itself, so the store is damaged. Nothing was changed; see the recovery guide.',
        );
      if (visited.size >= MAX_HISTORY_REVISIONS)
        throw Error(
          'History lookup exceeds 10000 revisions; no committed membership claim was made.',
        );
      visited.add(current);
      const saved = this.revision(head.directory, current);
      if (saved.context !== head.rel) throw Error('History context mismatch.');
      if (current === target)
        return { ...head, saved, version: target, currentVersion: head.version };
      current = saved.parent;
    }
    throw Error("Version is not in this context's committed history.");
  }
  references(context: string, input: Reference[]) {
    const seen = new Set<string>();
    return input.map(ref => {
      const path = this.location(ref.context).rel;
      if (path === context || seen.has(path))
        throw Error('Dependencies must name distinct other contexts.');
      seen.add(path);
      const target = this.head(path);
      if (!target.saved || target.version !== ref.version)
        throw Error(
          'Dependency changed or missing: ' + path + '. Read and reconcile before pinning it.',
        );
      this.verifyEvidence(target.directory, target.saved.evidence);
      this.verifyCaptures(target.directory, target.saved.captures ?? []);
      return { context: path, version: ref.version };
    });
  }
  resume(input: unknown) {
    const { context } = resumeInput.parse(input),
      head = this.head(context);
    if (head.saved) {
      this.verifyEvidence(head.directory, head.saved.evidence);
      this.verifyCaptures(head.directory, head.saved.captures ?? []);
    }
    const working = this.observeWorking(head.file);
    const evidence = (head.saved?.evidence ?? []).map(item => {
      let status = 'missing',
        currentHash: string | null = null,
        reason: 'path_collision' | undefined;
      try {
        const path = this.path(item.path).file;
        currentHash = sha256(read(path));
        status = currentHash === item.hash ? 'unchanged' : 'changed';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') status = 'unavailable';
        if (error instanceof PathCollision) reason = 'path_collision';
      }
      return {
        path: item.path,
        status,
        ...(reason ? { reason } : {}),
        savedHash: item.hash,
        currentHash,
        snapshot: join(head.directory, 'evidence', item.snapshot),
      };
    });
    return {
      context: head.rel,
      version: head.version,
      markdown: head.saved?.markdown ?? null,
      workingCopy: {
        path: head.file,
        ...(working.available
          ? {
              hash: working.hash,
              status:
                working.hash === null
                  ? 'missing'
                  : head.saved && working.text === head.saved.markdown
                    ? 'matches'
                    : 'edited',
            }
          : { status: 'unavailable', error: working.error }),
      },
      evidence,
      history: join(head.directory, 'revisions'),
      captures:
        head.saved?.captures?.map(({ snapshot, ...item }) => ({
          ...item,
          originalFreshness: 'not_checked',
        })) ?? [],
      imported: head.saved?.imported ?? null,
    };
  }
  save(input: unknown, imported?: z.infer<typeof importedSchema>) {
    const callerRequest = saveInput.parse(input);
    const request = commitInput.parse({ ...callerRequest, ...(imported ? { imported } : {}) });
    const loc = this.location(request.context);
    if (Buffer.byteLength(request.markdown) > MAX_MARKDOWN_BYTES)
      throw Error('Keep the handoff within 32 KiB; reference full artifacts.');
    const selected =
      request.evidence === undefined
        ? undefined
        : [...new Set(request.evidence.map(p => this.resolvePath(p).rel))].sort();
    if (selected?.includes(pathKey(loc.rel)))
      throw Error('The handoff is already versioned; do not select it as evidence.');
    const captureIds = request.captures?.map(item => item.id) ?? [];
    if (new Set(captureIds).size !== captureIds.length)
      throw Error('Capture IDs must be distinct.');
    const suppliedCaptures = request.captures?.map(item =>
      prepareCapture(item, new Date().toISOString()),
    );
    const key = sha256(JSON.stringify({ ...request, context: loc.rel, evidence: selected }));
    const created = !existsSync(loc.directory);
    mkdirSync(loc.directory, { recursive: true });
    try {
      const { value, lockNotReleased } = withWriteLock(loc.directory, () =>
        this.commit(request, loc, selected, suppliedCaptures, key),
      );
      return lockNotReleased ? { ...value, lockNotReleased } : value;
    } catch (error) {
      // A rejected first save must not leave an empty identity directory behind. rmdir refuses
      // anything non-empty, so history, evidence bytes and another writer's lock are never removed.
      if (created) {
        try {
          rmdirSync(loc.directory);
        } catch {
          /* preserved */
        }
      }
      throw error;
    }
  }
  /** The committed ancestor of HEAD saved by this exact request, verified, if any. */
  private committedRetry(
    loc: ReturnType<Handoffs['location']>,
    headVersion: string | null,
    key: string,
  ): string | undefined {
    // Only committed ancestors qualify; orphaned pre-commit revisions do not.
    let ancestor = headVersion;
    const visited = new Set<string>();
    while (ancestor) {
      if (visited.has(ancestor))
        throw Error(
          'Saved history loops back on itself, so the store is damaged. Nothing was changed; see the recovery guide.',
        );
      visited.add(ancestor);
      const old = this.revision(loc.directory, ancestor);
      if (old.context !== loc.rel) throw Error('History context mismatch.');
      if (visited.size > MAX_HISTORY_REVISIONS)
        throw Error('Retry lookup exceeds 10000 revisions. Inspect history; no new save was made.');
      if (old.request === key) {
        this.verifyEvidence(loc.directory, old.evidence);
        this.verifyCaptures(loc.directory, old.captures ?? []);
        return ancestor;
      }
      ancestor = old.parent;
    }
    return undefined;
  }
  private commit(
    request: z.infer<typeof commitInput>,
    loc: ReturnType<Handoffs['location']>,
    selected: string[] | undefined,
    suppliedCaptures: ReturnType<typeof prepareCapture>[] | undefined,
    key: string,
  ) {
    // Our own lock must not disguise initialized history with a missing HEAD.
    const head = this.head(request.context, true);
    // A request against HEAD is new work. Older requests may be committed retries.
    if (request.expectedVersion !== head.version) {
      const replayedVersion = this.committedRetry(loc, head.version, key);
      if (replayedVersion === undefined)
        throw Error('Version conflict. Resume and reconcile; nothing was saved.');
      return {
        committed: true,
        version: replayedVersion,
        currentVersion: head.version,
        replayed: true,
        workingCopyUpdated: false,
      };
    }
    const working = this.working(loc.file);
    const diverged = head.saved ? working.text !== head.saved.markdown : working.text !== null;
    if (
      (request.workingCopyHash !== undefined && request.workingCopyHash !== working.hash) ||
      (diverged && request.workingCopyHash === undefined)
    )
      throw Error(
        'Working copy changed. Resume, read the file, and supply its observed workingCopyHash to reconcile explicitly.',
      );
    const paths = selected ?? head.saved?.evidence.map(e => this.resolvePath(e.path).rel) ?? [];
    const dependsOn =
      request.dependsOn === undefined
        ? (head.saved?.dependsOn ?? [])
        : this.references(loc.rel, request.dependsOn);
    const record = request.record === undefined ? (head.saved?.record ?? null) : request.record;
    const captures = suppliedCaptures?.map(c => c.item) ?? head.saved?.captures ?? [];
    if (!suppliedCaptures) this.verifyCaptures(loc.directory, captures);
    if (request.record?.supersededBy) this.references(loc.rel, [request.record.supersededBy]);
    const reviewed = new Map<string, string>();
    for (const item of request.reviewedEvidence ?? []) {
      const path = this.path(item.path).rel;
      if (!paths.includes(path) || reviewed.has(path))
        throw Error('Review must name each selected evidence path at most once: ' + item.path);
      reviewed.set(path, item.hash);
    }
    const previous = new Map(
      head.saved?.evidence.map(item => [pathKey(item.path), item.hash]) ?? [],
    );
    const exceptions = new Map(
      (request.sensitiveEvidence ?? []).map(item => [this.resolvePath(item.path).rel, item.hash]),
    );
    if (
      exceptions.size !== (request.sensitiveEvidence?.length ?? 0) ||
      [...exceptions.keys()].some(path => !paths.includes(path))
    )
      throw Error('Sensitive-source exceptions must name distinct selected evidence paths.');
    let total = captures.reduce((sum, item) => sum + item.bytes, 0);
    const captured = paths.map(path => {
      const file = this.path(path).file,
        bytes = read(file);
      total += bytes.length;
      if (total > MAX_SELECTED_BYTES) throw Error('Selected evidence and captures exceed 64 MiB.');
      const id = sha256(bytes),
        ext = extname(path).toLowerCase();
      if (isSensitive(bytes, path) && exceptions.get(path) !== id)
        throw Error(
          'Selected evidence may contain sensitive material. Review and supply a scoped exact-content exception if authorized.',
        );
      if (reviewed.has(path) && reviewed.get(path) !== id)
        throw Error(
          'Evidence changed since review: ' +
            path +
            '. Resume and review again; nothing was saved.',
        );
      if (previous.has(path) && previous.get(path) !== id && reviewed.get(path) !== id)
        throw Error(
          'Evidence changed: ' +
            path +
            '. Resume, read and reconcile the source, then supply its currentHash in reviewedEvidence; nothing was saved.',
        );
      return {
        bytes,
        item: {
          path,
          hash: id,
          bytes: bytes.length,
          snapshot: id + (/^\.[a-z0-9]{1,12}$/.test(ext) ? ext : ''),
        },
      };
    });
    for (const name of ['revisions', 'evidence']) {
      assertUnlinked(join(loc.directory, name));
      mkdirSync(join(loc.directory, name), { recursive: true });
    }
    for (const capture of captured)
      immutable(join(loc.directory, 'evidence', capture.item.snapshot), capture.bytes);
    for (const capture of suppliedCaptures ?? [])
      immutable(join(loc.directory, 'evidence', capture.item.snapshot), capture.bytes);
    const inheritedImport = head.saved?.imported;
    const imported =
      request.imported ??
      (inheritedImport
        ? {
            ...inheritedImport,
            localModified:
              inheritedImport.localModified ||
              request.markdown !== head.saved?.markdown ||
              request.captures !== undefined ||
              request.evidence !== undefined ||
              request.dependsOn !== undefined ||
              request.record !== undefined,
          }
        : undefined);
    const revision: Revision = {
      format: 1,
      context: loc.rel,
      parent: head.version,
      request: key,
      at: new Date().toISOString(),
      markdown: request.markdown,
      evidence: captured.map(c => c.item),
      record,
      dependsOn,
      ...(captures.length ? { captures } : {}),
      ...(imported ? { imported } : {}),
      ...(diverged && working.text !== null ? { workingCopyBefore: working.text } : {}),
    };
    // All immutable evidence and revision bytes are durable before the single commit pointer.
    const bytes = JSON.stringify(revision),
      version = sha256(bytes);
    immutable(join(loc.directory, 'revisions', version + '.json'), bytes);
    immutable(join(loc.directory, '.initialized'), 'Glue handoff initialized\n');
    atomicWrite(loc.head, JSON.stringify({ format: 1, version }));
    const workingCopyUpdated = this.updateWorkingCopy(loc.file, working.hash, request.markdown);
    return {
      committed: true,
      version,
      replayed: false,
      workingCopyUpdated,
      ...(workingCopyUpdated
        ? {}
        : { next: 'Resume and reconcile the working copy. The saved revision is intact.' }),
    };
  }
  inspect(context: string) {
    const loc = this.location(context);
    const parents = new Map<string, string | null>();
    const checked = new Map<string, { hash: string; bytes: number }>();
    const revisions: Array<{
      version: string;
      valid: boolean;
      at?: string;
      parent?: string | null;
    }> = [];
    const revisionDirectory = join(loc.directory, 'revisions');
    const names = existsSync(revisionDirectory) ? readdirSync(revisionDirectory) : [];
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const version = name.slice(0, -5);
      try {
        const revision = this.revision(loc.directory, version);
        if (revision.context !== loc.rel) throw Error('Context mismatch');
        // A verified revision still establishes ancestry if its evidence snapshot is damaged.
        parents.set(version, revision.parent);
        this.verifyEvidence(loc.directory, revision.evidence, checked);
        this.verifyCaptures(loc.directory, revision.captures ?? []);
        revisions.push({ version, valid: true, at: revision.at, parent: revision.parent });
      } catch {
        revisions.push({ version, valid: false });
      }
    }
    const inventory = new Set(revisions.map(r => r.version)),
      reachable = new Set<string>();
    const missingParents = [...parents].flatMap(([version, parent]) =>
      parent && !inventory.has(parent) ? [{ version, parent }] : [],
    );
    const headBytes = existsSync(loc.head) ? read(loc.head) : null;
    let headVersion: string | null = null,
      status: 'complete' | 'incomplete' | 'unavailable' | 'empty' = 'empty';
    let reason: string | undefined, blockedAt: string | undefined;
    if (headBytes) {
      try {
        headVersion = headSchema.parse(JSON.parse(headBytes.toString('utf8'))).version;
      } catch {
        status = 'unavailable';
        reason = 'invalid_head';
      }
    } else if (revisions.length || existsSync(join(loc.directory, '.initialized'))) {
      status = 'unavailable';
      reason = 'missing_head';
    }
    if (headVersion) {
      status = 'complete';
      let current: string | null = headVersion;
      while (current) {
        if (reachable.has(current) || !parents.has(current)) {
          status = 'incomplete';
          blockedAt = current;
          reason = reachable.has(current)
            ? 'cycle'
            : inventory.has(current)
              ? 'invalid_revision'
              : 'missing_revision';
          if (inventory.has(current)) reachable.add(current);
          break;
        }
        reachable.add(current);
        current = parents.get(current)!;
      }
    }
    const working = this.observeWorking(loc.file);
    return {
      context: loc.rel,
      headHash: headBytes ? sha256(headBytes) : null,
      ...(working.available
        ? { workingCopyHash: working.hash }
        : { workingCopy: { status: 'unavailable', error: working.error } }),
      revisions: revisions.map(r => ({
        ...r,
        reachableFromHead: reachable.has(r.version)
          ? true
          : status === 'complete' || status === 'empty'
            ? false
            : null,
      })),
      ancestry: { headVersion, status, missingParents, ...(reason ? { reason, blockedAt } : {}) },
      note: 'File integrity and ancestry are separate. Unreachable revisions may be prior committed history or uncommitted orphans; neither is automatically disposable. Restore only an explicitly selected verified version.',
    };
  }
  restore(
    context: string,
    version: string,
    expectedHeadHash: string | null,
    workingCopyHash: string | null,
  ) {
    digest.parse(version);
    const loc = this.location(context);
    const { value, lockNotReleased } = withWriteLock(loc.directory, () => {
      const headBytes = existsSync(loc.head) ? read(loc.head) : null;
      const working = this.working(loc.file);
      if (
        (headBytes ? sha256(headBytes) : null) !== expectedHeadHash ||
        working.hash !== workingCopyHash
      )
        throw Error('Recovery inputs changed. Inspect again.');
      const selected = this.revision(loc.directory, version);
      if (selected.context !== loc.rel) throw Error('Context mismatch.');
      this.verifyEvidence(loc.directory, selected.evidence);
      this.verifyCaptures(loc.directory, selected.captures ?? []);
      // Preserve damaged/current pointer and manual text rather than deleting or overwriting
      // history.
      const recovery = JSON.stringify({
        head: headBytes?.toString('base64') ?? null,
        workingCopy: working.text,
        selected: version,
      });
      immutable(join(loc.directory, 'recovery-' + sha256(recovery) + '.json'), recovery);
      immutable(join(loc.directory, '.initialized'), 'Glue handoff initialized\n');
      atomicWrite(loc.head, JSON.stringify({ format: 1, version }));
      const workingCopyUpdated = this.updateWorkingCopy(loc.file, working.hash, selected.markdown);
      return { restored: true, version, workingCopyUpdated, evidenceRestoredToLiveFiles: false };
    });
    return lockNotReleased ? { ...value, lockNotReleased } : value;
  }
}
