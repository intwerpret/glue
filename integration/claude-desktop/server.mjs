import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// No top-level await: a host that loads this entry point inside its own bundled runtime may not support it,
// and then runs none of this file. Process arguments are never read; only Desktop's required folder setting
// supplies the binding, never an argument, cwd or Claude Code's environment.
async function main() {
  let stage = 'node-version';
  try {
    if (Number(process.versions.node.split('.')[0]) < 22) throw Error();
    stage = 'package';
    const { selectProject } = await import('./project-binding.mjs');
    stage = 'project-folder';
    const project = selectProject(process.env.GLUE_PROJECT_DIR, dirname(fileURLToPath(import.meta.url)));
    stage = 'runtime';
    const { serveMcp } = await import('./runtime/mcp.js');
    stage = 'serving';
    await serveMcp(project);
  } catch {
    // Name the failed stage without echoing paths or values, then exit explicitly once the message is flushed:
    // a bundled host runtime can keep a failed process alive, which the host reports only as a timeout.
    process.exitCode = 1;
    process.stderr.write('Glue could not start or serve (' + stage + ', Node ' + process.versions.node + '). Select one available project folder outside the extension package and verify Node 22+ support.\n', () => process.exit(1));
  }
}
main();
