import { isAbsolute, relative, sep } from 'node:path';

export function workspacesOverlap(first: string, second: string): boolean {
  const contains = (parent: string, child: string) => {
    const tail = relative(parent, child);
    return !isAbsolute(tail) && tail !== '..' && !tail.startsWith('..' + sep);
  };
  return contains(first, second) || contains(second, first);
}
