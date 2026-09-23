import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';

// The tools an installed connection must expose. Kept in step with TOOL_NAMES in src/tools.ts;
// this file also runs from installed copies, which have no source tree to import it from.
export const coreTools = [
  'glue_resume',
  'glue_checkpoint',
  'glue_find',
  'glue_read',
  'glue_check_capture',
  'glue_transfer',
];

export function readConfigurationText(file) {
  const bytes = readFileSync(file);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw Error('Host configuration must be valid UTF-8. No configuration was changed.');
  }
}

export function parseConfiguration(text, label = 'Codex configuration') {
  try {
    return parse(text, { integersAsBigInt: 'asNeeded' });
  } catch (error) {
    // Parser excerpts can contain credentials. Never return the parser message.
    const location =
      Number.isInteger(error.line) && Number.isInteger(error.column)
        ? ` at line ${error.line}, column ${error.column}`
        : '';
    throw Error(`Invalid ${label} TOML${location}. No configuration was changed.`);
  }
}

// Compare decimal spellings without rounding through a JavaScript number.
function decimalIdentity(token) {
  const [, sign, whole, fraction = '', exponent = '0'] = token.match(
    /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/,
  );
  const digits = (whole + fraction).replace(/^0+/, '');
  if (!digits) return sign + '0';
  const significant = digits.replace(/0+$/, '');
  return (
    sign +
    significant +
    'e' +
    (BigInt(exponent) - BigInt(fraction.length) + BigInt(digits.length - significant.length))
  );
}

export function parseJsonConfiguration(text) {
  try {
    const value = JSON.parse(text, (_key, value) => {
      if (
        typeof value === 'number' &&
        (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      )
        throw Error();
      return value;
    });
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    // JSON.parse accepts duplicate keys and silently discards the first value.
    // Refuse them before rewriting any user's configuration.
    const stack = [];
    for (const token of text.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g) || []) {
      if (/^-?\d/.test(token) && decimalIdentity(token) !== decimalIdentity(String(Number(token))))
        throw Error();
      if (token === '{') stack.push({ keys: new Set(), key: true });
      else if (token === '[') stack.push(null);
      else if (token === '}' || token === ']') stack.pop();
      else if (token === ',') {
        if (stack.at(-1)) stack.at(-1).key = true;
      } else if (token.startsWith('"') && stack.at(-1)?.key) {
        const current = stack.at(-1),
          key = JSON.parse(token);
        if (current.keys.has(key)) throw Error();
        current.keys.add(key);
        current.key = false;
      }
    }
    return value;
  } catch {
    throw Error('Invalid or ambiguous host JSON configuration. No configuration was changed.');
  }
}

export function assertLocalConnection(
  config,
  command,
  args,
  host = 'codex',
  name = 'glue',
  requiredTools = coreTools,
) {
  const connection = (host === 'codex' ? config.mcp_servers : config.mcpServers)?.[name];
  if (
    !connection ||
    typeof connection !== 'object' ||
    Array.isArray(connection) ||
    Object.hasOwn(connection, 'url') ||
    connection.command !== command ||
    !Array.isArray(connection.args) ||
    connection.args.length !== args.length ||
    connection.args.some((value, index) => value !== args[index]) ||
    (connection.type !== undefined && connection.type !== 'stdio')
  ) {
    throw Error(
      'The Glue connection does not match this local installation. Existing connections were not changed.',
    );
  }
  if (connection.enabled === false || connection.disabled === true)
    throw Error('The Glue connection is disabled in host configuration.');
  for (const field of ['enabled_tools', 'disabled_tools']) {
    if (
      connection[field] !== undefined &&
      (!Array.isArray(connection[field]) || connection[field].some(t => typeof t !== 'string'))
    )
      throw Error('Invalid Glue tool filter in host configuration.');
  }
  if (
    requiredTools.some(
      tool =>
        (connection.enabled_tools !== undefined && !connection.enabled_tools.includes(tool)) ||
        connection.disabled_tools?.includes(tool),
    )
  )
    throw Error('Host configuration filters out required Glue tools.');
}
