import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbEhWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import duckdbEhWorker from "../../vendor/duckdb/duckdb-browser-eh.worker.js?url";
import {
  DEFAULT_STORAGE_INFO,
  notifyDatabaseChanged,
  updateStorageInfo,
} from "./events.js";
import { runSchemaBootstrap } from "./schema.js";
import { getCached, invalidateCache, setCached } from "../queryCache.js";

// We use the EH (WASM exception handling) bundle instead of MVP because
// the MVP worker in this dev release of duckdb-wasm references an unbound
// Emscripten symbol (`_setThrew`) and crashes during init. EH is widely
// supported (Chrome 95+, Firefox 100+, Edge 95+, Safari 15.2+).
const DUCKDB_BUNDLE = {
  mainModule: duckdbEhWasm,
  mainWorker: duckdbEhWorker,
};

let db = null;
let conn = null;
let initPromise = null;
let transactionDepth = 0;
let onAfterTransaction = async () => {};

export function getConnection() {
  return conn;
}

export function setOnAfterTransaction(handler) {
  onAfterTransaction = typeof handler === "function" ? handler : async () => {};
}

export async function flushAfterTransaction() {
  await onAfterTransaction();
}

function buildBootStorageInfo() {
  // Transient state shown during the brief window between DuckDB
  // initialization and `cloudStorage.notifyListeners()` overriding it
  // with the real cloud-sync status. Kept generic so the boot flash
  // doesn't reference the old file-storage model.
  return {
    mode: "memory",
    isPersistent: false,
    label: "Inicializando",
    description: "Preparando o banco de dados local.",
  };
}

async function openDatabase() {
  const baseConfig = {
    accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
  };

  await db.open(baseConfig);
  updateStorageInfo(buildBootStorageInfo());
}

export async function initDB() {
  if (conn) return conn;
  if (initPromise) return initPromise;

  // Populated by the IIFE below once migrations finish. Captured outside
  // it (rather than in the IIFE's return value) so `initPromise` keeps
  // resolving to the connection — concurrent callers that hit
  // `if (initPromise) return initPromise` above depend on that shape.
  let appliedMigrationIds = [];

  initPromise = (async () => {
    const worker = new Worker(DUCKDB_BUNDLE.mainWorker);
    const logger = new duckdb.VoidLogger();

    db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(DUCKDB_BUNDLE.mainModule);
    await openDatabase();

    const connection = await db.connect();
    const { appliedIds = [] } = await runSchemaBootstrap(connection);
    appliedMigrationIds = appliedIds;

    // Published only now, after every migration has run. Publishing this
    // earlier (right after `db.connect()`) let any concurrent caller that
    // resolved `initDB()` mid-bootstrap read/write a database missing
    // whichever tables the still-pending migrations hadn't created yet
    // (e.g. a `restoreDatabaseSnapshot()` fired moments after boot could
    // hit "credit_reconciliation does not exist" if that table's migration
    // (v8) hadn't run yet).
    conn = connection;

    return conn;
  })();

  try {
    await initPromise;
  } catch (error) {
    db = null;
    conn = null;
    initPromise = null;
    transactionDepth = 0;
    updateStorageInfo(DEFAULT_STORAGE_INFO);
    throw error;
  }

  // Migrations that mutate the reconciliation inputs need a fresh
  // `credit_reconciliation` rebuild so the UI doesn't show stale buckets
  // until the user touches an import:
  //   v10 — strips leading zeros from `numero_nota` and rebuilds every
  //         `match_key`.
  //   v11 — recomputes `is_valid` for credit_notes so pre-Jan-2026
  //         exports ("Liberado") finally count toward matching.
  // Dynamic import breaks the module cycle (reconciliation → db barrel
  // → connection). Runs after `initPromise` resolves (not inside the IIFE
  // above) so its own `execute`/`query` calls resolve `conn` through the
  // normal fast path instead of awaiting the very promise they'd be
  // nested inside of. Only the caller that actually created `initPromise`
  // reaches this far (everyone else already returned above), so reconcile
  // still runs exactly once per boot.
  const reconcileTriggeringMigrations = [10, 11];
  if (
    appliedMigrationIds.some((id) => reconcileTriggeringMigrations.includes(id))
  ) {
    try {
      const { reconcileCredits } = await import(
        "../reconciliation/creditReconciliationService.js"
      );
      await reconcileCredits({ emitChange: false });
    } catch (error) {
      console.warn(
        "Post-migration reconcile failed; the user can run it manually from Credits → 'Re-rodar conciliação'.",
        error,
      );
    }
  }

  return conn;
}

export async function query(sql) {
  const connection = await initDB();
  const result = await connection.query(sql);
  return result.toArray();
}

export async function execute(sql, { domains, flush = true, source } = {}) {
  const connection = await initDB();
  const result = await connection.query(sql);
  const rowsAffected = extractRowsAffected(result);

  // Mirrors `executePrepared`: skip the cache wipe and change event when we
  // can positively confirm the statement touched zero rows. `execute()` used
  // to always fall through here regardless of `rowsAffected`, which meant
  // any write going through this (non-prepared) path never invalidated
  // `queryCache` — callers could keep reading stale cached rows after a real
  // mutation, until some unrelated `executePrepared` call happened to wipe
  // the cache first.
  if (rowsAffected !== 0) {
    invalidateCache();
  }

  if (flush && transactionDepth === 0 && rowsAffected !== 0) {
    await flushAfterTransaction();
    notifyDatabaseChanged(source || domains ? { source, domains } : undefined);
  }
}

/**
 * Run a prepared SELECT statement.
 *
 * Pass `?` placeholders in the SQL and the matching values in `params`. The
 * statement is closed automatically once results are read, so callers don't
 * have to track the lifetime themselves.
 */
