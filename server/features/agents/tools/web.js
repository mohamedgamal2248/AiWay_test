import { searchWeb } from "../web-search.js";

// Server-side web search tool (Meta Responses API under the hood). A per-run cap keeps
// a looping model from burning the search budget.
const MAX_SEARCHES_PER_RUN = 6;

export const webSearchTool = {
  name: "web_search",
  // Searches cost real money, so free-trial runs never get this tool.
  paidOnly: true,
  label: (args) => `search: ${String(args?.query || "").slice(0, 60)}`,
  description:
    "Search the web for current information, documentation, versions, prices or news. Returns a grounded summary with source URLs. Use short, specific queries; do not repeat the same query.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "A specific search query." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const query = String(args?.query || "").trim();
    if (!query) throw new Error("query is required");
    if ((ctx.usage?.webSearches || 0) >= MAX_SEARCHES_PER_RUN)
      throw new Error("search limit reached for this request");
    if (ctx.remainingUsd < 0.01)
      throw new Error("not enough budget left for another search");
    const result = await searchWeb(query);
    const sources = result.sources
      .map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`)
      .join("\n");
    return {
      content: `${result.summary || "No results."}${sources ? `\n\nSources:\n${sources}` : ""}`,
      usd: result.usd,
      webSearches: 1,
    };
  },
};
