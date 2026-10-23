import { computed, reactive, ref } from '@vue/reactivity';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

// Case 1, situations 5 and 7: a supporting finding is followed by a delayed
// counterexample. This is a bounded knowledge decision, not a deployment engine.
export function decide(findings) {
  return findings.some(row => row.stance === 'support') &&
    !findings.some(row => row.stance === 'refute');
}

export async function runDerivedDecisions() {
  const findings = [{ id: 'a', stance: 'support' }];
  const delayed = { id: 'b', stance: 'refute' };
  const snapshot = decide(findings);
  const native = () => decide(findings);
  const tracked = reactive({ findings: structuredClone(findings) });
  const derived = computed(() => decide(tracked.findings));
  const before = { snapshot, native: native(), reactive: derived.value };
  findings.push(delayed);
  tracked.findings.push(delayed);
  const after = { snapshot, native: native(), reactive: derived.value };

  const temp = fileURLToPath(new URL('../../temp/', import.meta.url));
  await mkdir(temp, { recursive: true });
  const directory = await mkdtemp(join(temp, 'derived-decisions-'));
  const dbPath = join(directory, 'knowledge.sqlite');
  const a = new DatabaseSync(dbPath);
  let b;
  try {
    a.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE findings (
        id TEXT PRIMARY KEY,
        procedure TEXT NOT NULL,
        stance TEXT NOT NULL CHECK (stance IN ('support', 'refute'))
      ) STRICT;
      CREATE TABLE intents (id TEXT PRIMARY KEY, procedure TEXT NOT NULL) STRICT;
      CREATE VIEW eligible AS
        SELECT DISTINCT s.procedure FROM findings s
        WHERE s.stance = 'support' AND NOT EXISTS (
          SELECT 1 FROM findings r
          WHERE r.procedure = s.procedure AND r.stance = 'refute'
        );
      INSERT INTO findings VALUES ('support-a', 'repair', 'support');
    `);
    b = new DatabaseSync(dbPath, { timeout: 0 });
    const eligible = () => a.prepare('SELECT procedure FROM eligible ORDER BY procedure')
      .all().map(row => row.procedure);
    const addRefutation = id => b.prepare('INSERT INTO findings VALUES (?, ?, ?)')
      .run(id, 'repair', 'refute');

    // No per-object graph/edge registration: a relation is derived by a query.
    const databaseComputed = computed(eligible);
    const revision = ref(0);
    const explicitBridge = computed(() => { revision.value; return eligible(); });
    const databaseBefore = {
      query: eligible(), cached: databaseComputed.value, bridged: explicitBridge.value,
    };
    addRefutation('late-b');
    const databaseAfter = {
      query: eligible(), cached: databaseComputed.value, bridged: explicitBridge.value,
    };
    revision.value++;
    const afterIngestionSignal = explicitBridge.value;

    // Isolate a second round. Deletion here resets the fixture, not knowledge policy.
    a.exec("DELETE FROM findings WHERE stance = 'refute'");
    a.exec('BEGIN IMMEDIATE');
    let writerBlocked = false;
    try {
      addRefutation('concurrent-b');
    } catch (error) {
      if (error.errcode !== 5) throw error; // SQLITE_BUSY, not a policy refusal.
      writerBlocked = true;
    }
    const inserted = a.prepare(`
      INSERT INTO intents SELECT 'intent-1', procedure FROM eligible
      WHERE procedure = 'repair'
    `).run().changes;
    a.exec('COMMIT');
    addRefutation('concurrent-b');
    const blockedInsertion = a.prepare(`
      INSERT INTO intents SELECT 'intent-2', procedure FROM eligible
      WHERE procedure = 'repair'
    `).run().changes;

    // A committed intent is not a transaction over an independent actuator.
    // Deliberately execute the old intent after the counterexample committed.
    const intent = a.prepare('SELECT procedure FROM intents WHERE id = ?').get('intent-1');
    const effectFile = join(directory, 'actuator.txt');
    await writeFile(effectFile, `executed:${intent.procedure}`, 'utf8');
    const effectAfterRefutation = await readFile(effectFile, 'utf8');
    return {
      memory: { before, after },
      database: {
        before: databaseBefore, after: databaseAfter, afterIngestionSignal,
        sqliteVersion: a.prepare('SELECT sqlite_version() AS version').get().version,
      },
      coordination: {
        writerBlocked, committedBeforeRefutation: inserted,
        newIntentsAfterRefutation: blockedInsertion,
        currentEligible: eligible(), effectAfterRefutation,
      },
      boundary: 'Local SQLite admission only; no distributed closure, actuator fencing or truth certification.',
    };
  } finally {
    b?.close();
    a.close();
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runDerivedDecisions(), null, 2));
}
