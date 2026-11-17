'use strict';

// ---------------------------------------------------------------------------
// Startup migration check
// ---------------------------------------------------------------------------
// Runs `prisma migrate status` at server startup so schema drift between the
// code and the database is caught immediately, instead of surfacing later as
// a cryptic error on the first query.
//
// Behaviour is controlled by the MIGRATION_POLICY environment variable:
//   - "strict" -> exit the process (non-zero) before the server binds a port
//                 whenever migrations are pending or drift is detected, so an
//                 orchestrator can restart a correctly-migrated instance.
//   - "off"    -> skip the check entirely.
//   - anything else ("warn", the default) -> log a clear warning but continue
//                 booting so local dev / mock databases keep working.
//
// The standalone CLI (`prisma migrate status`) is invoked on purpose: it is
// the same source of truth the `prisma migrate deploy` step in startup.sh uses
// and needs no extra runtime dependencies beyond the already-shipped CLI.
// ---------------------------------------------------------------------------

const { execFile } = require('child_process');
const path = require('path');

const { logger } = require('./logger');

const PROJECT_ROOT = path.join(__dirname, '..');
const PRISMA_BIN = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'prisma');

/** How long to wait for `prisma migrate status` before giving up. */
const MIGRATION_CHECK_TIMEOUT_MS =
  parseInt(process.env.MIGRATION_CHECK_TIMEOUT_MS, 10) || 30_000;

const POLICIES = new Set(['strict', 'warn', 'off']);

/**
 * Resolves the active migration policy from MIGRATION_POLICY, defaulting to
 * the permissive "warn" mode.
 * @returns {'strict' | 'warn' | 'off'}
 */
function currentPolicy() {
  const raw = (process.env.MIGRATION_POLICY || 'warn').trim().toLowerCase();
  return POLICIES.has(raw) ? raw : 'warn';
}

/**
 * Runs the Prisma CLI directly against the configured database.
 * @returns {Promise<{ code: number, output: string }>}
 */
function runMigrateStatus() {
  return new Promise((resolve, reject) => {
    const child = execFile(
      PRISMA_BIN,
      ['migrate', 'status'],
      {
        cwd: PROJECT_ROOT,
        timeout: MIGRATION_CHECK_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        // Prisma writes diagnostics to both streams, so merge them.
        const output = `${stdout || ''}${stderr || ''}`;
        if (!error) {
          resolve({ code: 0, output });
          return;
        }
        if (typeof error.code === 'number') {
          // The CLI ran and exited non-zero (e.g. pending migrations / drift).
          // That is exactly the "out of sync" signal we want to inspect, not a
          // hard failure, so we capture it instead of rejecting.
          resolve({ code: error.code, output });
          return;
        }
        // Spawn-level failure (ENOENT, EACCES, timeout...). error.code is a
        // string here (e.g. 'ENOENT'), NOT a child exit code — treat it as a
        // hard failure so checkMigrations skips instead of guessing.
        reject(error);
      },
    );
    // Binary-level failure only (ENOENT, EACCES, spawn error). Kept as a guard
    // in case execFile reports the failure via the child 'error' event rather
    // than the completion callback.
    child.on('error', reject);
  });
}

/**
 * Extracts pending migration names or file paths from `prisma migrate status`
 * output so startup error logs explicitly list unapplied migration files.
 *
 * @param {string} output
 * @returns {string[]}
 */
function extractPendingMigrations(output) {
  if (!output || typeof output !== 'string') {
    return [];
  }

  const lines = output.split(/\r?\n/);
  const found = [];
  const seen = new Set();
  let inPendingSection = false;

  const addMigration = (candidate) => {
    const cleaned = candidate
      .replace(/^[-*]\s*/, '')
      .replace(/^(?:prisma\/migrations\/|migrations\/)/i, '')
      .trim();
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    found.push(cleaned);
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (inPendingSection && found.length > 0) {
        inPendingSection = false;
      }
      continue;
    }

    if (/\bnot (?:yet )?been applied:?|\bnot applied:?/i.test(line)) {
      inPendingSection = true;
      continue;
    }

    if (inPendingSection) {
      if (/^(?:to apply|run |prisma schema|datasource|error:|warning:)/i.test(line)) {
        inPendingSection = false;
        continue;
      }
      const stripped = line.replace(/^[-*]\s*/, '').trim();
      if (/^(?:(?:prisma\/)?migrations\/)?[A-Za-z0-9_.-]+(?:\/migration\.sql)?$/.test(stripped)) {
        addMigration(stripped);
        continue;
      }
    }

    const tokenMatch = line.match(
      /\b((?:(?:prisma\/)?migrations\/)?\d{8,}_[A-Za-z0-9_-]+(?:\/migration\.sql)?)\b/,
    );
    if (tokenMatch) {
      addMigration(tokenMatch[1]);
    }
  }

  return found;
}

