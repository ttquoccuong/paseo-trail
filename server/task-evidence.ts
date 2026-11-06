/**
 * Which task doc a session works on, guessed from the conversation when the agent did not say.
 *
 * Each scan reads the newest part of the timeline again, so windows overlap. What a scan sees is
 * therefore kept as a ledger of evidence, at most one entry per doc, signal and user turn, and the
 * score is computed from the ledger: seeing the same message twice adds nothing.
 */

/** `legacy` is the single weight an older version kept per doc, read as one piece of evidence. */
export type TaskSignal = "user" | "edit" | "read" | "mention" | "legacy";

export interface TaskEvidence {
  /** The doc's path as written; the spellings of one doc share an alias (see `taskAlias`). */
  doc: string;
  signal: TaskSignal;
  /** The user turn it belongs to; 0 is anything before the first user message Trail counted. */
  turn: number;
  points: number;
}

export interface TaskLedger {
  /** User turns counted so far. */
  turn: number;
  /** Keys of the latest user messages, oldest first; the last one is turn `turn`. */
  turnKeys: string[];
  /** Oldest first. */
  evidence: TaskEvidence[];
}

/** What one scan saw, in timeline order. */
export type TaskSighting =
  | { signal: "user"; key: string; docs: string[] }
  | { signal: "edit" | "read" | "mention"; docs: string[] };

// A user message naming one doc picks the task; one naming five is a list or a paste, so the
// message's points are shared among the docs it names.
const USER_MESSAGE_POINTS = 6;
// The message that opens a session usually says what the session is for.
const OPENING_MESSAGE_FACTOR = 2;
// Points per turn, and how many of a doc's latest turns each signal counts in: editing a doc is
// working on it, reading it or naming it in a reply is often just looking around.
const SIGNALS: Record<Exclude<TaskSignal, "user" | "legacy">, { points: number; turns: number }> = {
  edit: { points: 3, turns: 5 },
  read: { points: 0.5, turns: 2 },
  mention: { points: 0.5, turns: 3 },
};
const TURNS_KEPT: Record<TaskSignal, number> = { user: 10, legacy: 1, edit: 5, read: 2, mention: 3 };
// Evidence loses half its weight every this many user turns, so the task follows the session when
// it moves on to other work.
const HALF_LIFE_TURNS = 10;
/**
 * A doc becomes the main task only once its evidence, before fading, adds up to one edit: a user
 * message naming it among few others does, reads and passing mentions alone never do.
 */
export const MAIN_TASK_MIN_POINTS = SIGNALS.edit.points;
/** A guess is unsure when the runner-up scores at least this share of the leader. */
export const CLOSE_RUNNER_UP = 0.6;
// Scores are sums of fractions; closer than this they are equal, and the newer doc wins.
const TIE = 1e-9;

export const LEDGER_LIMITS = {
  /** Docs with evidence; the ones seen least recently go first. */
  docs: 50,
  /** User message keys remembered; at least as many as one scan window can hold. */
  turnKeys: 300,
} as const;

export function emptyLedger(): TaskLedger {
  return { turn: 0, turnKeys: [], evidence: [] };
}

/** `tasks/x.md` and `tasks/x/README.md` are one task: a single-file doc that grew into a folder. */
export function taskAlias(doc: string): string {
  return doc.replace(/(?:\/README)?\.md$/i, "");
}

/** The docs of one sighting, one per alias, each in the spelling written last. */
function byAlias(docs: readonly string[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const doc of docs) aliases.set(taskAlias(doc), doc);
  return aliases;
}

const evidenceKey = (alias: string, signal: TaskSignal, turn: number) => `${alias}\u0000${signal}\u0000${turn}`;

/**
 * Adds what a scan saw to the ledger. `fromStart` says the scan began at the session's first
 * message, so the first user message it holds opened the session.
 */
export function recordSightings(ledger: TaskLedger, sightings: readonly TaskSighting[], fromStart: boolean): TaskLedger {
  const turnKeys = [...ledger.turnKeys];
  const evidence = [...ledger.evidence];
  const recorded = new Set(evidence.map((entry) => evidenceKey(taskAlias(entry.doc), entry.signal, entry.turn)));
  let latest = ledger.turn;
  // The turn of a user message seen before; turn numbers run without gaps up to `latest`.
  const turnOf = (key: string) => {
    const index = turnKeys.lastIndexOf(key);
    return index < 0 ? undefined : latest - (turnKeys.length - 1 - index);
  };
  const note = (doc: string, alias: string, signal: TaskSignal, turn: number, points: number) => {
    const key = evidenceKey(alias, signal, turn);
    if (recorded.has(key)) return;
    recorded.add(key);
    evidence.push({ doc, signal, turn, points });
  };

  // What comes before the window's first user message belongs to the turn before it; when that
  // message is new, to the latest turn already counted.
  const firstUser = sightings.find((sighting) => sighting.signal === "user");
  let turn = firstUser ? (turnOf(firstUser.key) ?? latest + 1) - 1 : latest;
  for (const sighting of sightings) {
    if (sighting.signal === "user") {
      const known = turnOf(sighting.key);
      if (known !== undefined) {
        turn = known;
        continue;
      }
      latest += 1;
      turn = latest;
      turnKeys.push(sighting.key);
      const docs = byAlias(sighting.docs);
      const opening = fromStart && turn === 1 ? OPENING_MESSAGE_FACTOR : 1;
      for (const [alias, doc] of docs) note(doc, alias, "user", turn, (USER_MESSAGE_POINTS / docs.size) * opening);
    } else {
      for (const [alias, doc] of byAlias(sighting.docs)) note(doc, alias, sighting.signal, turn, SIGNALS[sighting.signal].points);
    }
  }
  return { turn: latest, turnKeys: turnKeys.slice(-LEDGER_LIMITS.turnKeys), evidence: bounded(evidence) };
}

