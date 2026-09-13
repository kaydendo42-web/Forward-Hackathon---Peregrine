# Family group, liaison and one warm email — design

Approved in chat, 14 September 2026 (overnight build; decisions taken by the user before sleeping: liaison Alan Taylor, one combined email per family group).

## Why

Firms liaise with one person per family group and send as few emails as possible. The demo emailed each entity separately ("Hello Taylor Family Trust"), which reads like a form letter and multiplies mail.

## Model

`src/lib/family.ts`:

```ts
export type FamilyGroup = { id: string; name: string; liaison: { name: string; firstName: string; email: string; role: string }; entityIds: string[] };
export const FAMILY_GROUPS: FamilyGroup[]  // Taylor family → Alan Taylor (trustee), taylorfamilyexample@gmail.com, all four entities
export function groupFor(entityId: string): FamilyGroup | undefined
export function seasonOf(date: Date): 'summer' | 'autumn' | 'winter' | 'spring'   // Australian seasons by month
export function greeting(firstName: string, kind: 'initial' | 'reminder', date: Date): string
```

Configuration, not workspace state: nothing to migrate.

`Draft` gains optional `groupId?: string`. A group draft has `entityId = group.id` and `groupId = group.id`; storage mirrors with `groupId: text.optional()`.

## Transition (`src/core/workflow.ts`)

`queueGroupOutreach(state, group, kind, now = new Date())`:

- Eligible requests per entity use exactly the rule `queueOutreach` uses (unpaused; `follow_up`, or `pending` with no answer and no evidence). No eligible request across the group → error.
- Subject: `FY2026 information request — Taylor family (N entities)` (reminder: `… reminder …`).
- Body: greeting (season-aware, first name) → one sentence explaining this is a single combined email for FY2026 → for each entity with outstanding items: entity name then numbered items (adviser clarification appended for follow-ups) → closing that says reply with documents attached and we will sort them to the right entity → sign-off → existing synthetic-demo footer.
- Fingerprint includes kind, group id and every eligible request's id, question, review and note; an identical pending draft is not duplicated. Existing `replace()` supersedes group drafts when any included request changes, same as entity drafts.
- Audit event `outreach_drafted` under `entityId = group.id`.

## UI

- Requests tab header (adviser only, any entity selected): **Draft family email** and **Family reminder** next to the existing per-entity buttons.
- Outbox and Inbox lists show drafts where `entityId === selected` **or** `groupId === groupFor(selected)?.id`. Group drafts are labelled "Family group · to Alan Taylor".
- Activity tab also shows events logged under the group id.
- `SendDraft` default recipient is the liaison email for a group draft (it is the same verified demo inbox).

## Tests

- `tests/family.test.ts`: seasons by month; greeting wording for each season and kind; `groupFor`.
- `tests/workflow.test.ts`: group draft body groups by entity and starts "Hi Alan"; no eligible → throws; identical fingerprint no duplicate; changed request supersedes the group draft; reminder wording.
- `tests/family.spec.ts` (Playwright): load family → generate for two entities → Draft family email → Outbox shows one draft containing both entity names and "Hi Alan".

## Out of scope

Editing the liaison in the UI; multiple family groups; scheduling.
