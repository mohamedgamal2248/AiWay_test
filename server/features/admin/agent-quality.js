import { db } from "../../core/runtime.js";
import { json } from "../../core/http.js";
import { requireUser, requireAdmin } from "../auth/service.js";
import { TOKEN_USD } from "../../domain/credits.js";

// Agent quality dashboard: how reliable, fast and expensive each agent is, aggregated from
// what the pipeline already records (assistant messages' token_usage and released
// reservations). Nothing here needs a schema change.
const MAX_ROWS = 5000;
const DAY_MS = 86_400_000;

const avg = (a) => (a.length ? a.reduce((n, x) => n + x, 0) / a.length : 0);
const pct = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const round = (n, d = 2) => Number(Number(n).toFixed(d));

export function aggregateAgentQuality(
  messages,
  reservations,
  days,
  now = Date.now(),
) {
  const agents = new Map();
  const get = (id) => {
    if (!agents.has(id))
      agents.set(id, {
        agentId: id,
        runs: 0,
        trialRuns: 0,
        paidRuns: 0,
        steps: [],
        toolCalls: [],
        elapsed: [],
        charged: [],
        artifacts: 0,
        providerUsd: 0,
        trialProviderUsd: 0,
        stop: { complete: 0, steps: 0, time: 0, cost: 0, other: 0 },
        templates: {},
      });
    return agents.get(id);
  };
  const daily = new Map();
  const day = (iso) => new Date(iso).toISOString().slice(0, 10);
  for (let i = days - 1; i >= 0; i--)
    daily.set(day(now - i * DAY_MS), {
      date: day(now - i * DAY_MS),
      runs: 0,
      failures: 0,
    });

  for (const m of messages) {
    const u = m.token_usage || {};
    const a = get(String(u.agentId));
    a.runs++;
    if (u.billing === "trial") {
      a.trialRuns++;
      a.trialProviderUsd += Number(u.providerUsd || 0);
    } else a.paidRuns++;
    a.steps.push(Number(u.steps || 0));
    a.toolCalls.push(Number(u.toolCalls || 0));
    a.elapsed.push(Number(u.elapsedMs || 0) / 1000);
    a.charged.push(Number(u.chargedTokens || 0));
    a.providerUsd += Number(u.providerUsd || 0);
    a.artifacts += Array.isArray(u.artifacts) ? u.artifacts.length : 0;
    const stop = ["complete", "steps", "time", "cost"].includes(u.stopReason)
      ? u.stopReason
      : u.stopReason
        ? "other"
        : "complete";
    a.stop[stop]++;
    if (u.templateId)
      a.templates[u.templateId] = (a.templates[u.templateId] || 0) + 1;
    const d = daily.get(day(m.created_at));
    if (d) d.runs++;
  }

  // Failures: reservations that were released (the user was not charged).
  const errorCodes = {};
  let failures = 0;
  for (const r of reservations) {
    if (r.status !== "released") continue;
    failures++;
    const code = String(r.metadata?.code || "RELEASED");
    errorCodes[code] = (errorCodes[code] || 0) + 1;
    const d = daily.get(day(r.created_at));
    if (d) d.failures++;
  }

  const rows = [...agents.values()].map((a) => ({
    agentId: a.agentId,
    runs: a.runs,
    paidRuns: a.paidRuns,
    trialRuns: a.trialRuns,
    avgSteps: round(avg(a.steps), 1),
    avgToolCalls: round(avg(a.toolCalls), 1),
    avgSeconds: round(avg(a.elapsed), 1),
    p95Seconds: round(pct(a.elapsed, 95), 1),
    avgChargedTokens: Math.round(avg(a.charged)),
    artifactsPerRun: round(a.runs ? a.artifacts / a.runs : 0, 2),
    providerUsd: round(a.providerUsd, 4),
    revenueUsd: round(a.charged.reduce((n, x) => n + x, 0) * TOKEN_USD * 2, 4),
    trialCostUsd: round(a.trialProviderUsd, 4),
    stop: a.stop,
    // "Finished cleanly" = the agent reached its own final answer.
    completionRate: a.runs ? round((a.stop.complete / a.runs) * 100, 1) : 0,
    templates: a.templates,
  }));
  rows.sort((x, y) => y.runs - x.runs);
  const runs = rows.reduce((n, r) => n + r.runs, 0);
  return {
    days,
    totals: {
      runs,
      failures,
      successRate:
        runs + failures ? round((runs / (runs + failures)) * 100, 1) : 100,
      completionRate: runs
        ? round((rows.reduce((n, r) => n + r.stop.complete, 0) / runs) * 100, 1)
        : 0,
      trialRuns: rows.reduce((n, r) => n + r.trialRuns, 0),
      trialCostUsd: round(
        rows.reduce((n, r) => n + r.trialCostUsd, 0),
        4,
      ),
      providerUsd: round(
        rows.reduce((n, r) => n + r.providerUsd, 0),
        4,
      ),
      revenueUsd: round(
        rows.reduce((n, r) => n + r.revenueUsd, 0),
        4,
      ),
    },
    agents: rows,
    errorCodes: Object.entries(errorCodes)
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    daily: [...daily.values()],
    truncated: messages.length >= MAX_ROWS || reservations.length >= MAX_ROWS,
  };
}

export async function agentQuality(req, res) {
  const admin = await requireUser(req);
  await requireAdmin(admin);
  const days = Math.min(
    90,
    Math.max(1, Math.floor(Number(req.query?.days) || 30)),
  );
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  const supabase = db();
  const [msgs, reservations] = await Promise.all([
    supabase
      .from("messages")
      .select("created_at,token_usage")
      .eq("role", "assistant")
      .not("token_usage->>agentId", "is", null)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(MAX_ROWS),
    supabase
      .from("ai_token_reservations")
      .select("status,created_at,metadata")
      .eq("kind", "other")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(MAX_ROWS),
  ]);
  if (msgs.error) throw msgs.error;
  // The reservations table is optional in old databases; quality still works without it.
  const failures = reservations.error ? [] : reservations.data || [];
  return json(res, 200, aggregateAgentQuality(msgs.data || [], failures, days));
}
