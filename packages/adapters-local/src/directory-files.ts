import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export async function filesBelow(
  root: string,
  include: (name: string) => boolean,
  directory = root,
): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesBelow(root, include, path)));
    } else if (entry.isFile() && include(entry.name)) {
      files.push(relative(root, path));
    }
  }
  // Code-unit order, so the sort agrees with the `file > cursor` comparison in pageAfter().
  return files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function pageAfter(
  files: readonly string[],
  cursor: string | null,
  limit: number,
): { readonly page: readonly string[]; readonly nextCursor: string | null } {
  const found = cursor === null ? 0 : files.findIndex((file) => file > cursor);
  const start = found < 0 ? files.length : found;
  const page = files.slice(start, start + Math.max(1, limit));
  const last = page.at(-1) ?? null;
  return { page, nextCursor: last === null || last === files.at(-1) ? null : last };
}
