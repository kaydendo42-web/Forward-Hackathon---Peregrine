# AI assist (NVIDIA NIM / Kimi) — design

Approved in chat, 12 September 2026. Adds adviser-facing LLM *proposals* to the synthetic compliance demo. Nothing the model produces is applied without an explicit adviser action, and the demo runs unchanged when no key is configured.

## Architecture

Browser → `POST /api/assist` (Next.js route handler, Node runtime) → NIM chat completions (`https://integrate.api.nvidia.com/v1/chat/completions`, OpenAI-compatible, plain `fetch`). Environment: `NVIDIA_NIM_API_KEY`, `NVIDIA_NIM_MODEL`, `AI_ASSIST_PASSCODE`. The key never reaches the client. Without a key the route returns 503 and the UI reports "AI assist is not configured". Deterministic request rules remain the baseline; AI is additive.

## Proposal model

`Proposal { task, model, promptVersion, createdAt, items[] }`. Accepting maps onto existing workflow transitions plus one new one:

| Task | Input | Item | Accept |
|---|---|---|---|
| `follow_up` | request, evidence summary, current note | `{ text, basis[] }` | `reviewRequest(id, 'follow_up', text)` |
| `extract` | pasted statement text, request | evidence row `{ documentId, amount, description, quote }` | `receiveEvidence` per row with `filename: 'pasted-text'`, `fileHash: sha256(text)`; entity/year/component fixed from the request |
| `reword` | baseline line, request | `{ question, basis[] }` | new `rewordRequest(state, id, question)`; supersedes open drafts |
| `triage` | client's "What changed?" answer, entity lines | `{ label, note, basis[] }[]` | `addPlanningRequest` per accepted item |

Audit event `ai_proposal_accepted` records task, model and promptVersion. Dismissed proposals are not stored.

## Route safety

- Passcode header `x-assist-passcode` compared in constant time; missing/wrong → 401.
- `Sec-Fetch-Site` must be `same-origin` (or absent for non-browser test callers only when `NODE_ENV=test`); otherwise 403.
- Body validated with zod; free text ≤ 20 000 characters; 20 s timeout; `temperature: 0.1`.
- Model reply must parse as JSON matching the task schema; one retry appending "Return only the JSON object"; otherwise 502.
- No server-side logging of content.

## Prompts

System prompt: synthetic Australian family-group data; FY26 = 1 July 2025 – 30 June 2026; propose only; never invent amounts; every proposal item cites `basis` quotes from supplied text; unknown → null. Per-task JSON schema appended to the user message. `promptVersion: 'assist-1'`.

## UI

`src/components/assist-panel.tsx` rendered inside `RequestPanel` for advisers only. Passcode input (sessionStorage), one button per task, textarea for pasted text (extract), proposals with Accept / Dismiss, model and prompt version shown. `triage` appears on the current-year-changes request only. Plain CSS.

## Testing

- Vitest: `src/lib/assist.ts` schemas, prompt building, reply parsing and acceptance mapping with mocked `fetch`; route handler invoked directly (`POST(new Request(...))`) for 401/403/503/502/200; `rewordRequest` in workflow tests.
- Playwright: with no key, the panel reports not-configured and existing journeys pass unchanged.

## Out of scope

Streaming, PDF/OCR, rate limiting beyond size caps (Vercel WAF rule is the follow-up), server-side proposal storage, tool calling.
