# AiWay Agents — design and operations

AiWay hides model choice. Every text request runs on **`muse-ember-1.0`** and every image on
**`muse-image-1.0`** through the Meta Model API (`https://api.meta.ai/v1`, OpenAI-compatible).
Prices live in one table (`server/domain/meta-models.js`); change them there if Meta changes pricing.

## Request flow

`POST /api/chat` (same endpoint as plain chat; the agent is selected by `taskId`):

1. auth, feature flags, rate limits (agents also have `agent:user:*` limits: 4/min, 40/h)
2. budget: provider USD this request may spend (see _Budgets_), balance reserved up front
3. `runAgent()` loop: model call → tool calls → model call … until a final answer
4. artifacts stored, assistant message saved (`token_usage.artifacts`), reservation finalized once
5. SSE events: `delta`, `agent_step`, `agent_tool` (start/end), `artifact`, `ping`, then `done`

Any error releases the reservation and removes files created by that run: the user is not charged.

## Agents (`server/features/agents/registry.js`)

| id                  | tools                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `chat` (plain chat) | `web_search` when the toggle is on                                                                                                       |
| `pi-app-builder`    | `web_search`, `list_files`, `read_file`, `write_file`, `edit_file`, `delete_file`, `validate_project`, `package_project`                 |
| `general-agent`     | `web_search`, `list_files`, `read_file`, `search_in_file`, `create_pdf`, `create_docx`, `create_xlsx`, `create_pptx`, `create_text_file` |
| `image-agent`       | `generate_image` (1–4), `edit_image`                                                                                                     |

Adding an agent = a registry entry (prompt + limits) and a tool factory in `tools/index.js`.

## Budgets (Vercel Hobby friendly)

- `maxDuration = 300` is already set on `api/chat.js`; the loop uses `AGENT_TIME_BUDGET_MS`
  (default 230 s) and always keeps 40 s to deliver a final tool-free answer. Steps, tool calls and
  output tokens are capped per agent. No extra serverless function was added (Hobby allows 12).
- Paid runs reserve `reserveUsd` per agent, capped by the user's balance (a low balance means a
  tighter loop, not a refusal, down to `minUsd`). The loop stops when 80% of the reservation is
  spent, and the final charge never exceeds the reservation.
- **Free trial (owner-funded):** trial users may try Pi App Builder and the General Agent with
  `trialUsd` (default $0.012/run, override `AGENT_TRIAL_BUDGET_USD`), fewer steps and no paid tools
  (search, images). The Image Agent stays behind the first purchase. Existing trial counters apply.
- Reasoning effort is the main cost lever (Ember defaults to `max`): chat `minimal`, hard chat
  `low`, agents `low`.

## Files and context

- Generated files are private objects in the `agent-files` bucket (created lazily). The assistant
  message stores `{id,name,mime,size,path}`; the browser only gets `{id,name,mime,size,kind}`.
- Downloads: `prepare-artifact` → 2-minute signed ticket → `GET /api/chat?action=artifact-download`
  (`Content-Disposition: attachment`), the pattern that works inside Pi Browser. Image previews use
  `artifact-view` tickets (images only, inline, sandboxed CSP).
- General Agent attachments are **not pasted**: bytes + an extracted-text sidecar are stored and the
  model gets a manifest (id, type, outline, preview). `read_file` (≤ 9,000 chars, 3 parts max) and
  `search_in_file` (keyword scoring, Arabic-normalized) fetch only what is needed. Old tool outputs
  are compacted once context exceeds ~70K tokens; working context is capped at 200K (cheaper tier).
- Pi App Builder keeps a virtual project folder, persisted as one JSON snapshot per conversation so
  follow-ups continue the same project. Nothing is executed on the server; `validate_project` is
  static (links, JS/JSON syntax, Pi SDK usage, secrets in client code, a11y basics).
- Conversation deletion removes the conversation's agent files.

## Documents

Tools take **structured JSON**, not code. PDF uses PDFKit with embedded Noto Naskh Arabic fonts
(`server/assets/fonts`, SIL OFL) and its own bidi line layout (shaping + right-to-left word order).
DOCX/PPTX/XLSX set RTL flags so Word/PowerPoint/Excel lay out Arabic natively. Known limit: text
extracted back from an Arabic PDF created by the agent is in visual order (copy/paste from the PDF is
affected); the DOCX is the editable/searchable format.

## Agent extras

- **Cost receipt and per-run cap.** Every agent message stores a `receipt` (AI / search / images lines that always add up to the tokens charged). Paid users can pick a max cost per request (`runCapTokens`: 500 to 5,000); it only lowers the reservation, never raises it, and trial runs ignore it.
- **Live preview.** `POST /api/chat {action:"prepare-preview"}` returns a 30-minute ticket URL `/preview/<ticket>/start` (not `index.html`, because `cleanUrls` would redirect it and break relative links) (a rewrite to `/api/chat?action=preview`, so no extra serverless function). Files are read from the project's own ZIP and served with a `sandbox` CSP without `allow-same-origin`.
- **Templates.** `templateId` (shop, donations, loyalty, quiz, booking, paywall) appends a server-side blueprint to the Pi App Builder prompt; the browser only sees names and examples.
- **Continue.** When a run stops on time, steps or cost the UI offers "Continue"; the prompt tells the agent to `list_files` first and only finish what is missing.
- **Library.** `POST /api/chat {action:"library"}` lists the user's agent files (no storage paths).
- **Admin quality dashboard.** `GET /api/admin-stats?mode=agents-quality&days=30` (admin only) aggregates runs, success and completion rates, stop reasons, time, cost and trial spend from existing tables.

## Verification status

Covered by tests (`npm test`): stream/tool-call parsing, loop budgets, billing, reservation release,
file tools, ZIP structure, document round trips. Visually checked by rendering the generated
PDF/DOCX/PPTX/XLSX (Arabic and English). The browser UI was exercised in Chromium against a mocked API.

**Not verified here (needs your Meta key and Pi Browser):** live Meta behaviour — streaming tool
calls, `reasoning_effort`, the Responses `web_search` call used by the search tool (it retries once
without the `reasoning` field if the API rejects it) and the `/images/edits` JSON shape. Run
`node scripts/smoke-meta.mjs` with `META_API_KEY` set. Also test ZIP/PDF/DOCX downloads and the
trial RPC (`claim_aiway_free_trial_token` receives `all-models` for agent runs) inside Pi Browser
on staging.
