import { webSearchTool } from "./web.js";
import { piBuilderTools } from "./workspace.js";
import { imageTools } from "./image.js";
import { generalAgentTools } from "./files.js";

// Tool sets are looked up by agent id; each factory receives the run context so tools
// can close over per-run state (workspace, stored files, Supabase client, user).
const factories = {
  chat: (ctx) => (ctx.webSearch ? [webSearchTool] : []),
  "pi-app-builder": (ctx) => piBuilderTools(ctx),
  "image-agent": () => imageTools(),
  "general-agent": (ctx) => generalAgentTools(ctx),
};

export async function buildTools(agentId, ctx) {
  return (factories[agentId] || (() => []))(ctx);
}

export function registerToolFactory(agentId, factory) {
  factories[agentId] = factory;
}
