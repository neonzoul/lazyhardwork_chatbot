// kb_gaps — questions the knowledge pack could not answer (design §5).
const { nowIso, fromJson, fromBool, bind, insertSql, repo } = require('./_util');

const COLS = ['user_id', 'question', 'kb_refs_tried', 'forwarded', 'created_at'];

function fromRow(r) {
  if (!r) return null;
  return { ...r, id: Number(r.id), kb_refs_tried: fromJson(r.kb_refs_tried, []), forwarded: fromBool(r.forwarded) };
}

function createKbGapsRepo(db, { clock } = {}) {
  const insert = db.prepare(insertSql('kb_gaps', COLS));
  const selectOne = db.prepare('SELECT * FROM kb_gaps WHERE id = $id');
  const selectAll = db.prepare('SELECT * FROM kb_gaps ORDER BY id ASC');

  return repo({
    append: (g) => {
      if (!g || !g.question) throw new Error('kbGaps.append: question required');
      const row = {
        user_id: g.user_id ?? null, question: g.question,
        kb_refs_tried: g.kb_refs_tried === undefined ? null : g.kb_refs_tried,
        forwarded: !!g.forwarded, created_at: g.created_at || nowIso(clock),
      };
      const { lastInsertRowid } = insert.run(bind(row));
      return fromRow(selectOne.get({ $id: lastInsertRowid }));
    },
    all: () => selectAll.all().map(fromRow),
  });
}

module.exports = { createKbGapsRepo };
