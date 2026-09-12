# Peregrine: comparable products

Checked 12 September 2026 against vendors' public documentation. These are documented capabilities, not hands-on product evaluations. Availability can differ by market, plan and rollout.

| Product | Documented overlap | Implication for Peregrine |
| --- | --- | --- |
| [Content Snare](https://contentsnare.com/accounting-use-cases/) | Accounting information/document requests, reusable templates, automatic reminders and conversations attached to requests. | Document collection and chasing clients are established product categories. |
| [Karbon](https://karbonhq.com/solution/workflow-automation) | Accounting workflow automation, client requests/reminders, and filing emailed attachments against jobs. | Email integrated with accounting work is also established. |
| [TaxDome](https://help.taxdome.com/article/920-tax-preparation-configure-processes-in-taxdome) | Personalized document checklists, including AI creation from prior-year returns, organizer delivery and intake progress tracking. Examples on this page use US tax forms. [Australian organizers](https://taxdome.com/en-au/tax-organizers) also describe conditional questionnaires and prior-answer prefill. | Prior-year-driven AI requests are not a defensible novelty claim on their own. The documented US checklist examples do not establish equivalent Australian support. |

## Proposed positioning (our assessment)

Demonstrate an Australian family-group evidence-preparation workflow that turns adviser-reviewed Excel workpapers into current-year requests, tracks period/entity/component-specific evidence, and returns a versioned review workbook. Make the individual/company/trust context and concrete evidence discrepancies visible.

The strongest demonstration is operational specificity: one family reply reaches the right request, a wrong-year statement is rejected, a $1,000 dividend gap remains visible until supported, and adviser acceptance is explicit. This is a product hypothesis and focus, not proof of a unique market capability or competitive superiority.

Current limits matter when comparing: the prototype has fixed synthetic workbook formats, browser-local state, structured CSV evidence, pasted-text AI proposals, and manual inbox checks. It does not yet have shared production authentication, arbitrary PDF extraction, cross-entity automated reconciliation, or accepted-year rollover. The trust-to-individual linkage currently lives in the synthetic fixtures/workbooks; do not present it as an implemented automatic app check.

## Mailbox setup reference

[Google: add Gmail to another email client](https://support.google.com/mail/answer/75726?hl=en) says IMAP is always enabled for personal Gmail accounts from January 2025. [Google: App Passwords](https://support.google.com/accounts/answer/185833?hl=en) documents the 2-Step Verification prerequisite and availability restrictions. Our prototype uses an App Password; a production integration should use supported account authorization and entity-scoped server access.
