import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Handoffs, digest, hash } from './handoff.js';
import {
  findInput,
  readInput,
  conditionalResumeInput,
  recordStatuses,
  type Reference,
} from './knowledge-schema.js';
import { assertUnlinked } from './storage.js';
import { captureCheckInput, isSensitive } from './captures.js';
import { pathKey, PathCollision } from './identity.js';

type Saved = ReturnType<Handoffs['committed']>;
const byteBudget = 64 * 1024 * 1024;
const excerpt = (text: string, terms: string[], limit = 480) => {
  const lower = text.toLowerCase(),
    positions = terms.map(term => lower.indexOf(term)).filter(n => n >= 0);
  const start = Math.max(
    0,
    (positions.length ? Math.min(...positions) : 0) - Math.min(100, Math.floor(limit / 4)),
  );
  return {
    text: text.slice(start, start + limit),
    characterOffset: start,
    truncated: start > 0 || text.length > start + limit,
  };
};

/** Read-only views over committed handoff history. No competing durable index. */
export class Knowledge {
  constructor(readonly store: Handoffs) {}

  assess(context: string, version?: string) {
    const root = this.store.committed(context, version);
    const queue: Array<Reference & { via: string[] }> = [
      { context: root.rel, version: root.version, via: [] },
    ];
    const seen = new Set<string>();
    const issues: Array<{
      context: string;
      version: string;
      via: string[];
      reason: string;
      source?: string;
    }> = [];
    let bytes = 0,
      complete = true;
    while (queue.length) {
      const ref = queue.shift()!,
        key = ref.context + ':' + ref.version;
      if (seen.has(key)) continue;
      if (seen.size >= 64 || issues.length >= 64) {
        complete = false;
        break;
      }
      seen.add(key);
      const issue = (reason: string, source?: string) => {
        if (issues.length < 64) issues.push({ ...ref, reason, ...(source ? { source } : {}) });
        else complete = false;
      };
      let node: Saved;
      try {
        node = this.store.committed(ref.context, ref.version);
      } catch {
        complete = false;
        issue('saved_dependency_unavailable');
        continue;
      }
      if (node.currentVersion !== ref.version) issue('saved_revision_changed');
      if (node.saved.record && node.saved.record.status !== 'active')
        issue('record_' + node.saved.record.status);
      if ((node.saved.imported?.omittedSupport ?? 0) > 0) {
        complete = false;
        issue('imported_support_omitted');
      }
      // Compare manual edits against the current projection, not an old pinned version.
      try {
        const latest = this.store.head(ref.context),
          working = this.store.working(latest.file);
        if (working.text !== latest.saved?.markdown) issue('working_copy_changed_or_missing');
      } catch {
        complete = false;
        issue('working_copy_unavailable');
      }
      for (const item of node.saved.evidence) {
        if (bytes + item.bytes * 2 > byteBudget) {
          complete = false;
          issue('evidence_check_budget', item.path);
          break;
        }
        bytes += item.bytes;
        try {
          this.store.evidenceBytes(node.directory, item);
        } catch {
          complete = false;
          issue('snapshot_unavailable', item.path);
          continue;
        }
        try {
          const file = this.store.path(item.path).file,
            stat = statSync(file);
          if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || bytes + stat.size > byteBudget) {
            complete = false;
            issue('live_source_not_checked', item.path);
            continue;
          }
          const body = readFileSync(file);
          bytes += body.length;
          if (body.length > 16 * 1024 * 1024 || bytes > byteBudget) {
            complete = false;
            issue('live_source_not_checked', item.path);
          } else if (hash(body) !== item.hash) issue('source_changed', item.path);
        } catch (error) {
          complete = false;
          issue(
            error instanceof PathCollision
              ? 'live_source_path_collision'
              : 'live_source_unavailable',
            item.path,
          );
        }
      }
      for (const dependency of node.saved.dependsOn ?? []) {
        queue.push({ ...dependency, via: [...ref.via, node.rel] });
      }
      for (const capture of node.saved.captures ?? []) {
        if (bytes + capture.bytes > byteBudget) {
          complete = false;
          issue('capture_check_budget');
          break;
        }
        bytes += capture.bytes;
        try {
          this.store.captureBytes(node.directory, capture);
        } catch {
          complete = false;
          issue('capture_snapshot_unavailable');
        }
      }
    }
    return {
      context: root.rel,
      version: root.version,
      checkedRecords: seen.size,
      complete,
      issues,
      status: !complete ? 'incomplete' : issues.length ? 'review_needed' : 'unchanged',
      meaning:
        'Checks declared saved dependencies and selected files/snapshots, not external originals, truth, approval or unknown dependencies. Observations are not an atomic cross-context snapshot.',
    };
  }

  resume(input: unknown) {
    const request = conditionalResumeInput.parse(input);
    const view = this.store.resume({ context: request.context });
    const { markdown, ...metadata } = view;
    const body =
      request.knownVersion !== undefined && request.knownVersion === view.version
        ? { ...metadata, markdownOmitted: 'known_version' as const }
        : view;
    const workingCopy = {
      ...view.workingCopy,
      path: view.context,
      ...('error' in view.workingCopy
        ? { error: 'Working copy unavailable; inspect locally.' }
        : {}),
    };
    if (!view.version)
      return { ...view, workingCopy, history: undefined, record: null, dependsOn: [], basis: null };
    const head = this.store.committed(view.context, view.version);
    // Native storage diagnostics may use absolute paths; model-facing views do not need them.
    return {
      ...body,
      workingCopy,
      ...(view.imported ? { upstreamStatus: 'not-checked' as const } : {}),
      evidence: view.evidence.map(({ snapshot, ...item }) => item),
      history: undefined,
      record: head.saved.record ?? null,
      dependsOn: head.saved.dependsOn ?? [],
      basis: this.assess(view.context, view.version),
    };
  }

  read(input: unknown) {
    const request = readInput.parse(input),
      node = this.store.committed(request.context, request.version);
    let body: Buffer,
      contentHash: string,
      sensitive = false;
    const refuse = () => {
      throw Error(
        'Selected content is marked sensitive. Its bytes are withheld unless allowSensitive:true is supplied; that records caller intent, not authorization. Metadata and hashes remain available through resume.',
      );
    };
    if (request.capture !== undefined) {
      const capture = node.saved.captures?.find(c => c.id === request.capture);
      if (!capture) throw Error('Capture was not selected in this saved revision.');
      sensitive = capture.sensitive;
      if (sensitive && !request.allowSensitive) refuse();
      body = this.store.captureBytes(node.directory, capture);
      contentHash = capture.hash;
      // A newer detector may recognize a secret in a capture saved by an older version.
      sensitive ||= isSensitive(body, capture.label);
      if (sensitive && !request.allowSensitive) refuse();
    } else if (request.source !== undefined) {
      const path = this.store.resolvePath(request.source).rel;
      const item = node.saved.evidence.find(item => pathKey(item.path) === pathKey(path));
      if (!item) throw Error('Source was not selected in this saved revision.');
      body = this.store.evidenceBytes(node.directory, item);
      contentHash = item.hash;
      // Evidence snapshots carry no stored flag; the same heuristic that gates capture is applied at retrieval.
      sensitive = isSensitive(body, item.path);
      if (sensitive && !request.allowSensitive) refuse();
    } else {
      body = Buffer.from(node.saved.markdown, 'utf8');
      contentHash = hash(body);
    }
    if (request.offset > body.length) throw Error('Offset exceeds saved content length.');
    const part = body.subarray(request.offset, request.offset + request.limit);
    let text: string | undefined, textOmitted: string | undefined;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(part);
    } catch {
      // Base64 preserves split characters and binary bytes; explain which case applies.
      let wholeIsText = false;
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(body);
        wholeIsText = true;
      } catch {
        /* binary or invalid */
      }
      textOmitted = wholeIsText
        ? 'This byte page starts or ends inside a multi-byte UTF-8 character; the full content is valid UTF-8. Decode base64 or adjust offset/limit to a character boundary.'
        : 'These bytes are not independently valid UTF-8 (binary or invalid encoding); base64 is exact.';
    }
    return {
      context: node.rel,
      version: node.version,
      currentVersion: node.currentVersion,
      parent: node.saved.parent,
      record: node.saved.record ?? null,
      dependsOn: node.saved.dependsOn ?? [],
      evidence: node.saved.evidence.map(({ path, hash, bytes }) => ({ path, hash, bytes })),
      captures:
        node.saved.captures?.map(({ snapshot, ...item }) => ({
          ...item,
          ...(item.id === request.capture ? { sensitive } : {}),
          originalFreshness: 'not_checked',
        })) ?? [],
      imported: node.saved.imported ?? null,
      capture: request.capture ?? null,
      source: request.source ?? null,
      hash: contentHash,
      bytes: body.length,
      offset: request.offset,
      ...(request.representation !== 'text' || text === undefined
        ? { base64: part.toString('base64') }
        : {}),
      ...(request.representation === 'base64'
        ? {}
        : text === undefined
          ? { textOmitted }
          : { text }),
      sensitive,
      nextOffset: request.offset + part.length < body.length ? request.offset + part.length : null,
      freshness: 'not_checked',
      note: 'Exact saved bytes. Use resume to assess live sources and declared dependencies.',
    };
  }

  checkCapture(input: unknown) {
    const request = captureCheckInput.parse(input),
      node = this.store.committed(request.context, request.version);
    const capture = node.saved.captures?.find(c => c.id === request.capture);
    if (!capture) throw Error('Capture was not selected in this saved revision.');
    this.store.captureBytes(node.directory, capture);
    const sameDeclaredSource =
      capture.origin?.namespace === request.origin?.namespace &&
      capture.origin?.id === request.origin?.id;
    const comparable =
      capture.representation === request.representation &&
      capture.basis === request.basis &&
      sameDeclaredSource;
    const originVersionChanged =
      capture.origin && request.origin ? capture.origin.version !== request.origin.version : null;
    return {
      context: node.rel,
      version: node.version,
      capture: capture.id,
      comparison: !comparable
        ? 'basis_changed'
        : capture.hash === request.hash
          ? 'same_supplied_bytes'
          : 'supplied_bytes_changed',
      originVersionChanged,
      declaredSourceIdentity:
        capture.origin && request.origin
          ? sameDeclaredSource
            ? 'same'
            : 'different'
          : 'not_established',
      receivedAt: new Date().toISOString(),
      hostDeclaredRetrievedAt: request.retrievedAt,
      changedStoredContent: false,
      originalFreshness: 'host_asserted_only',
      note: 'Compares a host-supplied digest on a declared representation; Glue did not fetch or authenticate the original. Adoption is a separate checkpoint.',
    };
  }

  find(input: unknown) {
    const request = findInput.parse(input);
    const directory = join(this.store.workspace, '.glue', 'contexts');
    assertUnlinked(directory);
    const ids = existsSync(directory)
      ? readdirSync(directory)
          .filter(id => /^[a-f0-9]{64}$/.test(id))
          .sort()
      : [];
    const revisionCursor =
      request.cursor && 'contextId' in request.cursor ? request.cursor : undefined;
    const directoryCursor =
      request.cursor && 'afterContextId' in request.cursor ? request.cursor : undefined;
    if (revisionCursor && !ids.includes(revisionCursor.contextId))
      throw Error('Search cursor context disappeared. Restart the search.');
    const terms = [...new Set(request.query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
    const detail = request.detail ?? (terms.length ? 'concise' : 'compact');
    const matches = (text: string) =>
      !terms.length || terms.some(term => text.toLowerCase().includes(term));
    const statuses = new Set<string>(
      request.status ??
        (request.view === 'open' ? ['active', 'proposed', 'none'] : [...recordStatuses]),
    );
    const statusAllowed = (record: Saved['saved']['record']) =>
      statuses.has(record?.status ?? 'none');
    const results: Array<Record<string, unknown>> = [],
      gaps: Array<{ contextId: string; context?: string; reason: string; note?: string }> = [];
    let scanned = 0,
      searchedEvidenceBytes = 0,
      skippedEvidence = 0,
      skippedSensitive = 0;
    let next: typeof request.cursor;
    const afterIndex = directoryCursor
      ? ids.findIndex(id => id > directoryCursor.afterContextId)
      : 0;
    const start = revisionCursor
      ? ids.indexOf(revisionCursor.contextId)
      : afterIndex < 0
        ? ids.length
        : afterIndex;
    outer: for (let index = start; index < ids.length; index++) {
      // Continue by directory order even when no valid revision can be loaded.
      if (gaps.length >= 64) {
        next = { afterContextId: ids[index - 1]! };
        break;
      }
      const id = ids[index]!;
      let head: Saved;
      // A hash-verified revision names its context; that path is reported only when verified.
      let verifiedContext: string | undefined;
      try {
        const dir = join(directory, id),
          pointer = join(dir, 'HEAD.json');
        assertUnlinked(pointer);
        if (!existsSync(pointer)) {
          const entries = readdirSync(dir);
          // Let a newly published pointer take the normal integrity-validation path.
          if (!existsSync(pointer)) {
            if (entries.includes('.write-lock')) {
              gaps.push({
                contextId: id,
                reason: 'busy',
                note: 'A writer lock is present without a saved HEAD. Retry; inspect the lock only after confirming no writer is active.',
              });
              continue;
            }
            if (entries.length === 0) {
              gaps.push({
                contextId: id,
                reason: 'empty_directory',
                note: 'No saved bytes: remnant of a failed first save. Nothing is lost; it may be removed by explicit maintenance.',
              });
              continue;
            }
            if (!entries.includes('.initialized') && !entries.includes('revisions')) {
              gaps.push({
                contextId: id,
                reason: 'uninitialized',
                note: 'No committed revision and no history marker.',
              });
              continue;
            }
            gaps.push({
              contextId: id,
              reason: 'missing_head',
              note: 'History exists but the saved HEAD pointer is missing. Use explicit recovery; nothing was reset.',
            });
            continue;
          }
        }
        if (statSync(pointer).size > 4096) throw Error('Oversize head');
        const version = digest.parse(JSON.parse(readFileSync(pointer, 'utf8')).version);
        const saved = this.store.revision(dir, version);
        verifiedContext = saved.context;
        if (this.store.location(saved.context).directory !== dir) throw Error('Context mismatch');
        head = this.store.committed(saved.context);
      } catch {
        gaps.push({
          contextId: id,
          ...(verifiedContext ? { context: verifiedContext } : {}),
          reason: 'context_unavailable',
          note: verifiedContext
            ? 'A verified revision names this context but its committed history could not be loaded. Use explicit recovery.'
            : 'No hash-verified revision is readable, so only the opaque directory identifier is available.',
        });
        continue;
      }
      let current: string | null = head.version;
      if (revisionCursor && revisionCursor.contextId === id) {
        if (revisionCursor.head !== head.version)
          throw Error('Search cursor head changed. Restart the search.');
        this.store.committed(head.rel, revisionCursor.version);
        if (!request.includeHistory && revisionCursor.version !== head.version)
          throw Error('Historical cursor requires includeHistory.');
        current = revisionCursor.version;
      }
      const visited = new Set<string>();
      while (current) {
        if (scanned >= 64 || results.length >= request.limit) {
          next = { contextId: id, version: current, head: head.version };
          break outer;
        }
        if (visited.has(current)) {
          gaps.push({ contextId: id, reason: 'history_cycle' });
          break;
        }
        visited.add(current);
        scanned++;
        let saved: Saved['saved'];
        try {
          saved = this.store.revision(head.directory, current);
          if (saved.context !== head.rel) throw Error('Context mismatch');
        } catch {
          gaps.push({ contextId: id, reason: 'revision_unavailable' });
          break;
        }
        // A filtered-out revision still counts toward scan coverage, but its
        // support must not consume the evidence budget for eligible records.
        if (!statusAllowed(saved.record)) {
          current = request.includeHistory ? saved.parent : null;
          continue;
        }
        const metadata = [head.rel, saved.record?.title, saved.record?.scope, saved.markdown].join(
          '\n',
        );
        const matched = terms.length
          ? [
              ...(matches(head.rel) ? ['context'] : []),
              ...(saved.record && matches([saved.record.title, saved.record.scope].join('\n'))
                ? ['record']
                : []),
              ...(matches(saved.markdown) ? ['markdown'] : []),
            ]
          : [];
        const sources: Array<{
          path?: string;
          capture?: string;
          label?: string;
          hash: string;
          sensitive?: boolean;
          excerptOmitted?: string;
          excerpt?: ReturnType<typeof excerpt>;
        }> = [];
        for (const item of saved.evidence) {
          let text: string | undefined,
            sensitive = false;
          if (
            terms.length &&
            item.bytes <= 256 * 1024 &&
            searchedEvidenceBytes + item.bytes <= 1024 * 1024
          ) {
            searchedEvidenceBytes += item.bytes;
            try {
              const bytes = this.store.evidenceBytes(head.directory, item);
              // Known-sensitive bodies are neither matched nor excerpted; the name still matches.
              if (isSensitive(bytes, item.path)) {
                sensitive = true;
                skippedSensitive++;
              } else text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            } catch {
              skippedEvidence++;
            }
          } else if (terms.length) skippedEvidence++;
          if (terms.length && (matches(item.path) || (text !== undefined && matches(text))))
            sources.push({
              path: item.path,
              hash: item.hash,
              ...(sensitive ? { sensitive: true, excerptOmitted: 'sensitive' } : {}),
              ...(text === undefined
                ? {}
                : { excerpt: excerpt(text, terms, detail === 'full' ? 480 : 160) }),
            });
        }
        for (const item of saved.captures ?? []) {
          let text: string | undefined,
            sensitive = item.sensitive;
          if (sensitive) {
            if (terms.length) skippedSensitive++;
          } else if (
            terms.length &&
            item.bytes <= 256 * 1024 &&
            searchedEvidenceBytes + item.bytes <= 1024 * 1024
          ) {
            searchedEvidenceBytes += item.bytes;
            try {
              const bytes = this.store.captureBytes(head.directory, item);
              if (isSensitive(bytes, item.label)) {
                sensitive = true;
                skippedSensitive++;
              } else text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            } catch {
              skippedEvidence++;
            }
          } else if (terms.length) skippedEvidence++;
          if (terms.length && (matches(item.label) || (text !== undefined && matches(text))))
            sources.push({
              capture: item.id,
              label: item.label,
              hash: item.hash,
              ...(sensitive ? { sensitive: true, excerptOmitted: 'sensitive' } : {}),
              ...(text === undefined
                ? {}
                : { excerpt: excerpt(text, terms, detail === 'full' ? 480 : 160) }),
            });
        }
        if (matches(metadata) || sources.length) {
          if (detail === 'full')
            results.push({
              context: head.rel,
              version: current,
              currentVersion: head.version,
              isHead: current === head.version,
              at: saved.at,
              parent: saved.parent,
              record: saved.record ?? null,
              excerpt: excerpt(saved.markdown, terms),
              sources: sources.slice(0, 4),
              moreSourceMatches: Math.max(0, sources.length - 4),
              dependsOn: saved.dependsOn ?? [],
              freshness: 'not_checked',
            });
          else {
            if (sources.some(item => item.path !== undefined)) matched.push('source');
            if (sources.some(item => item.capture !== undefined)) matched.push('capture');
            const source = sources[0];
            const recordField = saved.record && matches(saved.record.title) ? 'title' : 'scope';
            const match = source
              ? {
                  ...(source.path !== undefined
                    ? { kind: 'source', source: source.path }
                    : { kind: 'capture', capture: source.capture }),
                  ...(source.excerpt
                    ? { excerpt: source.excerpt }
                    : { excerptOmitted: source.excerptOmitted ?? 'unavailable' }),
                }
              : matched.includes('record')
                ? {
                    kind: 'record',
                    field: recordField,
                    excerpt: excerpt(saved.record![recordField], terms, 160),
                  }
                : matched.includes('markdown')
                  ? { kind: 'markdown', excerpt: excerpt(saved.markdown, terms, 160) }
                  : { kind: 'context' };
            results.push({
              context: head.rel,
              version: current,
              isHead: current === head.version,
              at: saved.at,
              record: saved.record
                ? {
                    title: saved.record.title,
                    kind: saved.record.kind,
                    status: saved.record.status,
                    provenance: saved.record.provenance,
                    scope: saved.record.scope.slice(0, 160),
                    scopeTruncated: saved.record.scope.length > 160,
                  }
                : null,
              ...(terms.length ? { matched } : {}),
              ...(detail === 'concise' && terms.length ? { match } : {}),
              ...(terms.length
                ? {
                    moreSourceMatches: Math.max(
                      0,
                      sources.length - (detail === 'concise' && source ? 1 : 0),
                    ),
                  }
                : {}),
              freshness: 'not_checked',
            });
          }
        }
        current = request.includeHistory ? saved.parent : null;
      }
    }
    return {
      results,
      next: next ?? null,
      scannedRevisions: scanned,
      gaps,
      skippedEvidenceBodies: skippedEvidence,
      skippedSensitiveBodies: skippedSensitive,
      filter: { view: request.view, statuses: [...statuses] },
      ...(detail === 'full' ? {} : { detail }),
      coverage:
        detail === 'full'
          ? 'Saved contexts and selected snapshots only; no workspace crawl. At most 64 revisions, 64 gaps and 1 MiB of UTF-8 evidence per page; individual evidence above 256 KiB is name-only. Sensitive bodies are never matched or excerpted; their names and hashes still appear. Revisions outside the status filter are scanned but not returned. Follow next with the same query, history and filter options. Search is lexical, not a relevance or completeness guarantee.'
          : {
              scope: 'saved_only',
              matching: 'lexical',
              freshness: 'not_checked',
              maxRevisions: 64,
              maxGaps: 64,
              maxEvidenceBytes: 1024 * 1024,
              maxBodyBytes: 256 * 1024,
              continuation: next !== undefined,
            },
    };
  }
}
