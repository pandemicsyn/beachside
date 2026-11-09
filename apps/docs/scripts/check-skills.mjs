// Keeps the agent skills in step with the repository: every official provider package is taught,
// and every skill has a description that says when to use it.
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

const skills = ["skills/beachside", "skills/beachside-cli", ".agents/skills/add-provider"];

const failures = [];

async function read(path) {
  return readFile(root + path, "utf8");
}

function frontmatter(text, path) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);

  if (!match) {
    failures.push(`${path}: missing frontmatter`);

    return {};
  }

  return Object.fromEntries(
    match[1]
      .split("\n")
      .filter((line) => /^[a-z-]+: /.test(line))
      .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]),
  );
}

for (const dir of skills) {
  const path = `${dir}/SKILL.md`;
  const fields = frontmatter(await read(path), path);
  const name = dir.split("/").at(-1);

  if (fields.name !== name) failures.push(`${path}: name should be ${name}`);

  if (!fields.description?.includes("Use when"))
    failures.push(`${path}: description should say when to use the skill ("Use when ...")`);
}

const providers = [];

for (const entry of await readdir(root + "packages/providers", { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;

  const manifest = JSON.parse(await read(`packages/providers/${entry.name}/package.json`));

  if (!manifest.private) providers.push(manifest.name);
}

const sdk = await read("skills/beachside/SKILL.md");

const cli = await read("skills/beachside-cli/SKILL.md");

const { description: cliDescription = "" } = frontmatter(cli, "skills/beachside-cli/SKILL.md");

const { description: sdkDescription = "" } = frontmatter(sdk, "skills/beachside/SKILL.md");

const cliIds = await read("packages/profile/src/providers.ts");

for (const name of providers) {
  if (!sdk.includes("`" + name + "`"))
    failures.push(`skills/beachside/SKILL.md: does not teach ${name}`);

  const id = name.replace("@beachside/", "");
  const display = new RegExp(`\\b${id}\\b`, "i");

  if (!display.test(sdkDescription))
    failures.push(`skills/beachside/SKILL.md: description does not name ${id}`);

  if (cliIds.includes(`"${id}"`) && !display.test(cliDescription))
    failures.push(`skills/beachside-cli/SKILL.md: description does not name ${id}`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Skills cover ${providers.length} provider packages`);