/**
 * Formats a migration identifier into an explicit migration file reference.
 *
 * @param {string} entry
 * @returns {string}
 */
function formatPendingMigrationFile(entry) {
  if (entry.endsWith('.sql')) {
    return entry;
  }
  return `${entry} (prisma/migrations/${entry}/migration.sql)`;
}

/**
 * Classifies the raw `prisma migrate status` output into a machine-readable
 * result. Matching is deliberately lenient because wording differs across
 * Prisma CLI versions.
 * @param {{ code: number, output: string }} raw
 * @returns {{ status: string, pending: boolean, drift: boolean, pendingMigrations: string[], output: string }}
 */
function classifyStatus({ code, output }) {
  const text = (output || '').toLowerCase();
  const has = (...needles) => needles.some((needle) => text.includes(needle));

  const result = (status, pending, drift, pendingMigrations = []) => ({
    status,
    pending,
    drift,
    pendingMigrations,
    output,
  });

  if (has('up to date')) {
    return result('up-to-date', false, false);
  }
  // New migration(s) recorded in the schema but not yet applied to the DB.
  // Match flexibly because wording varies across versions, e.g.
  // "not yet been applied", "have not yet been applied", "not been applied".
  if (/\bnot (?:yet )?been applied\b/.test(text) || has('not applied')) {
    return result('pending', true, false, extractPendingMigrations(output));
  }
  // The DB has been changed in a way the local migrations don't record
  // (drift), or the DB has migrations not present in the local folder.
  if (
    has(
      'differ from the migrations',
      'drift',
      'already been applied',
      'missing from the local migrations folder',
    )
  ) {
    return result('drift', false, true);
  }
  // Nothing recognisable matched. Never pretend a non-zero CLI run is healthy:
  // surface it so drift is never silently hidden behind an unknown state.
  if (code !== 0) {
    return result('unknown', false, false);
  }
  return result('up-to-date', false, false);
}

/**
 * Runs the migration status check according to the active policy.
 *
 * @returns {Promise<{
 *   policy: 'strict'|'warn'|'off',
 *   status: string,
 *   pending: boolean,
 *   drift: boolean,
 *   pendingMigrations: string[],
 *   skipped: boolean,
 *   output: string,
 * }>}
 */
async function checkMigrations() {
  const policy = currentPolicy();

  if (policy === 'off') {
    return {
      policy,
      status: 'skipped',
      pending: false,
      drift: false,
      pendingMigrations: [],
      skipped: true,
      output: '',
    };
  }

  if (!process.env.DATABASE_URL) {
    // Nothing to compare against; don't block local/dev/mock startup but do
    // say so, since it often indicates a misconfigured environment.
    logger.warn(
      '[migrate-check] DATABASE_URL is not set — skipping migration status check'
    );
    return {
      policy,
      status: 'skipped',
      pending: false,
      drift: false,
      pendingMigrations: [],
      skipped: true,
      output: '',
    };
  }

  let raw;
  try {
    raw = await runMigrateStatus();
  } catch (err) {
    // The CLI itself failed to spawn (missing binary, EACCES...). Do not block
    // startup but surface it so operators can investigate.
    logger.warn(err, '[migrate-check] Could not run "prisma migrate status" — skipping check');
    return {
      policy,
      status: 'error',
      pending: false,
      drift: false,
      pendingMigrations: [],
      skipped: true,
      output: err.message,
    };
  }

  return { policy, ...classifyStatus(raw), skipped: false };
}

/**
 * Logs the result of the check and decides whether startup should abort.
 *
 * @param {ReturnType<typeof checkMigrations> extends Promise<infer T> ? T : never} result
 * @returns {{ shouldExit: boolean }}
 */
