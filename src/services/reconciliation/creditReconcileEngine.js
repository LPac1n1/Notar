import {
  execute,
  notifyDatabaseChanged,
  query,
  runInTransaction,
} from "../db";
import { CREDIT_RECONCILE_STATEMENTS } from "./creditReconcileSql.js";

/**
 * O motor de reconstrucao do `credit_reconciliation`.
 *
 * Separado do resto porque e a unica parte que ESCREVE: todo o restante
 * do dominio apenas le o que este arquivo produziu.
 */

/**
 * Rebuilds the `credit_reconciliation` table from scratch by joining
 * `donation_notes` against `credit_notes` on the canonical match key
 * `<cnpj_estabelecimento>|<numero_nota>` (digits-only) plus `valor_cents`
 * for the strict-equality check.
 *
 * Output is one row per source note, never duplicated:
 *
 *   - `duplicate_donation` — same match_key appears multiple times on
 *                            the donations side.
 *   - `duplicate_credit`   — same match_key appears multiple times on the
 *                            credits side.
 *   - `matched`            — credit ↔ donation by match_key AND valor_cents.
 *   - `divergent`          — same match_key on both sides, but valor_cents
 *                            differs. Surfaced so the user can investigate
 *                            an apparent same-nota inconsistency.
 *   - `credit_only`        — credit with no donation counterpart.
 *   - `donation_only`      — donation with no credit counterpart.
 *
 * Why the duplicate buckets come first: a note that collides on the match
 * key is ambiguous — pairing it to one specific counterpart would be
 * arbitrary and hide a data problem. We surface it instead so the user
 * fixes the source data before relying on the totals.
 *
 * Both sides only count rows with `is_valid = TRUE` (invalid donation status
 * or non-"calculado" credit situation are excluded). Idempotent: subsequent
 * runs always produce the same end state for the same inputs.
 */
export async function reconcileCredits({ emitChange = true } = {}) {
  // Diagnostic — when matches refuse to appear, we want to see exactly
  // which side carries data. `matchable` counts rows whose match_key has
  // both halves populated (cnpj + numero); empty halves disqualify the row
  // from every bucket except orphans/duplicates of empty keys.
  const [donationStats] = await query(`
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE is_valid = TRUE) AS valid,
      count(*) FILTER (
        WHERE is_valid = TRUE
          AND match_key IS NOT NULL
          AND match_key <> ''
          AND match_key NOT LIKE '%|'
          AND match_key NOT LIKE '|%'
      ) AS matchable
    FROM donation_notes
  `);
  const [creditStats] = await query(`
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE is_valid = TRUE) AS valid,
      count(*) FILTER (
        WHERE is_valid = TRUE
          AND match_key IS NOT NULL
          AND match_key <> ''
          AND match_key NOT LIKE '%|'
          AND match_key NOT LIKE '|%'
      ) AS matchable
    FROM credit_notes
  `);
  // Só reporta quando há o que reportar. A conciliação roda uma vez em toda
  // abertura do sistema, logo depois das migrations, sobre um banco ainda
  // vazio — sem esta condição o console abria toda sessão com dois registros
  // de zeros, e o diagnóstico ficava afogado no próprio ruído.
  const temAlgoParaConciliar =
    Number(donationStats?.total ?? 0) > 0 || Number(creditStats?.total ?? 0) > 0;

  if (import.meta.env.DEV && temAlgoParaConciliar) {
    console.log("[reconcileCredits] inputs:", {
      donations: {
        total: Number(donationStats?.total ?? 0),
        valid: Number(donationStats?.valid ?? 0),
        matchable: Number(donationStats?.matchable ?? 0),
      },
      credits: {
        total: Number(creditStats?.total ?? 0),
        valid: Number(creditStats?.valid ?? 0),
        matchable: Number(creditStats?.matchable ?? 0),
      },
    });
  }

  await runInTransaction(
    async () => {
      // As instruções e a ordem delas vivem em `creditReconcileSql.js`, para
      // o teste de integração rodar exatamente o que roda aqui.
      for (const statement of CREDIT_RECONCILE_STATEMENTS) {
        await execute(statement);
      }
    },
    { emitChange: false },
  );

  // After-pass diagnostic — most informative single line for "why didn't
  // it match?". If `matched === 0` while both sides are matchable on input,
  // the keys differ between the two tables.
  const breakdown = await query(`
    SELECT match_status, count(*) AS total
    FROM credit_reconciliation
    GROUP BY match_status
  `);
  const counts = breakdown.reduce((acc, row) => {
    acc[String(row.match_status)] = Number(row.total ?? 0);
    return acc;
  }, {});
  // Mesma condição da entrada: sem nota nenhum dos dois lados, o resultado é
  // um objeto vazio que não diz nada.
  if (import.meta.env.DEV && temAlgoParaConciliar) {
    console.log("[reconcileCredits] result:", counts);
  }

  if (emitChange) {
    notifyDatabaseChanged({ source: "reconcile-credits" });
  }
}
