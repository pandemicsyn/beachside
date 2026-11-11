import { expect, test } from "bun:test";

import { parseWrapper, wrapperScript } from "./exec";

const linuxGuest = process.platform === "linux" ? test : test.skip;

function run(script: string) {
  const child = Bun.spawnSync(["sh", "-c", script], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", LANG: "C" },
  });

  const stdout = child.stdout.toString();

  return {
    stdout,
    detail: JSON.stringify({ exit: child.exitCode, stdout, stderr: child.stderr.toString() }),
  };
}

linuxGuest("the wrapper record decodes from this host's sh and core tools", () => {
  const outcome = run(
    wrapperScript({
      command: { kind: "shell", script: "printf hi; printf '\\377' >&2; exit 3" },
      maxBytes: 4096,
    }),
  );

  const record = parseWrapper(outcome.stdout);

  expect(record === null ? outcome.detail : "decoded").toBe("decoded");
  expect(record?.exitCode).toBe(3);
  expect(new TextDecoder().decode(record?.stdout)).toBe("hi");
  expect([...(record?.stderr ?? [])]).toEqual([255]);
});

linuxGuest("the wrapper bounds output across both streams, stdout first", () => {
  const outcome = run(
    wrapperScript({
      command: { kind: "shell", script: "printf 0123456789; printf abcdef >&2" },
      maxBytes: 12,
    }),
  );

  const record = parseWrapper(outcome.stdout);

  expect(record === null ? outcome.detail : "decoded").toBe("decoded");
  expect(new TextDecoder().decode(record?.stdout)).toBe("0123456789");
  expect(new TextDecoder().decode(record?.stderr)).toBe("ab");
  expect(record?.truncated).toBe(true);
});
