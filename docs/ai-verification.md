# Live AI verification — 13 September 2026

The five representative cases below passed against the hosted `/api/assist` endpoint using real NVIDIA responses. This verifies the four implemented actions and a no-change control case; it is not a broad model-quality evaluation or a latency guarantee.

## Configuration and changes

Configured model: `nvidia/nemotron-3.5-lightning-30b-a3b`. Local, production and preview model settings were updated with user authorization. Requests use `temperature: 0.1`, `max_tokens: 1500`, `stream: false` and `chat_template_kwargs: { enable_thinking: false }`. NVIDIA documents [disabling thinking for concise responses](https://docs.nvidia.com/nim/large-language-models/2.0.10/get-started/advanced/get-started-nemotron-3.5-lightning.html). The existing 54-second shared deadline and explicit human acceptance remain.

Prompt version is now `assist-2`. `buildContext` includes the core workflow's evidence total and comparison-minus-evidence difference. Unknown values remain null. The follow-up prompt requires a nonzero difference to be stated and forbids claiming that no action is needed while it remains. The optional context field preserves compatibility with older browser payloads; reload the app to use the updated context builder. A proposal still needs review: prompt instructions are not a guarantee of factual accuracy.

## Hosted checks

All requests returned HTTP 200 and schema-valid proposals with the configured model. Each case began with fresh in-memory synthetic workspace state; generation left it unchanged. Applying each nonempty proposal through `applyProposalItem` produced the expected transition and an `ai_proposal_accepted` event. These checks did not modify the live browser workspace or send email.

| Case | Synthetic input | Required result observed | Response time |
|---|---|---|---:|
| Follow-up wording | Cash dividends: FY25 comparative $4,800; FY26 comparison $5,200; evidence $4,200 | Names the $1,000 current-year difference and requests missing statements/clarification; acceptance records a follow-up decision | 3.9 s |
| Question rewording | Alex's cash-dividend request | FY2026-prefixed cash-dividend question; acceptance replaces the question | 6.7 s |
| Text extraction | One FY26 statement with cash dividend $4,200 and franking credit $1,800 | One $4,200 cash row with an exact source quote; acceptance links 420,000 cents to the requested entity/year/component, with review still pending | 4.1 s |
| Changes triage | A newly purchased rental property first rented in January 2026, absent from the baseline | One rental-records proposal; acceptance adds a planning request | 2.8 s |
| No-change triage | A synthetic answer reporting no FY26 changes | Empty items array; no invented additional request | 7.0 s |

Extraction input for reproduction:

> SYNTHETIC DEMO. Issuer: Example Issuer A. Statement ID: FY26-DIV-A. Alex Taylor. Period: 1 July 2025 to 30 June 2026. Cash dividend AUD 4200.00. Franking credit AUD 1800.00.

Use a fresh local demo for a repeat: load the family, generate Alex's requests, select Cash dividends and enter comparison `5200`. Extract the text above, inspect the cash-only row before accepting, then request follow-up wording. Rewording and both triage cases can be exercised separately. Keep the existing hosted email session intact and do not send another email merely to test AI. Use the normal passcode entry; do not save credentials in test fixtures or screenshots.

## Browser acceptance check

The hosted interface was exercised separately with real responses: extraction, follow-up wording and rewording were reviewed and explicitly accepted for Alex's Cash dividends request. The resulting $4,200 evidence, $1,000 difference, follow-up decision and updated question survived a full page reload. The no-change triage returned no proposal items and left the request count unchanged. The existing email reply and sent outreach were preserved; no additional email was sent. Positive triage acceptance was verified in the isolated-state checks above rather than by replacing the saved client's answer.

## Investigation evidence

Kimi K3 timed out both through the hosted app and on a minimal direct provider request. NVIDIA's model catalogue accepted the key, so this was not evidence of a missing key. Several catalogue-listed alternatives returned unavailable/retired responses; catalogue membership alone did not establish a working inference endpoint.

Lightning initially answered a minimal probe but exhausted the output allowance on full requests. A reasoning-budget experiment did not produce repeatable improvement. Explicitly disabling thinking returned short proposals, but an early follow-up incorrectly suggested no further action despite a $1,000 gap. That semantic failure motivated the calculated reconciliation context and revised follow-up instruction. The final configuration then passed the complete live cases locally and through the hosted endpoint. The rejected experimental setting was not shipped.

## Regression checks and limits

93 unit/route tests across 10 files, four isolated browser journeys, type checking and production build passed. New regressions cover gap/zero/unknown reconciliation values reaching the model and the Lightning request configuration. The browser regression suites mock external providers; the live table above was verified separately.

The model can still misread or invent details on other inputs. Review the actual wording, component, period, amount and source quote before accepting. PDF/OCR, automatic rule publication, shared authentication/storage and automatic model fallback are not implemented. Repeat a live smoke check before recording the demonstration because provider latency and availability can change.
