/* Labello engine tests.  Run with:  node test.js
 *
 * index.html is the single source of truth, so rather than duplicating the
 * deck or the dealing logic here, this pulls both straight out of it. The
 * engine is deliberately plain JavaScript (the only JSX in that region is
 * renderText, which is excluded), so it evaluates in node unchanged.
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const slice = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

const engineSrc =
  slice("const DECK = [", "\n];") + "\n];\n" +
  slice("const SLOT_ORDER = [", "/* Render card text") +
  slice("const pairOf = (pairs, id)", "\n};") + "\n};\n";

const {
  DECK, buildGame, slotsOf, pairOf, poolSize
} = new Function(engineSrc +
  "return { DECK, buildGame, slotsOf, pairOf, poolSize };")();

/* norm() and toArr() live in the sync layer, above the JSX. */
const norm = new Function(
  slice("  function toArr(v) {", "  var stateRef =") +
  "return norm;")();

let failures = [];
const fail = (m) => failures.push(m);
const seen = new Set();
const failOnce = (m) => { if (!seen.has(m)) { seen.add(m); fail(m); } };

/* ---------------------------------------------------------------- *
 *  1. Static deck checks                                            *
 * ---------------------------------------------------------------- */
console.log(`deck: ${DECK.length} cards`);

const byHeat = {};
DECK.forEach((c) => { byHeat[c[1]] = (byHeat[c[1]] || 0) + 1; });
console.log("  by heat:", byHeat);

DECK.forEach((c, i) => {
  const [type, heat, text, dur] = c;
  const where = `card ${i} "${String(text).slice(0, 50)}"`;

  if (typeof text !== "string" || !text.trim()) fail(`${where}: empty text`);
  if (!(heat >= 1 && heat <= 5)) fail(`${where}: heat ${heat} out of range`);

  /* House style: no dashes anywhere in player facing text. */
  if (/[-–—]/.test(text)) fail(`${where}: contains a dash`);

  /* The consent boundary. {m}/{n} is the matched pair channel and must never
     be diluted by mixing it with the free {p}/{q}/{r} channel, or by naming
     one half of a pair without the other. */
  const hasM = text.indexOf("{m}") >= 0, hasN = text.indexOf("{n}") >= 0;
  if ((hasM || hasN) && /\{[pqr]\}/.test(text)) fail(`${where}: mixes {m}/{n} with {p}/{q}/{r}`);
  if (hasN && !hasM) fail(`${where}: uses {n} without {m}`);
  if (hasM && !hasN) fail(`${where}: uses {m} without {n}`);

  /* Placeholders must be ones the engine knows how to cast. */
  (text.match(/\{[^}]*\}/g) || []).forEach((ph) => {
    if (!/^\{[pqrmn]\}$/.test(ph)) fail(`${where}: unknown placeholder ${ph}`);
  });

  if (type === "rule" && typeof dur !== "number") fail(`${where}: rule with no duration`);
  if (type !== "rule" && dur !== undefined) fail(`${where}: non rule card has a duration`);
});

const texts = DECK.map((c) => c[2]);
new Set(texts).size === texts.length || fail(`duplicate card text (${texts.length - new Set(texts).size})`);

/* ---------------------------------------------------------------- *
 *  1b. Nobody plays two parts in one card                           *
 *                                                                   *
 *  A card that names the same person twice reads as a contradiction  *
 *  ("Sam starts, and nobody stops until Sam says so"). Use a pronoun *
 *  for the second mention instead.                                   *
 * ---------------------------------------------------------------- */
DECK.forEach((c) => {
  const seen = {};
  (c[2].match(/\{[pqrmn]\}/g) || []).forEach((ph) => { seen[ph] = (seen[ph] || 0) + 1; });
  Object.keys(seen).forEach((ph) => {
    if (seen[ph] > 1) fail(`repeats ${ph}, so one player fills two parts: "${c[2]}"`);
  });
});

/* ---------------------------------------------------------------- *
 *  1c. The state survives a Firebase round trip                     *
 *                                                                   *
 *  Firebase stores arrays as objects keyed by index and drops any    *
 *  value that serialises to empty. Cards with no {placeholder} have  *
 *  an empty cast, so those indices vanish on write. If the read side *
 *  compacts what comes back, every later cast slides up a slot and   *
 *  the tail renders as "someone". This is that exact trip.           *
 * ---------------------------------------------------------------- */
