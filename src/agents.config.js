// Agent model definitions — version-controlled, not in .env.
// Secrets (API keys) stay in .env. Model selection is an engineering decision: it belongs here.
// Each entry = one logical agent role. Add a new entry for each future sub-agent.
//
// Lay v2 (design §10): baseline gpt-4o-mini; the Sunday model test runs every `candidates` entry through the same
// prompt + scenario set and scores validity rate, Thai voice, policy violations, latency and cost per 100 turns.
// The pick and the numbers go into `reason` — switching is a one-line change here, nothing else moves.

module.exports = {
  agentLay: {
    model: 'gpt-4o-mini',
    maxTokens: 1024,          // one structured reply (≤ 3 bubbles + a card) fits well under this
    temperature: 0.4,         // warm wording, stable facts; raise only if the voice reads flat in the Sunday test
    timeoutMs: 20000,         // design §1.2: 20 s, then the turn falls back
    description: 'Lay — LINE OA assistant, structured replies from the KB pack (src/brain)',
    reason: 'Baseline until the Sunday model test (design §10). Fast, cheap, Thai is acceptable, structured outputs (strict json_schema) supported. Not yet compared against candidates.',
    candidates: [
      { model: 'gpt-4o-mini', note: 'today\'s baseline; prompt caching on prefixes ≥ 1024 tokens' },
      { model: 'gpt-4.1-mini', note: 'current stronger mini tier on the same key; same structured-output support; check price per 1M tokens before picking' },
      { model: 'gpt-4.1-nano', note: 'cheapest; only if validity and voice hold — expect weaker Thai' },
    ],
    // Filled by the Sunday test (scripts/model-probe.js + run-scenarios --model real):
    // results: { 'gpt-4o-mini': { validity, violations, p50_ms, cost_per_100 }, ... }
  },
  // Future sub-agents (uncomment + configure when added):
  // crmSummarizer: { model: 'gpt-4o-mini', maxTokens: 512, description: 'Summarize lead context for #crm Discord post' },
  // reportAgent:   { model: 'gpt-4o', maxTokens: 4096, description: 'Nightly summary report — heavier reasoning needed' },
};
