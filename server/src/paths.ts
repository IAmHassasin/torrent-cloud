import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Returns the absolute path if it is inside `root`, otherwise throws. */
export function resolveInside(root: string, candidate: string): string {
  const base = resolve(root);
  const target = resolve(base, candidate);
  const rel = relative(base, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Path escapes the download directory');
  }
  return target;
}

/** Path of `file` relative to `root` with forward slashes (for object keys and display). */
export function toPosixRelative(root: string, file: string): string {
  return relative(resolve(root), resolve(file)).split(sep).join('/');
}

/** Makes a single object-key segment safe: no control chars, no path separators tricks. */
export function sanitizeKeySegment(segment: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = segment.replace(/[\u0000-\u001f\u007f\\]/g, '_').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return '_';
  return cleaned;
}

export function sanitizeKeyPath(path: string): string {
  return path.split('/').map(sanitizeKeySegment).join('/');
}
