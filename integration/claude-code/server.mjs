import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectProject } from './project-binding.mjs';

// Bind once at startup. Never infer a project from cwd, names or saved state.
export function boundProject(
  environment = process.env,
  pluginRoot = dirname(fileURLToPath(import.meta.url)),
) {
  return selectProject(environment.CLAUDE_PROJECT_DIR, pluginRoot);
}

// No top-level await, so this entry point also loads where a host's runtime does not support it.
async function main() {
  try {
    if (process.argv.length !== 2)
      throw Error('Glue plugin launcher does not accept project overrides.');
    if (Number(process.versions.node.split('.')[0]) < 22)
      throw Error('Glue requires Node.js 22 or later.');
    const project = boundProject();
    const { serveMcp } = await import('./runtime/mcp.js');
    await serveMcp(project);
  } catch {
    process.exitCode = 1;
    process.stderr.write(
      'Glue plugin could not start or serve. Verify Node 22+, the complete package, and a separate explicitly opened Claude project folder.' +
        String.fromCharCode(10),
      () => process.exit(1),
    );
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