/** Keeps each signal's latest turns per doc, and the docs seen most recently. */
function bounded(evidence: readonly TaskEvidence[]): TaskEvidence[] {
  const newestFirst = evidence.map((entry, index) => ({ entry, index })).sort((a, b) => b.entry.turn - a.entry.turn || b.index - a.index);
  const docs = new Set<string>();
  const turnsPerSignal = new Map<string, number>();
  const kept = new Set<number>();
  for (const { entry, index } of newestFirst) {
    const alias = taskAlias(entry.doc);
    if (!docs.has(alias)) {
      if (docs.size >= LEDGER_LIMITS.docs) continue;
      docs.add(alias);
    }
    const group = `${alias}\u0000${entry.signal}`;
    const count = turnsPerSignal.get(group) ?? 0;
    if (count >= TURNS_KEPT[entry.signal]) continue;
    turnsPerSignal.set(group, count + 1);
    kept.add(index);
  }
  return evidence.filter((_, index) => kept.has(index));
}

/**
 * Older versions kept `{ doc: weight }`, least recently seen first. Each weight becomes one piece
 * of evidence at the latest turn, in the same order, so the most recently seen doc wins a tie.
 */
export function migrateWeights(weights: Record<string, number>): TaskLedger {
  const docs = new Map<string, { doc: string; points: number }>();
  for (const [doc, weight] of Object.entries(weights)) {
    if (!Number.isFinite(weight) || weight <= 0) continue;
    const alias = taskAlias(doc);
    const points = (docs.get(alias)?.points ?? 0) + weight;
    // Re-inserted, so a doc keeps the place of its most recent spelling.
    docs.delete(alias);
    docs.set(alias, { doc, points });
  }
  const evidence = [...docs.values()].map(({ doc, points }): TaskEvidence => ({ doc, signal: "legacy", turn: 0, points }));
  return { turn: 0, turnKeys: [], evidence: bounded(evidence) };
}

export interface RankedTask {
  /** The newest spelling of the doc that exists. */
  doc: string;
  /** Faded by age; ranks the docs. */
  score: number;
}

/**
 * Docs with enough evidence to be the main task, most likely first; a tie goes to the doc seen
 * most recently. `exists` drops spellings whose file is gone, and a doc with none left.
 */
export function rankTasks(ledger: TaskLedger, exists: (doc: string) => boolean = () => true): RankedTask[] {
  const docs = new Map<string, { spellings: string[]; score: number; total: number; turn: number; index: number }>();
  ledger.evidence.forEach((entry, index) => {
    const alias = taskAlias(entry.doc);
    const doc = docs.get(alias) ?? { spellings: [], score: 0, total: 0, turn: -1, index: -1 };
    doc.score += entry.points * 0.5 ** (Math.max(0, ledger.turn - entry.turn) / HALF_LIFE_TURNS);
    doc.total += entry.points;
    if (entry.turn > doc.turn || (entry.turn === doc.turn && index > doc.index)) {
      doc.turn = entry.turn;
      doc.index = index;
    }
    doc.spellings = [...doc.spellings.filter((spelling) => spelling !== entry.doc), entry.doc];
    docs.set(alias, doc);
  });
  return [...docs.values()]
    .filter((doc) => doc.total >= MAIN_TASK_MIN_POINTS)
    .flatMap((doc) => {
      const spelling = doc.spellings.findLast((candidate) => exists(candidate));
      return spelling === undefined ? [] : [{ ...doc, doc: spelling }];
    })
    .sort((a, b) => (Math.abs(b.score - a.score) > TIE ? b.score - a.score : b.turn - a.turn || b.index - a.index))
    .map(({ doc, score }) => ({ doc, score }));
}

/** The guesses close enough to the leader that the user should pick; empty when the leader is clear. */
export function closeCandidates(ranked: readonly RankedTask[], limit: number): RankedTask[] {
  if (ranked.length < 2) return [];
  const close = ranked.filter((task) => task.score >= ranked[0].score * CLOSE_RUNNER_UP);
  return close.length < 2 ? [] : close.slice(0, limit);
}
