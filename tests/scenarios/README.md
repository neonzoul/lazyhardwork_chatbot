# Scenarios

One YAML per conversation. Scripted model responses make them deterministic; `--model real` replays the same
customer lines against OpenAI (QA / the Monday model test). Step and `expect` vocabulary: header of
`tests/run-scenarios.js` and `doc/testing.md`. Naming: `NN-<slug>.yaml`; the brief §9 acceptance / flow §9 suite-H
ids each scenario serves go in `covers:`. `tests/unit/scenarios.test.js` checks every file's structure in `npm test`.

| range | what |
|---|---|
| `00`, `10`, `11` | the three original smoke / short-path / booking scenarios |
| `01`–`10` | the ten Mos scenarios from real chat patterns (voice samples for the §9.1 rating) |
| `12`–`15` | booking propose/approve/decline, "ไม่รู้" is not a handoff |
| `16` | known src bugs pinned — fails on purpose until fixed (see the QA report) |
| `30`–`31` | injection suite (v1 A-11…A-13 styles + price pressure) |
| `40`–`41` | fault injection: model throw/garbage, LINE reply/push failures, Discord down |
| `50`–`51` | quiet window, เรียก Lay variants, Rich Menu `CALL_LAY` |
| `60` | identity on every message, Mos relay as "มอส", no `[Agent Lay]` |
| `70` | first-tester replay — placeholder (`pending_transcript: true`) until the transcript is in the vault |

`npm run scenarios:report` writes `_report/latest.md` (per step: customer line → bubbles, sender, card, buttons),
the raw material for the Thai HTML test report. Demo mode scenarios land when the demo branch is merged.
