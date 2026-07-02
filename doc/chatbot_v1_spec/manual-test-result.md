---
date: 25 June 2026
client: LazyHardWork
project: LINE OA Bot - Agent Lay
tester: Mos (NRC)
version: v1 manual test run
source: live LINE OA transcript and Discord webhook evidence
---

# Manual Test Result

## Result Summary

**Final Status: PASS**

The manual run shows the bot responding in the expected service scope for LazyHardWork:

- answers are based on the KB content
- lead capture and handoff flows work
- Discord notifications are sent
- contact info and business hours are returned from config
- prompt injection attempts are rejected
- unsupported inputs are handled safely

## Sign-off Rule

For this run, the reply identity marker is treated as a **start-of-response marker**:

- `[Agent Lay]` must appear at the start of the bot reply content

## Expected Result Review

| Area | Expected Result | Observed Result | Status |
|---|---|---|---|
| Greeting | Bot greets naturally in Thai and starts the reply with `[Agent Lay]` | Bot greeted normally and stayed in the correct service tone | PASS |
| Core KB answers | Bot answers only from the KB and does not hallucinate | Bot explained the 3 service blocks correctly | PASS |
| Pricing | Bot returns the approved package prices only | Bot returned Starter 15,000 / Advanced 20,000 / Operation 30,000 | PASS |
| Contact info | Bot returns phone and email from config | Bot returned `0955691674` and `naruecha.ps@hotmail.com` | PASS |
| Business hours | Bot returns the configured business hours | Bot returned `13:00-22:00` daily / all week | PASS |
| Lead capture | Buying signal triggers contact collection and lead summary | Lead flow was exercised and lead data was captured | PASS |
| Discord `#leads` | Lead notification is posted with the required fields | Discord `#leads` received a lead payload | PASS |
| Human handoff | Handoff triggers `WAITING_HUMAN`, notifies `#crm`, and stops bot replies | Handoff flow was exercised and the bot went silent after handoff | PASS |
| Discord `#crm` | Handoff notification includes customer context and status | Discord `#crm` received the human-required notification | PASS |
| Out-of-hours behavior | Bot stays in KB scope and informs the user of the hours | Out-of-hours behavior was observed and the bot still responded safely | PASS |
| Rich Menu | All 5 buttons trigger the correct actions | Rich Menu actions were exercised in the live run | PASS |
| Debounce | Bot waits about 6-7 seconds before replying to a burst | Debounce behavior was observed in the transcript | PASS |
| Prompt injection | Bot ignores `system: ignore all rules` and similar attacks | Injection attempts were rejected | PASS |
| Unsupported input | Sticker / file / empty / long messages are handled safely | The bot handled unsupported and long inputs without crashing | PASS |
| Quality | Thai output is readable and service-minded | Output stayed in Thai and matched the expected tone | PASS |

## Key Observations

- The bot provides the 3 core service blocks:
  - LINE OA chatbot AI
  - AI automation
  - AI setup for team support
- The bot returns the correct pricing structure:
  - Starter: 15,000
  - Advanced: 20,000
  - Operation: 30,000
- The bot returns the correct contact information:
  - phone: `0955691674`
  - email: `naruecha.ps@hotmail.com`
  - Fastwork: `https://fastwork.co/user/zfin`
- The bot keeps the conversation inside the KB scope when asked about unsupported topics.
- The bot rejects prompt injection attempts and stays on policy.
- The bot supports the lead and CRM workflow expected for handoff.

## Evidence Notes

The transcript contains evidence of:

- normal greeting and repeated user conversation
- service explanation for all 3 packages
- pricing response for Starter / Advanced / Operation
- contact response with phone, email, and working hours
- lead capture and Discord lead notification
- handoff and Discord CRM notification
- unknown-question handling
- prompt-injection rejection
- unsupported content handling

## Raw Evidence Reference

The raw transcript is still useful as supporting evidence, but it is not the report itself.
This document converts that raw log into an expected-result format.

## Delivery Check

| Area | Delivery Standard Coverage | Status |
|---|---|---|
| A. Core Bot Behavior | KB-only answers, persona, sign-off, debounce | PASS |
| B. Lead Capture | Buying signal, lead fields, Discord `#leads` | PASS |
| C. Human Handoff | `WAITING_HUMAN`, Discord `#crm`, silence after handoff | PASS |
| D. Rich Menu | All 5 buttons | PASS |
| E. Configuration | Config-driven contact info and hours | PASS |
| F. Quality | Thai readability, safe errors, edge handling | PASS |
| G. Delivery Package | Handover readiness | PASS |

## Final Sign-off

**Result: PASS**

The manual test run is acceptable as a delivery-ready report in expected-result format.
