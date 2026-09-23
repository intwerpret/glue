// Explicit reviewed runtime modules; never ship a dist directory wholesale.
// Explicit files a workspace installation copies from integration/glue; never copy that directory
// wholesale.
export const skillFiles = host => [
  'SKILL.md',
  'references/hosts.md',
  'references/maintenance.md',
  'scripts/check.mjs',
  'scripts/configuration.mjs',
  ...(host === 'codex' ? ['agents/openai.yaml'] : []),
];
export const runtimeModules = [
  'handoff',
  'knowledge',
  'knowledge-schema',
  'mcp',
  'recovery',
  'storage',
  'input',
  'identity',
  'captures',
  'transfer',
  'tools',
  'schemas',
  'limits',
];