function likeFirebase(v) {
  if (Array.isArray(v)) {
    if (v.length === 0) return undefined;
    const o = {};
    v.forEach((item, i) => { const r = likeFirebase(item); if (r !== undefined) o[i] = r; });
    return Object.keys(o).length ? o : undefined;
  }
  if (v && typeof v === "object") {
    const o = {};
    Object.keys(v).forEach((k) => { const r = likeFirebase(v[k]); if (r !== undefined) o[k] = r; });
    return Object.keys(o).length ? o : undefined;
  }
  return v;
}

{
  const players = [{ id: "a", name: "Sam", c: 0 }, { id: "b", name: "Lea", c: 1 }];
  const g = buildGame(players, [["a", "b"]], 25, 5);
  const state = {
    v: 1, phase: "play", players, pairs: [["a", "b"]], cfg: { len: 25, maxHeat: 5 },
    order: g.order, casts: g.casts, i: 0, skips: [], host: "a", ts: Date.now()
  };
  const back = norm(likeFirebase(state));

  if (back.order.length !== g.order.length) fail(`order lost entries: ${back.order.length} of ${g.order.length}`);
  for (let i = 0; i < g.order.length; i++) {
    if (back.order[i] !== g.order[i]) fail(`order[${i}] shifted after a round trip`);
    const want = JSON.stringify(g.casts[i]);
    const got = JSON.stringify(back.casts[i] || []);
    if (want !== got) fail(`casts[${i}] shifted after a round trip: ${want} became ${got}`);
  }
  if (back.players.length !== 2) fail("players lost entries in a round trip");
  if (JSON.stringify(back.pairs) !== JSON.stringify([["a", "b"]])) fail("pairs mangled in a round trip");
}

/* ---------------------------------------------------------------- *
 *  2. Dealing invariants, across the whole settings matrix          *
 * ---------------------------------------------------------------- */
const roster = (n, nPairs) => {
  const players = Array.from({ length: n }, (_, i) => ({ id: "p" + i, name: "P" + i, c: i % 8 }));
  const pairs = [];
  for (let k = 0; k < nPairs; k++) pairs.push([players[2 * k].id, players[2 * k + 1].id]);
  return { players, pairs };
};

const SCENARIOS = [[2,1],[2,0],[3,1],[4,2],[4,0],[5,2],[6,3],[6,1],[8,4],[8,0],[10,5],[16,8]];
const LENGTHS = [25, 40, 60, 90];
const CAPS = [1, 2, 3, 4, 5];

let games = 0, dealt = 0, shortfalls = 0;

for (const [n, np] of SCENARIOS) {
  const { players, pairs } = roster(n, np);
  const ids = new Set(players.map((p) => p.id));

  for (const len of LENGTHS) for (const cap of CAPS) for (let rep = 0; rep < 12; rep++) {
    const g = buildGame(players, pairs, len, cap);
    games++; dealt += g.order.length;

    /* A short game is only legitimate when the pool genuinely cannot fill it. */
    if (g.order.length !== len) {
      const pool = poolSize(players, pairs, cap);
      if (pool >= len) failOnce(`dealt ${g.order.length}/${len} despite a pool of ${pool} (n=${n} pairs=${np} cap=${cap})`);
      else shortfalls++;
    }
    if (new Set(g.order).size !== g.order.length) failOnce(`card repeated within one game (n=${n} len=${len} cap=${cap})`);

    let prevHeat = 0;
    for (let i = 0; i < g.order.length; i++) {
      const card = DECK[g.order[i]], cast = g.casts[i], slots = slotsOf(card[2]);

      if (card[1] > cap) failOnce(`heat ${card[1]} exceeded cap ${cap}`);
      if (card[1] < prevHeat) failOnce(`heat went down ${prevHeat} to ${card[1]} (n=${n} cap=${cap})`);
      prevHeat = card[1];

      if (cast.length !== slots.length) failOnce(`cast size ${cast.length} != ${slots.length} slots`);
      if (new Set(cast).size !== cast.length) failOnce(`same player cast twice: ${card[2]}`);
      for (const id of cast) if (!ids.has(id)) failOnce(`unknown player id ${id}`);

      /* THE invariant: a pair card must land on a real matched couple. */
      const mi = slots.indexOf("m"), ni = slots.indexOf("n");
      if (mi >= 0) {
        if (np === 0) failOnce(`pair card dealt with no pairs configured: ${card[2]}`);
        else if (pairOf(pairs, cast[mi]) !== cast[ni]) failOnce(`pair card on a non matched couple: ${card[2]}`);
      }
    }
  }
}

console.log(`simulated: ${games} games, ${dealt} cards dealt`);
console.log(`legitimate shortfalls (pool smaller than requested length): ${shortfalls}`);

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  failures.slice(0, 25).forEach((f) => console.error("  " + f));
  process.exit(1);
}
console.log("\nall checks passed");
