import { expect, test } from "bun:test";
import { z } from "zod";
import { defineAdapter, type AdapterSetup } from "./index";

const connect = async (): Promise<never> => {
  throw new Error("not connected in this test");
};

const define = (setup: AdapterSetup) =>
  defineAdapter({
    name: "example.setup",
    setup,
    config: z.strictObject({ region: z.string() }),
    credentials: z.strictObject({ token: z.string() }),
    connect,
  });

test("an adapter's setup names its environment variables and where to get them", () => {
  const adapter = define({
    credentials: { token: { env: "EXAMPLE_TOKEN", url: "https://example.com/keys" } },
    config: { region: { env: "EXAMPLE_REGION", required: true, choices: ["north", "south"] } },
    docs: "https://example.com/docs",
  });

  expect(adapter.setup?.credentials.token?.env).toBe("EXAMPLE_TOKEN");
  expect(adapter.setup?.config?.region?.required).toBe(true);
});

test("setup rejects variable names and links a host could not use", () => {
  expect(() => define({ credentials: { token: { env: "lower-case" } } })).toThrow();
  expect(() =>
    define({ credentials: { token: { env: "EXAMPLE_TOKEN", url: "http://example.com" } } }),
  ).toThrow();
  expect(() => define({ credentials: {}, docs: "javascript:alert(1)" })).toThrow();
});
