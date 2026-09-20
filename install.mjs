#!/usr/bin/env node
// One-command setup: run from inside the project that should get Glue.
//   node PATH/TO/glue/install.mjs [PROJECT] [--host codex|claude-code] [--yes]
// It picks the project (current folder by default) and host, builds if needed, installs, keeps Glue's
// files out of the project's Git history, and runs the installed check. scripts/install-skill.mjs does the install.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const source = dirname(fileURLToPath(import.meta.url));
const hosts = { codex: { label: 'Codex', installed: '.agents/skills/glue' },
  'claude-code': { label: 'Claude Code', installed: '.claude/skills/glue' } };

function fail(message) { console.error('\n' + message); process.exit(1); }
function run(args, options = {}) {
  return spawnSync(process.execPath, args, { cwd: source, encoding: 'utf8', windowsHide: true, ...options });
}

async function main() {
  const args = process.argv.slice(2);
  let project, host, yes = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--yes') yes = true;
    else if (args[i] === '--host' && args[i + 1]) host = args[++i];
    else if (!args[i].startsWith('--') && project === undefined) project = args[i];
    else fail('Usage: node install.mjs [PROJECT] [--host codex|claude-code] [--yes]');
  }
  if (Number(process.versions.node.split('.')[0]) < 22) fail('Glue needs Node.js 22 or later. This is Node ' + process.versions.node + '.');
  if (!existsSync(resolve(project ?? '.'))) fail('That project folder does not exist.');
  project = realpathSync(resolve(project ?? '.'));
  const inside = relative(realpathSync(source), project);
  if (!inside || (!inside.startsWith('..') && !isAbsolute(inside)))
    fail('Run this from inside the project that should get Glue, not from the Glue source folder:\n  cd YOUR_PROJECT\n  node "' + join(source, 'install.mjs') + '"');

  const interactive = process.stdin.isTTY && !yes;
  const prompt = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const ask = async (question, fallback) => prompt ? ((await prompt.question(question)).trim() || fallback) : fallback;
  try {
    if (host === 'claude-desktop') fail('Claude Desktop uses the Glue extension instead: open the .mcpb file with Claude Desktop and pick this folder.');
    if (host === undefined) {
      const guess = existsSync(join(project, '.claude')) || existsSync(join(project, '.mcp.json')) ? 'claude-code' : 'codex';
      if (!interactive) host = guess;
      else {
        const answer = (await ask('Which assistant will use Glue here? [1] Codex  [2] Claude Code  (default ' + (guess === 'codex' ? 1 : 2) + '): ', '')).toLowerCase();
        host = answer === '1' || answer === 'codex' ? 'codex' : answer === '2' || answer.startsWith('claude') ? 'claude-code' : guess;
      }
    }
    if (!hosts[host]) fail('Choose --host codex or --host claude-code. Claude Desktop uses the .mcpb extension.');
    console.log('\nProject: ' + project + '\nHost:    ' + hosts[host].label);
    if (interactive && !/^y(es)?$/i.test(await ask('Install Glue into this project? (y/n): ', 'n'))) fail('Nothing was changed.');

    if (!existsSync(join(source, 'node_modules', 'zod')) || !existsSync(join(source, 'node_modules', 'typescript')))
      fail('Glue\'s dependencies are not installed yet. Run this once, then try again:\n  cd "' + source + '"\n  npm ci');
    const { buildInputs } = await import('./scripts/build-inputs.mjs');
    const built = existsSync(join(source, 'dist', 'build.json')) ? JSON.parse(readFileSync(join(source, 'dist', 'build.json'), 'utf8')).sourceId : undefined;
    if (built !== buildInputs(source)) {
      console.log('Building Glue...');
      const build = run(['scripts/build.mjs']);
      if (build.status !== 0) fail('Build failed.\n' + (build.stderr || build.stdout));
    }

    console.log('Installing...');
    const install = run(['scripts/install-skill.mjs', project, '--host', host, '--protect-git']);
    if (install.status !== 0) {
      const reason = (install.stderr || install.stdout).split('\n').find(line => /Error: /.test(line))?.replace(/^.*Error: /, '') ?? 'Installation failed.';
      fail(reason + '\nNothing was installed.' + (/occupied|already/i.test(reason) ? ' Glue may already be set up in this project; see "Update or remove" in the README.' : ''));
    }

    const check = run([join(project, hosts[host].installed, 'scripts', 'check.mjs')]);
    let result; try { result = JSON.parse(check.stdout); } catch { result = undefined; }
    if (check.status !== 0 || !result?.ok) fail('Glue was installed but its check failed: ' + (result?.error ?? check.stderr ?? 'unknown error'));
    console.log('\nGlue ' + result.version + ' is installed with ' + result.tools.length + ' tools.\nNext:\n  1. ' +
      (host === 'codex' ? 'Open this project in Codex and trust it when asked.' : 'Open this project in Claude Code and approve the "glue" server when asked.') +
      '\n  2. Start a new session (restart the app if Glue does not appear).\n  3. Ask: "Use Glue to save where we are to notes/handoff.md."');
  } finally { prompt?.close(); }
}
main();
