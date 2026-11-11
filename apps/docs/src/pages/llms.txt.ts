import { getCollection } from "astro:content";

// An index of every docs page for agents, following the llms.txt convention. Each page is also
// served as Markdown at its address with `.md` in place of the trailing slash.
export async function GET(): Promise<Response> {
  const pages = (await getCollection("docs")).toSorted((a, b) => a.id.localeCompare(b.id));

  const lines = pages.map((page) => {
    const summary = page.data.description ? `: ${page.data.description}` : "";

    return `- [${page.data.title}](https://beachside.run/${page.id}.md)${summary}`;
  });

  const body = `# Beachside

> One TypeScript SDK and CLI for cloud sandboxes on boxd, Freestyle, Daytona, E2B, Boat, Runloop, Archil, Vercel and Modal.

Each page below is the Markdown source of a page on https://beachside.run. The same page is at its address with \`.md\` in place of the trailing slash, for example https://beachside.run/docs/guides/recovery.md.

## Docs

${lines.join("\n")}
`;

  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
