import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";

function within(root: string, path: string): boolean {
  const child = relative(root, path);

  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

/** Serve loaded skill documents and files inside their dedicated directories. */
export async function hostSkillPath(request: string, skills: readonly Skill[]) {
  const path = request.replace(/^@/, "");

  if (!isAbsolute(path)) return undefined;
  const file = resolve(path);

  for (const skill of skills) {
    const entry = resolve(skill.filePath);
    const root = dirname(entry);
    const dedicated = basename(entry) === "SKILL.md" && basename(root) === skill.name;

    if (file !== entry && !(dedicated && within(root, file))) continue;

    const [resolvedRoot, resolvedFile] = await Promise.all([realpath(root), realpath(file)]);

    if (!within(resolvedRoot, resolvedFile) || !(await stat(resolvedFile)).isFile())
      throw new Error("The requested skill file must be a regular file inside its skill directory");

    return resolvedFile;
  }
}
