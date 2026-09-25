import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { assertUnlinked } from './storage.js';

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