// DuckDB-WASM's worker bridge JSON-stringifies bound parameters and throws
// on JS BigInt values. BIGINT columns (e.g. `donation_notes.valor_cents`)
// come back as BigInt, and we freely re-circulate those reads as next-query
// params (notably in `diagnoseCreditImportMatching`). Coerce here once so
// every prepared-statement caller is safe. Cents fit safely under
// Number.MAX_SAFE_INTEGER, so the coercion is loss-free for our domain.
function sanitizePreparedParams(params) {
  return params.map((value) =>
    typeof value === "bigint" ? Number(value) : value,
  );
}

export async function queryPrepared(sql, params = [], { cacheTtl } = {}) {
  const safeParams = sanitizePreparedParams(params);
  if (cacheTtl !== undefined) {
    const key = `${sql}::${JSON.stringify(safeParams)}`;
    const hit = getCached(key);
    if (hit !== undefined) return hit;
    const rows = await _runPrepared(sql, safeParams);
    setCached(key, rows, cacheTtl);
    return rows;
  }
  return _runPrepared(sql, safeParams);
}

async function _runPrepared(sql, params) {
  const connection = await initDB();
  const stmt = await connection.prepare(sql);
  try {
    const result = await stmt.query(...params);
    return result.toArray();
  } finally {
    await stmt.close().catch(() => null);
  }
}

/**
 * Best-effort extraction of "rows affected" from a DuckDB-WASM DML result.
 * Returns `null` when the value cannot be determined safely — callers fall
 * back to assuming a change happened (the safe default for cache + event
 * invalidation). The output of DML statements is implementation-defined in
 * DuckDB-WASM and has changed shape across versions, so we never throw
 * from inspection.
 */
function extractRowsAffected(result) {
  if (!result) return null;
  try {
    const arr =
      typeof result.toArray === "function" ? result.toArray() : null;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const row = arr[0];
    if (row == null || typeof row !== "object") return null;
    // DuckDB historically uses `Count`; some bindings expose lowercase
    // `count`. BigInt comes through DuckDB-WASM for INTEGER aggregates.
    const raw = row.Count ?? row.count;
    if (raw == null) return null;
    if (typeof raw === "bigint") return Number(raw);
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  } catch {
    return null;
  }
  return null;
}

/**
 * Run a prepared write statement (INSERT/UPDATE/DELETE/etc.). Same lifetime
 * rules as `queryPrepared`. Honors the connection-level flush hook so the
 * connected file (if any) is persisted after the write.
 *
 * `scheduleSync: false` grava e avisa as telas, mas NÃO agenda o envio para
 * a nuvem: a linha sobe junto com a próxima alteração de verdade. Existe para
 * o registro de erros — ver `logError`. É diferente de `flush: false`, que
 * também cala o aviso às telas.
 */
export async function executePrepared(
  sql,
  params = [],
  { domains, flush = true, scheduleSync = true, source } = {},
) {
  const connection = await initDB();
  const stmt = await connection.prepare(sql);
  let rowsAffected = null;
  try {
    const result = await stmt.query(...sanitizePreparedParams(params));
    rowsAffected = extractRowsAffected(result);
  } finally {
    await stmt.close().catch(() => null);
  }

  // If DuckDB told us the write hit zero rows, skip the cache invalidation
  // AND the change event. Loops of UPDATE-then-UPDATE-then-... that no-op
  // (e.g. an idempotent backfill touching nothing) used to burn one cache
  // wipe + one event per call. When we can't determine the count we keep
  // the previous behaviour of always invalidating — safer to over-notify
  // than miss a real change.
  if (rowsAffected !== 0) {
    invalidateCache();
  }

  if (flush && transactionDepth === 0 && rowsAffected !== 0) {
    if (scheduleSync) {
      await flushAfterTransaction();
    }
    notifyDatabaseChanged(source || domains ? { source, domains } : undefined);
  }
}

export async function registerFileText(fileName, text) {
  await initDB();
  await db.registerFileText(fileName, text);
}

export async function releaseRegisteredFile(fileName) {
  if (!fileName) {
    return;
  }

  await initDB();
  await db.dropFile(fileName).catch(() => null);
}

export async function flushDatabase() {
  await initDB();
  await flushAfterTransaction();
}

export async function runInTransaction(
  callback,
  { changeDomains, emitChange = true, changeSource = "transaction" } = {},
) {
  await initDB();

  if (transactionDepth > 0) {
    return callback();
  }

  // A posse é marcada ANTES do BEGIN, e não depois.
  //
  // `await conn.query("BEGIN")` cede o controle. Com a marcação depois do
  // await, duas chamadas concorrentes passavam as duas pela checagem acima
  // enquanto nenhuma tinha marcado posse — a segunda emitia um BEGIN dentro
  // do BEGIN da primeira, o que o DuckDB rejeita. O erro não ficava contido:
  // ele aborta a transação em curso, então uma restauração de backup podia
  // morrer no meio por causa de uma consulta de tela disparada no mesmo
  // instante. Marcando antes, a segunda chamada cai no ramo de cima e roda
  // junto, que é o comportamento que o guard já pretendia.
  transactionDepth = 1;

  try {
    await conn.query("BEGIN TRANSACTION");
  } catch (error) {
    transactionDepth = 0;
    throw error;
  }

  try {
    const result = await callback();
    await conn.query("COMMIT");
    await flushAfterTransaction();
    if (emitChange) {
      notifyDatabaseChanged({ source: changeSource, domains: changeDomains });
    }
    return result;
  } catch (error) {
    await conn.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    transactionDepth = 0;
  }
}

export async function runStructuralReload() {
  await initDB();
  await runSchemaBootstrap(conn, { structural: false });
}
