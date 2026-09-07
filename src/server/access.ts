import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

/**
 * Guards against a resolved file path escaping a project's own directory
 * (e.g. via a symlink) before the server serves it — a filesystem safety
 * check, independent of who's allowed to ask for it.
 */
export async function withinDirectory(root: string, file: string): Promise<string> {
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
  const rel = relative(realRoot, realFile);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Path outside project');
  return realFile;
}
