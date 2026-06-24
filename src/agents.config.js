// Agent model definitions — version-controlled, not in .env.
// Secrets (API keys) stay in .env. Model selection is an engineering decision: it belongs here.
// Each entry = one logical agent role. Add a new entry for each future sub-agent.

module.exports = {
  agentLay: {
    model: 'gpt-4o-mini',  // fast, cheap, Thai — correct for KB-only sales FAQ
    maxTokens: 1024,
    description: 'LINE OA reply bot — KB-only answers',
  },
  // Future sub-agents (uncomment + configure when added):
  // crmSummarizer: {
  //   model: 'gpt-4o-mini',
  //   maxTokens: 512,
  //   description: 'Summarize lead context for #crm Discord post',
  // },
  // reportAgent: {
  //   model: 'gpt-4o',
  //   maxTokens: 4096,
  //   description: 'Nightly summary report — heavier reasoning needed',
  // },
};
