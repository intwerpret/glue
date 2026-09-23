import { existsSync, lstatSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertUnlinked } from '../dist/storage.js';

// Project files only. Never print Git output or .gitignore contents in diagnostics.
export function protectProjectGit(workspace, host) {
  let directory = workspace;
  while (!existsSync(join(directory, '.git'))) {
    const parent = dirname(directory);
    if (parent === directory) return { verify() {} };
    directory = parent;
  }
  const rules =
    host === 'codex'
      ? ['.glue/', '.agents/skills/glue/', '.codex/config.toml']
      : ['.glue/', '.claude/skills/glue/', '.mcp.json'];
  const probes = rules.map(rule => (rule.endsWith('/') ? rule + '__glue_exclusion_check__' : rule));
  const file = join(workspace, '.gitignore');
  const message =
    'Glue could not verify project Git exclusions. Check Git and project file permissions, then retry. No connection was activated; existing saved work was preserved.';
  // The project's own Git configuration is untrusted: an index refresh would otherwise run its
  // fsmonitor command or hooks. Command-line settings outrank repository configuration.
  const inert = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
  const git = (args, input) => {
    const result = spawnSync('git', ['-C', workspace, ...inert, ...args], {
      input,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    if (result.error || ![0, 1].includes(result.status)) throw Error(message);
    return result;
  };
  const read = () => {
    assertUnlinked(file);
    if (!existsSync(file)) return '';
    if (!lstatSync(file).isFile()) throw Error(message);
    return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file));
  };
  const untracked = () => {
    const result = git(['ls-files', '--cached', '-z', '--', ...rules]);
    if (result.status !== 0) throw Error(message);
    if (result.stdout.length)
      throw Error(
        'Git already tracks files used by Glue. Exclusions cannot untrack them. Review tracking before retrying; no connection was activated and existing work was preserved.',
      );
  };
  const ignored = () => {
    const result = git(['check-ignore', '--no-index', '-z', '--stdin'], probes.join('\0') + '\0');
    const found = new Set(result.stdout.split('\0').filter(Boolean));
    return result.status === 0 && probes.every(probe => found.has(probe));
  };
  const block =
    '# Glue: local installation, connection and saved history\n' + rules.join('\n') + '\n';
  let protectedText;
  // A probe alone can match a partial wildcard rule with exceptions. End with our complete
  // directory rules, and refuse any intervening edit before connection activation.
  try {
    const current = read();
    untracked();
    const addition = current.endsWith(block)
      ? ''
      : (current && !current.endsWith('\n') ? '\n' : '') + block;
    if (addition) appendFileSync(file, addition);
    protectedText = current + addition;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Git already tracks')) throw error;
    throw Error(message);
  }
  const verify = () => {
    try {
      if (read() !== protectedText) throw Error(message);
      untracked();
      if (!ignored()) throw Error(message);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Git already tracks')) throw error;
      throw Error(message);
    }
  };
  verify();
  return { verify };
}