function enforceMigrationPolicy(result) {
  const { policy, status, pending, skipped, output } = result;
  const pendingMigrations = Array.isArray(result.pendingMigrations)
    ? result.pendingMigrations
    : extractPendingMigrations(output);

  if (skipped) {
    return { shouldExit: false };
  }

  const trimmed = (output || '').trim();

  if (status === 'up-to-date') {
    logger.info('[migrate-check] Prisma migrations are up to date.');
    return { shouldExit: false };
  }

  if (status === 'pending' || status === 'drift') {
    const reason = pending
      ? 'there are pending migrations that have not been applied'
      : 'the database schema has drifted from the local migrations';
    const pendingFilesLines =
      pending && pendingMigrations.length > 0
        ? [
            `Pending migration files: ${pendingMigrations
              .map(formatPendingMigrationFile)
              .join(', ')}`,
          ]
        : [];
    const message = [
      '[migrate-check] Database schema is out of sync with Prisma migrations.',
      `Cause: ${reason}.`,
      ...pendingFilesLines,
      '',
      'Queries are likely to fail with cryptic Prisma errors (P2010 / P2021 / no such column).',
      'Run "npx prisma migrate deploy" (production/CI) or "npx prisma migrate dev" (development)',
      'to bring the database up to date, then restart the server.',
      '',
      'Raw "prisma migrate status" output:',
      trimmed || '(no output)',
    ].join('\n');

    if (policy === 'strict') {
      logger.error(message);
      return { shouldExit: true };
    }
    logger.warn(message);
    return { shouldExit: false };
  }

  // 'unknown' / 'error' — log the raw output as a warning but keep booting so
  // an unexpected CLI response never takes a healthy environment down.
  logger.warn(
    `[migrate-check] Could not determine migration status (${status}). ` +
      `Raw output:\n${trimmed || '(no output)'}`
  );
  return { shouldExit: false };
}

/**
 * Flushes any buffered log output before the process terminates.
 *
 * Under MIGRATION_POLICY=strict we exit non-zero on drift/pending migrations.
 * In some environments (PM2, Docker with `restart: always`) the process is
 * torn down before the buffered error line reaches disk, producing silent
 * restart loops. Awaiting this helper guarantees the log is written first.
 *
 * Supports both a promise-returning `logger.flush()` and a transport that
 * emits a 'finish' event. Resolves (never rejects) so a flush failure can
 * never mask the intended non-zero exit.
 *
 * @returns {Promise<void>}
 */
function flushLogs() {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    // Safety net: never hang startup on a stuck transport.
    const timer = setTimeout(done, 5_000);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      if (logger && typeof logger.flush === 'function') {
        const result = logger.flush();
        if (result && typeof result.then === 'function') {
          result.then(() => {
            clearTimeout(timer);
            done();
          }, () => {
            clearTimeout(timer);
            done();
          });
          return;
        }
        clearTimeout(timer);
        done();
        return;
      }

      const transport = logger && (logger.transport || logger._transport);
      if (transport && typeof transport.once === 'function') {
        transport.once('finish', () => {
          clearTimeout(timer);
          done();
        });
        if (typeof transport.end === 'function') transport.end();
        return;
      }
    } catch (_err) {
      // Fall through to resolve; flushing must never block the exit.
    }

    clearTimeout(timer);
    done();
  });
}

/**
 * Runs the startup migration check and exits with code 1 (after flushing
 * buffered logs) before any port is bound when `MIGRATION_POLICY=strict`
 * encounters pending migrations or schema drift.
 *
 * Returns `{ ok: false, result }` after `process.exit(1)` so callers never
 * proceed to `app.listen()` even when `process.exit` is stubbed in tests.
 *
 * @returns {Promise<{ ok: boolean, result: object | null }>}
 */
async function verifyMigrationsOrExit() {
  try {
    const result = await checkMigrations();
    const { shouldExit } = enforceMigrationPolicy(result);
    if (shouldExit) {
      const filesDetail =
        result.pending &&
        Array.isArray(result.pendingMigrations) &&
        result.pendingMigrations.length > 0
          ? ` Pending migration files: ${result.pendingMigrations
              .map(formatPendingMigrationFile)
              .join(', ')}.`
          : '';
      logger.error(
        '[migrate-check] Aborting startup before port binding: ' +
          `database migrations are not applied.${filesDetail}`
      );
      await flushLogs();
      process.exit(1);
      return { ok: false, result };
    }
    return { ok: true, result };
  } catch (err) {
    logger.error(
      err,
      '[migrate-check] Failed to verify migration status at startup.'
    );
    await flushLogs();
    process.exit(1);
    return { ok: false, result: null };
  }
}

module.exports = {
  checkMigrations,
  enforceMigrationPolicy,
  verifyMigrationsOrExit,
  extractPendingMigrations,
  currentPolicy,
  classifyStatus,
  runMigrateStatus,
  flushLogs,
  PRISMA_BIN,
};