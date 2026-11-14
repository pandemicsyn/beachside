import { expect, test, type Page, type Request } from "@playwright/test";
import { gunzipSync } from "node:zlib";
import { z } from "zod";

const consentKey = "beachside-docs-analytics-consent-v1";

const Event = z.object({
  event: z.string(),
  properties: z.object({ distinct_id: z.string().optional() }).passthrough(),
});

type CapturedEvent = z.infer<typeof Event>;

function events(request: Request): CapturedEvent[] {
  if (!/^\/(e|i\/v0\/e|batch)\/?$/.test(new URL(request.url()).pathname)) return [];
  let body = request.postDataBuffer();

  if (!body) return [];

  if (body[0] === 0x1f && body[1] === 0x8b) body = gunzipSync(body);
  let text = body.toString();

  if (text.startsWith("data=")) {
    const data = new URLSearchParams(text).get("data");

    if (!data) return [];
    text = Buffer.from(data, "base64").toString();
  }

  const parsed: unknown = JSON.parse(text);
  const single = Event.safeParse(parsed);

  if (single.success) return [single.data];
  const batch = z.object({ batch: z.array(Event) }).safeParse(parsed);

  if (batch.success) return batch.data.batch;

  return z.array(Event).parse(parsed);
}

async function observe(page: Page) {
  // Exercise the human visitor path; PostHog deliberately filters automated browsers.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "userAgentData", { get: () => undefined });
  });
  const requests: Request[] = [];
  const libraries: string[] = [];
  const captured: CapturedEvent[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.hostname === "posthog.test") {
      requests.push(request);
      captured.push(...events(request));

      const config = {
        featureFlags: {},
        hasFeatureFlags: false,
        supportedCompression: [],
        // The client must keep this disabled even when remote settings enable it.
        sessionRecording: { enabled: true, endpoint: "/s/", sampleRate: 1 },
      };

      if (url.pathname.endsWith("/config.js")) {
        await route.fulfill({
          contentType: "application/javascript",
          body: `window._POSTHOG_REMOTE_CONFIG = { phc_browser_test: { config: ${JSON.stringify(config)} } };`,
        });
      } else await route.fulfill({ json: config, headers: { "Access-Control-Allow-Origin": "*" } });
    } else if (url.hostname === "127.0.0.1") {
      if (/posthog[\w.-]*\.js/.test(url.pathname)) libraries.push(url.pathname);
      await route.continue();
    } else await route.abort();
  });

  return { requests, libraries, captured };
}

async function analyticsStorage(page: Page) {
  return page.evaluate(() => ({
    local: Object.keys(localStorage).filter((key) => /posthog|^ph_/.test(key)),
    session: Object.keys(sessionStorage).filter((key) => /posthog|^ph_/.test(key)),
  }));
}

const bar = (page: Page) => page.getByRole("region", { name: "Analytics preference" });

test("landing loads no analytics or consent UI and its demos still work", async ({
  page,
  context,
}) => {
  const { requests, libraries } = await observe(page);
  await page.goto("/");
  await expect(bar(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Analytics preferences" })).toHaveCount(0);
  await page.locator('[data-provider="e2b"]').click();
  await expect(page.locator('[data-provider="e2b"]')).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(700);
  expect(requests).toHaveLength(0);
  expect(libraries).toHaveLength(0);
  expect(await context.cookies()).toEqual([]);
  expect(await analyticsStorage(page)).toEqual({ local: [], session: [] });
});

test("pending and rejected docs send nothing, including after navigation and reload", async ({
  page,
  context,
}) => {
  const { requests, libraries } = await observe(page);
  await page.goto("/docs/");
  await expect(bar(page)).toBeVisible();
  await page.waitForTimeout(700);
  expect(requests).toHaveLength(0);
  expect(libraries).toHaveLength(0);
  await bar(page).getByRole("button", { name: "Reject", exact: true }).click();
  await expect(bar(page)).toBeHidden();
  await page.goto("/docs/privacy/");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Privacy", exact: true })).toBeVisible();
  await page.waitForTimeout(700);
  expect(requests).toHaveLength(0);
  expect(libraries).toHaveLength(0);
  expect(await context.cookies()).toEqual([]);
  expect(await analyticsStorage(page)).toEqual({ local: [], session: [] });
  expect(await page.evaluate((key) => localStorage.getItem(key), consentKey)).toBe("rejected");
  await page.getByRole("button", { name: "Analytics preferences" }).click();
  await expect(bar(page)).toBeVisible();
});

test("acceptance enables analytics; withdrawal stops requests and clears identifiers", async ({
  page,
  context,
}) => {
  const { captured, requests } = await observe(page);
  await page.goto("/docs/");
  await bar(page).getByRole("button", { name: "Accept", exact: true }).click();
  await expect(bar(page)).toBeHidden();
  await expect.poll(() => captured.some((event) => event.event === "$pageview")).toBe(true);
  expect((await context.cookies()).some((cookie) => cookie.name.includes("beachside_docs"))).toBe(
    true,
  );
  expect(requests.some((request) => /recorder|\/s\//.test(request.url()))).toBe(false);
  await page.getByRole("button", { name: "Analytics preferences" }).click();
  await bar(page).getByRole("button", { name: "Reject", exact: true }).click();
  await page.waitForLoadState("load");
  await expect(bar(page)).toBeHidden();
  const afterRejection = requests.length;
  await page.goto("/docs/privacy/");
  await page.waitForTimeout(1000);
  expect(requests).toHaveLength(afterRejection);
  expect(await analyticsStorage(page)).toEqual({ local: [], session: [] });
  expect(
    (await context.cookies()).filter((cookie) => cookie.name.includes("beachside_docs")),
  ).toEqual([]);
});

test("landing never tracks, even after docs acceptance", async ({ page }) => {
  const { captured, requests, libraries } = await observe(page);
  await page.goto("/docs/");
  await bar(page).getByRole("button", { name: "Accept", exact: true }).click();
  await expect.poll(() => captured.some((event) => event.event === "$pageview")).toBe(true);
  await page.goto("/");
  requests.length = 0;
  libraries.length = 0;
  await page.reload();
  await page.locator('[data-provider="e2b"]').click();
  await page.waitForTimeout(700);
  expect(requests).toHaveLength(0);
  expect(libraries).toHaveLength(0);
  await expect(bar(page)).toHaveCount(0);
});

test("consent bar is compact on mobile and supports keyboard choice", async ({
  page,
}, testInfo) => {
  await observe(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/docs/");
  await expect(bar(page)).toBeVisible();
  const bounds = await bar(page).boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
  expect(bounds!.height).toBeLessThan(130);
  await page.screenshot({ path: testInfo.outputPath("consent-mobile.png") });
  await page.getByRole("button", { name: "Reject", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(bar(page)).toBeHidden();
});

test("blocked storage fails closed across page loads", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Blocked", "SecurityError");
      },
    });
  });
  const { requests } = await observe(page);
  await page.goto("/docs/");
  await expect(bar(page)).toBeVisible();
  await bar(page).getByRole("button", { name: "Reject", exact: true }).click();
  await page.reload();
  await expect(bar(page)).toBeVisible();
  expect(requests).toHaveLength(0);
});
