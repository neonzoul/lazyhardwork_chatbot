// The turn pipeline (design §1.2). Implemented in T6; this stub fixes the public API so the scenario runner,
// fakes and flows can be built against it in parallel.
//
//   runTurn(input, deps) → Promise<TurnResult>
//     input: { userId, kind: 'text'|'postback'|'media'|'follow'|'unfollow', text?, data?, mediaType?, replyToken?, displayName?, timestamp }
//     TurnResult: { sent: LineMessage[][] (one array per send call), action, session, errors: [] }
//
//   handleEvent(event, deps) → void   normalises a raw LINE webhook event, applies the 6.5 s burst accumulator
//                                      for text, and calls runTurn.

async function runTurn() {
  throw new Error('core/turn.runTurn is not implemented yet (T6)');
}

function handleEvent() {
  throw new Error('core/turn.handleEvent is not implemented yet (T6)');
}

module.exports = { runTurn, handleEvent };
