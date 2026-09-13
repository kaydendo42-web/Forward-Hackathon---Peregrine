# Thomas — visual design and usability

Your next milestone is **a polished version of the working demo journey**: Requests → Outbox → Inbox → adviser review. Keep the existing workflow usable while improving hierarchy, spacing, typography, navigation and state clarity. The core evidence and review behavior is already implemented.

## First work package

1. Run the app from the root [README](../../../README.md). Load the synthetic family in your own browser and walk through the evidence-gap demonstration. No email or AI credentials are needed for ordinary UI work; the browser tests supply mocked email replies.
2. Record a compact visual direction and screenshots in this folder. Prioritise the Requests screen and selected-request panel, then Outbox and Inbox. Include desktop and 390 px mobile views.
3. Implement the first visual pass in `src/app/globals.css` and presentation markup in `src/components/`. Preserve component props, shared workspace actions and accessible labels used by tests; update tests intentionally if a label must change.
4. Make these states easy to distinguish: awaiting client, answer received/needs adviser review, evidence difference, reviewed, draft/not sent, sent, unmatched reply and already-accepted reply. Keep long email text and errors readable on mobile.
5. Run the checks below and submit a PR with before/after screenshots and remaining design issues.

## Files and boundaries

| Path | Use |
|---|---|
| `src/app/globals.css` | Main styling and responsive layout |
| `src/components/workspace.tsx` | Navigation, requests overview, Outbox, files and activity; coordinate shared edits with Kayden |
| `src/components/request-panel.tsx` | Evidence, client answer and adviser review presentation |
| `src/components/inbox-panel.tsx` | Reply matching, assignment, editable answer and acceptance |
| `src/components/send-draft.tsx` | Recipient, passcode and explicit send confirmation |
| `src/components/assist-panel.tsx` | AI proposal presentation; coordinate changes with the ongoing AI verification track |
| `src/components/intake-review.tsx` | Attachment proposal card (added 14 Sept); presentation only, keep labels and the disabled-until-override rule |
| `tests/demo.spec.ts`, `tests/inbox.spec.ts` | Existing behavior and mobile regression journeys |

Keep API routes, workflow rules, persistence and mailbox behavior with Kayden's track. If a design needs a new field or action, describe it in the PR before changing that contract. In particular, preserve the shared send-operation lock and receipt handling in `workspace.tsx`.

## Ready for review when

- The evidence-gap demo and both Inbox journeys still pass; `npm test`, `npm run typecheck`, `npm run test:e2e` and `npm run build` succeed.
- Desktop and 390 px mobile have readable content with no page-level horizontal overflow.
- Keyboard focus is visible, inputs retain accessible names, and status is conveyed with text as well as colour. Record what you manually checked; do not claim a full accessibility audit.
- Synthetic-data and browser-local notices remain visible. The client-view toggle remains labelled as a simulation.
- Sending, reply acceptance, AI proposal acceptance and adviser decisions remain explicit separate actions. Loading and failure states cannot look like success.
- Screenshots use synthetic records and exclude passcodes or credentials.

Do not reset Kayden's production browser workspace for screenshots. Your own local browser and the test runner provide separate demo state.
