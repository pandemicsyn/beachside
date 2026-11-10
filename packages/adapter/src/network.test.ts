import { expect, test } from "bun:test";
import { checkAllowlistLimits, parseEgressAllowlist } from "./network";

test("allowlists normalize hosts and IPv4 ranges into a stable form", () => {
  const list = parseEgressAllowlist([
    "GitHub.com",
    "*.npmjs.org",
    "github.com.",
    "10.1.2.3/8",
    "1.1.1.1",
    " api.openai.com ",
  ]);

  expect(list.hosts).toEqual(["*.npmjs.org", "api.openai.com", "github.com"]);
  expect(list.cidrs).toEqual(["1.1.1.1/32", "10.0.0.0/8"]);
  expect(list.canonical).toBe("*.npmjs.org,api.openai.com,github.com,1.1.1.1/32,10.0.0.0/8");
  expect(parseEgressAllowlist(["10.0.0.0/8", "github.com"]).canonical).toBe(
    parseEgressAllowlist(["github.com", "10.9.9.9/8"]).canonical,
  );
});

test("allowlists reject entries no provider enforces as written", () => {
  for (const entry of [
    "https://github.com",
    "github.com:443",
    "github.com/path",
    "localhost",
    "*",
    "*.com.*",
    "-bad.com",
    "256.1.1.1",
    "10.0.0.0/33",
    "fe80::/10",
    "1.2.3",
  ])
    expect(() => parseEgressAllowlist([entry])).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
  expect(() => parseEgressAllowlist(["0.0.0.0/0"])).toThrow(/internet/);
  expect(() => parseEgressAllowlist([])).toThrow(/blocked/);
});

test("provider limits reject before anything is created", () => {
  const list = parseEgressAllowlist(["*.a.com", "b.com", "10.0.0.0/8"]);
  expect(() => checkAllowlistLimits("P", list, { cidrs: false })).toThrow(/host names only/);
  expect(() => checkAllowlistLimits("P", list, { wildcards: false })).toThrow(/exact host/);
  expect(() => checkAllowlistLimits("P", list, { maxHosts: 1 })).toThrow(/at most 1 host/);
  expect(() => checkAllowlistLimits("P", list, { maxCidrs: 0 })).toThrow(/at most 0 IP/);
  expect(() => checkAllowlistLimits("P", list, { maxHosts: 2, maxCidrs: 1 })).not.toThrow();
});
