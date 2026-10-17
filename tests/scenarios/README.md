# Scenarios

One YAML per conversation. Scripted model responses make them deterministic; `--model real` replays the same
customer lines against OpenAI (QA / the Monday model test). Step and `expect` vocabulary: header of
`tests/run-scenarios.js`. Naming: `NN-<slug>.yaml`; the brief §9 acceptance each scenario serves goes in `covers:`.

Planned set (T13): 10 Mos scenarios from the Fastwork chat history · first-tester replay · injection suite ·
fault injection (model throw / garbage, notifier throw, LINE push error) · demo mode · booking + approve/propose ·
quiet window + เรียก Lay.
