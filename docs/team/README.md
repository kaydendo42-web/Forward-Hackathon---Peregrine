# Team handoff — start here

Updated 12 September 2026. These are the next work packages for the existing responsibilities: Jason owns guidance/checklist updates, Thomas owns visual design, and Kayden + Codex own application integration and verification. The tasks below are ready to pick up; they do not imply that either teammate has already started or approved a change.

Live demo: [Peregrine](https://peregrine-forward-hackathon.vercel.app). Repository base/default branch: `feat/compliance-demo`.

## Pick your track

| Owner | Start here | Next deliverable |
|---|---|---|
| Jason | [Guidance and checklists](jason/README.md) | One traceable proposed checklist change, with source, scope, review decision and version history |
| Thomas | [Visual design and usability](thomas/README.md) | A polished Requests → Outbox → Inbox → adviser review journey, checked on desktop and mobile |
| Kayden + Codex | [Application and integration](kayden/README.md) | Verify all four live AI actions, then integrate teammate changes and rehearse the demo |

## What works today

- Four synthetic FY25 workbooks import and generate FY26 requests. Evidence checks, amount gaps, duplicates, adviser review and versioned workbook export/import work.
- Real hosted email round trip verified: outbound request, family reply, correct thread matching and explicit acceptance into Alex's Current-year changes request. A repeated poll produced no duplicate. The answer remains pending adviser review.
- AI proposal actions are implemented, but real Kimi K3 calls have encountered timeouts/rate limits. Successful live model output remains unverified.
- Workspace data is saved in each browser. Opening the live URL on your laptop does **not** load Kayden's demo session. Use **Load synthetic family** in your own browser to start.
- Supabase, Drive, Xero, background reminders, PDF/OCR and annual snapshot rollover are future work.

## Working together

1. Clone the repository, then run `git switch feat/compliance-demo` and `git pull --ff-only`. Follow the root [README](../../README.md) for setup. Node 22+ is required; ordinary workflow development needs no email or AI credentials.
2. Create your own working branch from that base, for example `feat/jason-guidance-review` or `feat/thomas-demo-ui`. These are suggested names, not branches already created.
3. Keep the first change within your track. If a shared API, data type or workflow needs changing, describe the required behavior in the PR so Kayden can integrate it with ongoing application work.
4. Open a PR into `feat/compliance-demo`. Include the behavior before/after, checks run, screenshots for UI work, and remaining gaps. Do not include `.env.local`, credentials or mailbox exports.
5. Kayden integrates and deploys to the existing hackathon Vercel project. GitHub auto-deploy is not configured in the recorded setup; a push alone is not a deployment.

## Shared acceptance rules

Keep synthetic-data and browser-local notices visible. Preserve explicit approval for sending, accepting email text, applying AI proposals and adviser decisions. A received email, an AI proposal and accepted evidence are separate states. Prior-year amounts remain comparative only.

For code changes, run `npm test`, `npm run typecheck`, `npm run test:e2e` and `npm run build` as described in the root README. The browser suites mock external email/model calls; they do not prove live provider behavior. Documentation-only changes need checked links and accurate status, not new application tests.

Latest operational evidence is in [PICKUP.md](../../PICKUP.md). Product limits and the demonstration script are in [README.md](../../README.md). Current Inbox completion is recorded in [the Inbox plan](../superpowers/plans/2026-09-12-inbox.md).
