import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { EXEC_RECORD, INLINE_BYTES, filesResult, parseWrapper, quote, wrapperScript } from "./exec";

const sh = (script: string) => {
  const result = spawnSync("sh", ["-c", script], { encoding: "utf8" });

  return result.stdout;
};

test("quote keeps every byte literal and refuses NUL", () => {
  for (const word of ["", "plain", "it's", "$(id) `id` \\n", "a\nb"])
    expect(sh(`printf %s ${quote(word)}`)).toBe(word);

  expect(() => quote("a\0b")).toThrow("NUL");
});

test("the wrapper reports exit code, exact lengths and bounded output inline", () => {
  const script = wrapperScript({
    command: { kind: "shell", script: "printf hello; printf oops >&2; exit 7" },
    maxBytes: 3,
  });

  const result = parseWrapper(sh(script));

  expect(result).toEqual({
    exitCode: 7,
    stdout: new TextEncoder().encode("hel"),
    stderr: new TextEncoder().encode("oop"),
    truncated: true,
  });
});

test("output beyond the inline bound stays in the guest for download", () => {
  const script = wrapperScript({
    command: { kind: "shell", script: `head -c ${INLINE_BYTES + 1} /dev/zero` },
    maxBytes: 1024 * 1024,
  });

  const files = parseWrapper(sh(script));

  if (!files || !("directory" in files)) throw Error("Expected a files record");
  expect(files.stdoutLength).toBe(INLINE_BYTES + 1);
  sh(`rm -rf -- ${quote(files.directory)}`);

  const stdout = new Uint8Array(INLINE_BYTES + 1);
  expect(filesResult(files, stdout, new Uint8Array(), 1024 * 1024)).toMatchObject({
    complete: true,
    result: { exitCode: 0, truncated: false },
  });
  // A short download keeps the confirmed exit and reports the gap; a longer one is not ours.
  expect(filesResult(files, stdout.subarray(1), new Uint8Array(), 1024 * 1024)).toMatchObject({
    complete: false,
    result: { exitCode: 0, truncated: true },
  });
  expect(
    filesResult(files, new Uint8Array(INLINE_BYTES + 2), new Uint8Array(), 1024 * 1024),
  ).toBeNull();
});

test("an argv program whose path contains = runs literally", () => {
  const script = wrapperScript({
    command: { kind: "argv", argv: ["/nonexistent/tool=runner", "printf", "WRONG_PROGRAM"] },
    env: { V: "x" },
    maxBytes: 1024,
  });

  const result = parseWrapper(sh(script));

  expect(result).toMatchObject({ exitCode: 127, stdout: new Uint8Array() });
});

test("output past the bound does not keep disk blocks while the command runs", () => {
  // The command reports the blocks its own stdout file holds after a 4 MB burst.
  const script = wrapperScript({
    command: {
      kind: "shell",
      script: "head -c 4000000 /dev/zero; sleep 0.6; stat -L -c %b /proc/self/fd/1 >&2",
    },
    maxBytes: 1024,
  });

  const result = parseWrapper(sh(script));

  if (!result || !("stderr" in result)) throw Error("Expected an inline record");
  expect(result.stdout.length).toBe(1024);
  expect(result.truncated).toBe(true);
  // 512-byte blocks: far below the 4 MB written.
  expect(Number(new TextDecoder().decode(result.stderr)) * 512).toBeLessThan(256 * 1024);
});

test("records that are malformed, padded or longer than reported are rejected", () => {
  expect(parseWrapper("")).toBeNull();
  expect(parseWrapper(`${EXEC_RECORD} inline 0 0 0\n\n\nextra`)).toBeNull();
  expect(parseWrapper(`${EXEC_RECORD} inline 0 0 0\nQQ==\n\n`)).toBeNull();
  expect(parseWrapper(`noise\n${EXEC_RECORD} inline 0 1 0\nQQ==\n\n`)).toBeNull();
  expect(parseWrapper(`${EXEC_RECORD} files 0 1 0 /etc\n`)).toBeNull();
});

test("environment names must be POSIX names and argv must name a program", () => {
  expect(() =>
    wrapperScript({ command: { kind: "argv", argv: ["true"] }, env: { "A-B": "x" }, maxBytes: 1 }),
  ).toThrow("POSIX");
  expect(() => wrapperScript({ command: { kind: "argv", argv: [] }, maxBytes: 1 })).toThrow("argv");
});
