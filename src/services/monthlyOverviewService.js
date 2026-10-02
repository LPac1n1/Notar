import { getActiveProjectId } from "./activeProject.js";
import {
  summaryBelongsToProject,
  summaryIsActionable,
} from "./monthly/summaryScopeSql.js";
import { query } from "./db";

/**
 * Returns a per-month overview joining the three pillars of the
 * donations × credits workflow: the donation spreadsheet that landed,
 * the credit spreadsheet that landed, and the reconciliation totals
 * between them. Used by the unified "Visão por mês" section on the
 * Imports page (Sprint 3 / P1.1) so the user sees, at a glance, which
 * months are fully reconciled and which still need work.
 *
 * The function runs four small queries instead of one giant join — easier
 * to reason about and faster on DuckDB-WASM since each subquery hits its
 * own indexes and the reduce in JS is trivial. Returns one row per month
 * even when only one of the two sides has been imported.
 */
export async function getMonthlyImportsOverview() {
  // Each query returns rows keyed by reference_month so we can merge them
  // in JS without worrying about NULLs from LEFT JOINs.
  const [
    donationImports,
    creditImports,
    reconciliationByMonth,
    abatementByMonth,
  ] = await Promise.all([
    query(`
      SELECT
        i.id,
        strftime(i.reference_month, '%Y-%m-01') AS reference_month,
        i.file_name,
        i.status,
        i.value_per_note,
        strftime(i.imported_at, '%Y-%m-%d %H:%M:%S') AS imported_at,
        count(dn.id) AS total_notes,
        count(dn.id) FILTER (WHERE dn.is_valid = TRUE) AS valid_notes
      FROM imports i
      LEFT JOIN donation_notes dn ON dn.import_id = i.id
      GROUP BY i.id, i.reference_month, i.file_name, i.status,
               i.value_per_note, i.imported_at
    `),
    query(`
      SELECT
        ci.id,
        strftime(ci.reference_month, '%Y-%m-01') AS reference_month,
        ci.file_name,
        ci.status,
        ci.total_rows,
        ci.valid_rows,
        strftime(ci.imported_at, '%Y-%m-%d %H:%M:%S') AS imported_at
      FROM credit_imports ci
    `),
    // Reconciliation rows can be classified by either side. We coalesce
    // donations' reference_month with credits' reference_month so
    // credit_only/duplicate_credit rows still group under their month
    // even when no donation exists yet.
    query(`
      SELECT
        coalesce(
          strftime(dn.reference_month, '%Y-%m-01'),
          strftime(ci.reference_month, '%Y-%m-01')
        ) AS reference_month,
        count(*) FILTER (WHERE cr.match_status = 'matched') AS matched,
        count(*) FILTER (WHERE cr.match_status = 'divergent') AS divergent,
        count(*) FILTER (WHERE cr.match_status = 'credit_only') AS credit_only,
        count(*) FILTER (WHERE cr.match_status = 'donation_only') AS donation_only,
        count(*) FILTER (
          WHERE cr.match_status IN ('duplicate_credit', 'duplicate_donation')
        ) AS duplicates,
        sum(coalesce(cn.credito, 0)) FILTER (WHERE cr.match_status = 'matched')
          AS matched_credit_value
      FROM credit_reconciliation cr
      LEFT JOIN donation_notes dn ON dn.id = cr.donation_note_id
      LEFT JOIN credit_notes cn ON cn.id = cr.credit_note_id
      LEFT JOIN credit_imports ci ON ci.id = cn.credit_import_id
      WHERE coalesce(
        strftime(dn.reference_month, '%Y-%m-01'),
        strftime(ci.reference_month, '%Y-%m-01')
      ) IS NOT NULL
      GROUP BY 1
    `),
    // Abatimento por mês, com a MESMA definição de "pendente" que a Gestão
    // Mensal usa na tela. Duas exclusões são obrigatórias, senão a visão de
    // Importações acusa pendência em mês que o usuário já fechou e não tem
    // como fechar de novo:
    //
    //   • linhas sem nota no mês (`notes_count = 0`) — a Gestão Mensal mostra
    //     "Sem doações no mês" e nem oferece o botão; não é trabalho pendente.
    //
    //   • linhas cobertas por um acumulado lançado em OUTRO mês — na tela elas
    //     aparecem como "Via acumulado" com o toggle desabilitado (ver
    //     `markSubsumedRows`), porque o valor já foi abatido junto do mês do
    //     acumulado. O `abatement_status` cru delas continua 'pending' para
    //     sempre, então contá-lo aqui gerava pendência impossível de resolver.
    //
    // `total_applied` também passou a filtrar por status: antes somava
    // `abatement_amount` de todas as linhas (contrariando o próprio
    // comentário), inflando o "Abatido" comparado ao crédito real.
    query(`
      SELECT
        strftime(mds.reference_month, '%Y-%m-01') AS reference_month,
        coalesce(sum(
          CASE WHEN mds.abatement_status = 'applied'
            THEN mds.abatement_amount ELSE 0 END
        ), 0) AS total_applied,
        coalesce(sum(
          CASE WHEN mds.abatement_status = 'pending' AND mds.is_actionable
            THEN mds.abatement_amount ELSE 0 END
        ), 0) AS total_pending,
        count(*) FILTER (
          WHERE mds.abatement_status = 'pending' AND mds.is_actionable
        ) AS pending_count,
        count(*) FILTER (WHERE mds.abatement_status = 'applied') AS applied_count
      FROM (
        SELECT
          monthly_donor_summary.reference_month,
          monthly_donor_summary.abatement_status,
          monthly_donor_summary.abatement_amount,
          ${summaryIsActionable()} AS is_actionable
        FROM monthly_donor_summary
        -- O rollup de abatimento é do projeto que apura. Sem o recorte,
        -- a visão por mês somaria as pendências de todos os projetos.
        WHERE ${summaryBelongsToProject(getActiveProjectId())}
      ) AS mds
      GROUP BY mds.reference_month
    `),
  ]);

  // Index each result set by month so the final merge is O(months).
  const donationByMonth = new Map();
  for (const row of donationImports) {
    if (!row.reference_month) continue;
    donationByMonth.set(row.reference_month, {
      id: row.id,
      fileName: row.file_name ?? "",
      status: row.status ?? "",
      valuePerNote: Number(row.value_per_note ?? 0),
      importedAt: row.imported_at ?? "",
      totalNotes: Number(row.total_notes ?? 0),
      validNotes: Number(row.valid_notes ?? 0),
    });
  }

  const creditByMonth = new Map();
  for (const row of creditImports) {
    if (!row.reference_month) continue;
    creditByMonth.set(row.reference_month, {
      id: row.id,
      fileName: row.file_name ?? "",
      status: row.status ?? "",
      totalRows: Number(row.total_rows ?? 0),
      validRows: Number(row.valid_rows ?? 0),
      importedAt: row.imported_at ?? "",
    });
  }

  const reconciliationMap = new Map();
  for (const row of reconciliationByMonth) {
    if (!row.reference_month) continue;
    reconciliationMap.set(row.reference_month, {
      matched: Number(row.matched ?? 0),
      divergent: Number(row.divergent ?? 0),
      creditOnly: Number(row.credit_only ?? 0),
      donationOnly: Number(row.donation_only ?? 0),
      duplicates: Number(row.duplicates ?? 0),
      matchedCreditValue: Number(row.matched_credit_value ?? 0),
    });
  }

  const abatementMap = new Map();
  for (const row of abatementByMonth) {
    if (!row.reference_month) continue;
    abatementMap.set(row.reference_month, {
      totalApplied: Number(row.total_applied ?? 0),
      totalPending: Number(row.total_pending ?? 0),
      pendingCount: Number(row.pending_count ?? 0),
      appliedCount: Number(row.applied_count ?? 0),
    });
  }

  const allMonths = new Set([
    ...donationByMonth.keys(),
    ...creditByMonth.keys(),
    ...reconciliationMap.keys(),
    ...abatementMap.keys(),
  ]);

  // Sort newest first — matches the rest of the imports UI.
  const sortedMonths = Array.from(allMonths).sort((a, b) =>
    a < b ? 1 : a > b ? -1 : 0,
  );

  return sortedMonths.map((referenceMonth) => ({
    referenceMonth,
    donationImport: donationByMonth.get(referenceMonth) ?? null,
    creditImport: creditByMonth.get(referenceMonth) ?? null,
    reconciliation:
      reconciliationMap.get(referenceMonth) ?? {
        matched: 0,
        divergent: 0,
        creditOnly: 0,
        donationOnly: 0,
        duplicates: 0,
        matchedCreditValue: 0,
      },
    abatement:
      abatementMap.get(referenceMonth) ?? {
        totalApplied: 0,
        totalPending: 0,
        pendingCount: 0,
        appliedCount: 0,
      },
  }));
}
