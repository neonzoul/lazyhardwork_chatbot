// Loads the bot's knowledge base from a content file (engine ≠ content).
// Edit knowledge/kb.md to change what the bot knows — no code change needed.
//
// Source of truth (editorial, with Mos's notes): the LhW vault →
//   Clients/000_lazyhardwork/resources/lhw-bot-knowledge-base.md
// knowledge/kb.md is the distilled, bot-facing copy kept in sync with that source.

const fs = require('fs');
const path = require('path');

const KB_PATH = path.join(__dirname, '..', 'knowledge', 'kb.md');

let kb;
try {
  kb = fs.readFileSync(KB_PATH, 'utf8');
} catch (err) {
  throw new Error(`Failed to load knowledge base at ${KB_PATH}: ${err.message}`);
}

module.exports = kb;
