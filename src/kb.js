// Loads the bot's knowledge base from a content file (engine ≠ content).
// Edit knowledge/kb.md to change what the bot knows — no code change needed.
//
// Editorial source of truth (vault): Clients/000_lazyhardwork/resources/lhw-bot-knowledge-base.md
// Runtime copy (dev repo):           knowledge/kb.md  ← loaded here

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
