import { existsSync, mkdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, dirname, relative, isAbsolute, resolve } from 'node:path';
import { atomicWrite, acquireLock } from '../dist/storage.js';
import {
  readConfigurationText,
  parseConfiguration,
  parseJsonConfiguration,
  assertLocalConnection,
} from '../integration/glue/scripts/configuration.mjs';

const start = '# BEGIN GLUE MANAGED CONNECTION',
  end = '# END GLUE MANAGED CONNECTION';

export function connectionChange(workspace, destination, options = {}) {
  const host = options.host ?? 'codex',
    name = options.name ?? 'glue';
  if (!['codex', 'claude-code', 'claude-desktop'].includes(host) || !/^[-a-zA-Z0-9_]+$/.test(name))
    throw Error('Invalid Glue host or server name.');
  if (host === 'codex' && name !== 'glue')
    throw Error('Codex installation uses the server name glue.');
  if (
    host === 'claude-desktop' &&
    (!options.config || !isAbsolute(options.config) || !options.name)
  )
    throw Error(
      'Claude Desktop requires an explicit absolute --config file and project-specific --name.',
    );
  if (host !== 'claude-desktop' && options.config)
    throw Error('--config is only supported for Claude Desktop.');
  const file =
    host === 'codex'
      ? join(workspace, '.codex/config.toml')
      : host === 'claude-code'
        ? join(workspace, '.mcp.json')
        : resolve(options.config);
  const checkPath = () => {
    let ancestor = resolve(file);
    while (true) {
      if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink())
        throw Error('Connection configuration must not use linked paths.');
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    if (existsSync(file) && !lstatSync(file).isFile())
      throw Error('Host configuration target must be a regular file.');
    if (host !== 'claude-desktop') {
      ancestor = existsSync(file) ? file : dirname(file);
      while (!existsSync(ancestor)) ancestor = dirname(ancestor);
      const rel = relative(realpathSync(workspace), realpathSync(ancestor));
      if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\'))
        throw Error('Connection configuration must stay inside the workspace.');
    }
  };
  checkPath();
  const previous = existsSync(file) ? readConfigurationText(file) : '';
  const config =
    host === 'codex' ? parseConfiguration(previous) : parseJsonConfiguration(previous || '{}');
  const key = host === 'codex' ? 'mcp_servers' : 'mcpServers',
    servers = config[key];
  if (
    (host === 'codex' && (previous.includes(start) || previous.includes(end))) ||
    (servers && Object.hasOwn(servers, name))
  )
    throw Error(
      'Existing Glue connection or unrelated server uses the requested name. It was preserved; choose explicitly which connection to keep before installing.',
    );
  if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers)))
    throw Error(
      'Host configuration server settings must be a table. No configuration was changed.',
    );
  const args = [join(destination, 'runtime/mcp.js'), workspace];
  let next;
  if (host === 'codex')
    next =
      previous +
      (previous && !previous.endsWith('\n') ? '\n' : '') +
      start +
      '\n[mcp_servers.glue]\ncommand = ' +
      JSON.stringify(process.execPath) +
      '\nargs = ' +
      JSON.stringify(args) +
      '\n' +
      end +
      '\n';
  else
    next =
      JSON.stringify(
        { ...config, [key]: { ...servers, [name]: { command: process.execPath, args } } },
        null,
        2,
      ) + '\n';
  assertLocalConnection(
    host === 'codex'
      ? parseConfiguration(next, 'proposed Codex configuration')
      : parseJsonConfiguration(next),
    process.execPath,
    args,
    host,
    name,
  );
  return {
    file,
    host,
    name,
    apply(beforeActivation = () => {}) {
      checkPath();
      mkdirSync(dirname(file), { recursive: true });
      // Desktop profiles can be shared by installers running in different projects.
      // The project installation lock alone cannot serialize their config writes.
      const release = acquireLock(
        dirname(file),
        '.glue-host-connection-lock',
        'Another Glue host configuration operation is active. Retry after it completes.',
      );
      try {
        checkPath();
        if ((existsSync(file) ? readConfigurationText(file) : '') !== previous)
          throw Error('Host configuration changed. Retry installation.');
        beforeActivation();
        atomicWrite(file, next);
      } finally {
        const failure = release();
        if (failure)
          console.error(
            failure +
              ' The leftover .glue-host-connection-lock directory beside the host configuration blocks later Glue connection changes until it is removed; nothing holds it.',
          );
      }
    },
  };
}
