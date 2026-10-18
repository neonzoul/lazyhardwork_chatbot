// Task router (doc/llm.md §1). Every LLM call names a task; the task decides model, fallback, caps and whether the
// output is strict json_schema. Tables live in src/agents.config.js; per-task env overrides come through
// src/config.js (`llm.modelOverrides`, keys LLM_MODEL_<TASK>).
//
//   resolve(taskId, { overrides? }) → { id, agent, purpose, model, fallback_models, max_tokens, temperature,
//                                      structured, timeout_ms, enabled, reason, cost_note, source: 'config'|'env' }
//   listTasks({ overrides? })        → every task, resolved
//   envKeyFor('lay.reply')           → 'LLM_MODEL_LAY_REPLY'
//   NO_LLM                           → the deterministic list (for /admin/llm/status and the doc)

const agentsConfig = require('../agents.config');

function envKeyFor(taskId) {
  return `LLM_MODEL_${String(taskId).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function defaultOverrides() {
  try { return require('../config').llm.modelOverrides || {}; } catch { return {}; }
}

function resolve(taskId, { overrides } = {}) {
  const task = agentsConfig.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`llm router: unknown task "${taskId}" (known: ${agentsConfig.tasks.map((t) => t.id).join(', ')})`);
  const ov = overrides || defaultOverrides();
  const envModel = ov[envKeyFor(task.id)];
  return {
    ...task,
    fallback_models: [...(task.fallback_models || [])],
    model: envModel && String(envModel).trim() ? String(envModel).trim() : task.model,
    source: envModel && String(envModel).trim() ? 'env' : 'config',
  };
}

function listTasks(opts = {}) {
  return agentsConfig.tasks.map((t) => resolve(t.id, opts));
}

module.exports = { resolve, listTasks, envKeyFor, NO_LLM: agentsConfig.NO_LLM, TASK_IDS: agentsConfig.tasks.map((t) => t.id) };
