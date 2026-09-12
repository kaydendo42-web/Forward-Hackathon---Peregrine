# Kayden + Codex — application and integration

The email round trip is verified. Continue with **live AI verification**, then bring the three tracks together for the hackathon demonstration.

## Immediate sequence

1. Exercise all four configured AI actions with synthetic input: follow-up wording, question rewording, pasted-text extraction and changes triage. Record each result, model, latency, any error, and whether the proposal can be reviewed and applied through the existing gates. Current Kimi K3 calls have timed out or returned upstream rate limits; do not count mocked tests as live success.
2. Diagnose provider failures before changing models or increasing scope. Keep the bounded deadline, visible failures and explicit proposal acceptance. If an action cannot be verified, retain a working manual path and state the limitation in the demo script.
3. Review Jason's first proposed guidance change and agree its scope/versioning contract. A documentation proposal does not by itself change active requests or implement a guidance publisher.
4. Integrate Thomas's UI PR, resolve shared-component conflicts, and run the workflow and Inbox journeys before deploying to the existing hackathon project.
5. Rehearse and record the synthetic journey: baseline → requests → email reply → accepted client answer → evidence mismatch/gap → adviser review → workbook handoff. Include AI only to the extent verified. Check the current submission instructions before relying on the earlier pack's deadline.

## Current handoff state

Production: [peregrine-forward-hackathon.vercel.app](https://peregrine-forward-hackathon.vercel.app). The existing in-app browser session contains the verified synthetic email journey, with its accepted client answer awaiting adviser review. Other browsers have independent state. Do not resend the existing initial outreach or reset that session to run a test.

The current app was deployed directly from this checkout. GitHub publication and a Vercel deployment are separate steps; the recorded setup has no GitHub auto-deploy. Credentials stay in local/hosting environment settings.

## Integration ownership

- `src/core/`: state transitions, evidence gates, review and versions.
- `src/lib/`: parsing, storage, mailbox access, matching and model contracts.
- `src/app/api/`: passcode-gated AI, SMTP sending and IMAP Inbox checks.
- `src/components/workspace.tsx`: shared operation locking and state persistence, coordinated with Thomas's visual edits.
- Tests, deployments and current status in `PICKUP.md`.

After the demo milestone: authenticated shared state and durable inbox/outbox, selected-file document storage, read-only Xero subject to account access, then accepted-year snapshot rollover. These remain separate milestones; Jason and Thomas do not need to build them to complete their first handoffs.
