import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MAX_CONTEXT_PATH_LENGTH, MAX_SOURCE_PATH_LENGTH } from './limits.js';

// Building blocks shared by the tool, storage and transfer schemas.

/** Lowercase hex SHA-256 of the given bytes (strings hash as UTF-8). */
export const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** A SHA-256 digest: versions, content hashes and request keys. */
export const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** A context path as a caller supplies it: a workspace-relative Markdown file. */
export const contextPath = z.string().min(1).max(MAX_CONTEXT_PATH_LENGTH);

/** A workspace-relative source file path as a caller supplies it. */
export const sourcePath = z.string().min(1).max(MAX_SOURCE_PATH_LENGTH);

export const captureId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

export const recordKind = z.enum(['decision', 'finding', 'note', 'artifact']);
export const recordProvenance = z.enum(['user', 'assistant', 'source', 'unknown']);
export const recordStatusValues = ['active', 'proposed', 'superseded', 'withdrawn'] as const;
export const recordStatus = z.enum(recordStatusValues);
/** A record status as carried by a transfer, where the source may have no record metadata. */
export const sourceStatus = z.enum([...recordStatusValues, 'unspecified']);
