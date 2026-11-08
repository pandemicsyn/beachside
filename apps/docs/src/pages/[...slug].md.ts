import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection, type CollectionEntry } from "astro:content";

// Serves each docs page's Markdown source at its address with `.md`, for agents and `llms.txt`.
export const getStaticPaths = (async () =>
  (await getCollection("docs")).map((page) => ({
    params: { slug: page.id },
    props: { page },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute<{ page: CollectionEntry<"docs"> }> = ({ props }) => {
  const { title, description } = props.page.data;
  const lead = description ? `\n\n${description}` : "";
  const body = `# ${title}${lead}\n\n${props.page.body ?? ""}`;

  return new Response(body, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
};
