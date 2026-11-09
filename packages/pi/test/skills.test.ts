import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { hostSkillPath } from "../src/skills";

test("Pi host reads stay inside loaded skill directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "beachside-skill-"));
  const baseDir = join(root, "example");
  const filePath = join(baseDir, "SKILL.md");
  const guide = join(baseDir, "guide.md");
  const privateFile = join(root, "private");
  const link = join(baseDir, "outside");

  const skill: Skill = {
    name: "example",
    description: "Example skill",
    baseDir,
    filePath,
    disableModelInvocation: false,
    sourceInfo: { path: filePath, source: "fixture", scope: "user", origin: "top-level" },
  };

  try {
    await mkdir(baseDir);
    await Promise.all([filePath, guide, privateFile].map((path) => writeFile(path, "fixture")));
    await symlink(privateFile, link);

    expect(await hostSkillPath(filePath, [skill])).toBe(await realpath(filePath));
    expect(await hostSkillPath(guide, [skill])).toBe(await realpath(guide));
    expect(await hostSkillPath(privateFile, [skill])).toBeUndefined();
    await expect(hostSkillPath(link, [skill])).rejects.toThrow("inside its skill directory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
