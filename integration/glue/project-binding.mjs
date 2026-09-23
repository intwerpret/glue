import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
export function selectProject(selected, packageRoot) {
  if (typeof selected !== 'string' || !isAbsolute(selected) || selected.includes('${'))
    throw Error('Glue requires an explicitly selected absolute project folder.');
  let project, bundled;
  try {
    project = realpathSync(selected);
    bundled = realpathSync(packageRoot);
    if (!statSync(project).isDirectory()) throw Error();
  } catch {
    throw Error(
      'Glue cannot open the selected project folder. Check availability and permissions.',
    );
  }
  const within = (parent, child) => {
    const path = relative(parent, child);
    return (
      !path ||
      (!isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\'))
    );
  };
  if (within(bundled, project) || within(project, bundled))
    throw Error('Keep the Glue package separate from the selected project folder.');
  return project;
}
