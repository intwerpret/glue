import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { assertUnlinked } from './storage.js';
import { MAX_CONTEXT_IDENTITIES } from './limits.js';

/** A portable comparison key, not a rewrite of historical revision bytes. */
export const pathKey = (value: string) => value.normalize('NFC').toLowerCase();

export function lexicalPath(workspace: string, input: string) {
  if (/[\x00-\x1f:<>"|?*]/.test(input) || input.split(/[\\/]/).includes('..') || isAbsolute(input))
    throw Error('Use a portable workspace-relative path without traversal or alternate streams.');
  const file = resolve(workspace, input.replaceAll('\\', '/'));
  const rel = relative(workspace, file).replaceAll('\\', '/');
  if (
    !rel ||
    rel.startsWith('../') ||
    isAbsolute(rel) ||
    /(^|\/)(\.git|\.codex|\.agents|\.claude|\.glue)(\/|$)/i.test(rel)
  )
    throw Error(
      'Path must stay in ordinary workspace files, outside .git, .codex, .agents, .claude and .glue.',
    );
  if (
    /[. ](?:\/|$)/.test(rel) ||
    rel.split('/').some(p => /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p))
  )
    throw Error('Reserved or ambiguous path.');
  return { file, rel: pathKey(rel) };
}

/** A context is a file Glue writes. Keep it out of dot-directories and files that agent hosts load as instructions. */
export function assertContextPath(rel: string) {
  const parts = rel.split('/');
  if (
    parts.some(part => part.startsWith('.')) ||
    /^(agents|claude|codex|gemini|skill|copilot-instructions)(\.[a-z0-9_-]+)?\.md$/i.test(
      parts.at(-1) ?? '',
    )
  )
    throw Error(
      'Context must be an ordinary Markdown note, outside dot-directories and not a host instruction file such as AGENTS.md, CLAUDE.md or SKILL.md.',
    );
}

export class PathCollision extends Error {}

/** Resolve existing spelling and reject aliases that would collide on another OS. */
export function portableFile(workspace: string, input: string) {
  const lexical = lexicalPath(workspace, input);
  const parts = relative(workspace, lexical.file).split(/[\\/]/);
  let file = workspace;
  for (const part of parts) {
    assertUnlinked(file);
    if (existsSync(file)) {
      const matches = readdirSync(file).filter(name => pathKey(name) === pathKey(part));
      if (matches.length > 1)
        throw new PathCollision(
          'Portable path collision. Resolve case or Unicode aliases explicitly; nothing was changed.',
        );
      // A name that resolves without being listed is a filesystem alias, such as a Windows short
      // name.
      if (!matches.length && existsSync(join(file, part)))
        throw Error('Reserved or ambiguous path.');
      file = join(file, matches[0] ?? part);
    } else file = join(file, part);
  }
  assertUnlinked(file);
  return { file, rel: lexical.rel };
}

// Directory names bind immutable context identities, so a validated name can be reused even when
// HEAD advances. Re-enumeration detects added competing identities saved under another spelling.
const identityCache = new WeakMap<object, Map<string, string>>();
export function contextIdentity(
  owner: object,
  root: string,
  canonical: string,
  spellings: string[],
  hash: (value: string) => string,
  load: (directory: string) => string,
) {
  assertUnlinked(root);
  const ids = existsSync(root) ? readdirSync(root).filter(id => /^[a-f0-9]{64}$/.test(id)) : [];
  if (ids.length > MAX_CONTEXT_IDENTITIES)
    throw Error('Context identity lookup exceeds 10000 entries. No identity claim was made.');
  const present = new Set(ids),
    cache = identityCache.get(owner) ?? new Map<string, string>();
  identityCache.set(owner, cache);
  for (const id of cache.keys()) if (!present.has(id)) cache.delete(id);
  // Known spellings need no HEAD read. Normal head()/inspect() verifies their contents.
  const known = new Map([canonical, ...spellings].map(value => [hash(value), value]));
  const matches = new Set<string>();
  let unavailable = false;
  for (const id of ids) {
    let identity = known.get(id) ?? cache.get(id);
    if (identity === undefined) {
      try {
        const directory = join(root, id);
        assertUnlinked(directory);
        // Failed first saves can leave an empty directory with no historical bytes.
        // An active lock or any other entry prevents this exception.
        if (readdirSync(directory).length === 0) continue;
        identity = load(directory);
        if (hash(identity) !== id) throw Error('Invalid context identity');
        cache.set(id, identity);
      } catch {
        unavailable = true;
        continue;
      }
    }
    if (pathKey(identity) === canonical) matches.add(identity);
  }
  if (matches.size > 1)
    throw Error(
      'Portable context identity collision. Preserve both histories and resolve explicitly.',
    );
  const existing = [...matches][0];
  if (existing !== undefined) return existing;
  // An unreadable identity saved under another spelling might be this context. Never fork it
  // implicitly.
  if (unavailable)
    throw Error(
      'An unavailable saved identity prevents safely creating a new context. Inspect history first.',
    );
  return canonical;
}
