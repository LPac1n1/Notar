import { getActiveProjectId } from "../activeProject.js";
import { donorBelongedToProjectAtMonth } from "../project/projectAssignmentSql.js";
import {
  buildTextSearchCondition,
  normalizeCpf,
  queryPrepared,
  startOfMonth,
} from "../db";
import {
  listAdjustmentsForMonth,
  listAllAdjustments,
} from "../abatementAdjustmentService";
import {
  MONTHLY_AUXILIARY_SUBSELECT,
  MONTHLY_DONOR_PROJECTION,
  MONTHLY_HOLDER_JOINS,
  MONTHLY_SEARCH_COLUMNS,
  MONTHLY_SOURCE_SUBSELECTS,
  applySummaryFilters,
  buildDonorConditions,
  mapDonorWithoutDonation,
  mapSummaryRow,
  markSubsumedRows,
  mergeAdjustmentsByMonth,
  sortSummariesByAbatement,
} from "./sharedFragments";
import { donorCountsAtMonth } from "./summaryScopeSql.js";

/**
 * Lists monthly summaries for a single reference month.
 *
 * Three queries fan out in `Promise.all`:
 *
 *   1. `donorRows`: every active donor (after donor-side filters), used to
 *      synthesize "no donation this month" rows for active donors that don't
 *      appear in `monthly_donor_summary`.
 *   2. `monthlyRows`: every existing summary row for the month, with the
 *      shared source subselects + holder joins.
 *   3. `importContextRows`: the latest processed import for the month, so
 *      synthesized rows can attribute the same value-per-note as real ones.
 *
 * Active donors merge with their summary row (or get a synthesized
 * "without-donation" placeholder); inactive summaries are tacked on when the
 * filter requests them. Adjustments are folded in last.
 */
export async function listMonthlySummariesByMonth({
  referenceMonth,
  donorId = "",
  donorType = "all",
  cpf = "",
  demand = "",
  abatementStatus = "all",
  donationActivity = "all",
  abatementSort = "",
  donationStartDate = "all",
  donorActiveStatus = "active",
  search = "",
} = {}) {
  const normalizedReferenceMonth = startOfMonth(referenceMonth);
  const { conditions: activeDonorConditions, params: activeDonorParams } =
    buildDonorConditions({
      donorId,
      donorType,
      cpf,
      demand,
      donationStartDate,
      donorActiveStatus: "active",
      referenceMonth: normalizedReferenceMonth,
      search,
    });
  // Recorte do projeto. Os dois ramos usam o mês da LINHA, não o vínculo
  // vigente: um doador transferido em abril continua com março na apuração
  // do projeto anterior.
  //
  // Aqui o mês é constante (é a consulta de um mês só), então entra como
  // parâmetro; a condição vai no fim para não desalinhar os params já
  // montados por `buildDonorConditions`.
  activeDonorConditions.push(
    donorBelongedToProjectAtMonth(
      "donors.id",
      "CAST(? AS DATE)",
      getActiveProjectId(),
    ),
  );
  activeDonorParams.push(normalizedReferenceMonth);

  const activeDonorWhereClause =
    activeDonorConditions.length > 0
      ? `WHERE ${activeDonorConditions.join(" AND ")}`
      : "";

  // The summary-side query filters `monthly_donor_summary` directly; reuse the
  // donor-condition predicates but narrow them to the month and the donor's
  // donor_type/cpf/demand. This is intentionally a parallel branch — the by-
  // month listing always ANDs `reference_month`, which the historical listing
  // doesn't.
  const monthlyRowsConditions = ["monthly_donor_summary.reference_month = ?"];
  const monthlyRowsParams = [normalizedReferenceMonth];

  // Do lado do resumo o mês é uma COLUNA, então não consome parâmetro.
  monthlyRowsConditions.push(
    donorBelongedToProjectAtMonth(
      "monthly_donor_summary.donor_id",
      "monthly_donor_summary.reference_month",
      getActiveProjectId(),
    ),
  );

  // "Ativo" é em relação ao mês da linha: o doador desativado depois deste
  // mês continua aqui. As duas consultas usam a mesma regra — se divergirem,
  // o doador entra por uma e some pela outra.
  const countsThisMonth = donorCountsAtMonth(
    "monthly_donor_summary.reference_month",
  );

  if (donorActiveStatus === "active") {
    monthlyRowsConditions.push(countsThisMonth);
  } else if (donorActiveStatus === "inactive") {
    monthlyRowsConditions.push(`NOT ${countsThisMonth}`);
  }

  if (donorId.trim()) {
    monthlyRowsConditions.push("donors.id = ?");
    monthlyRowsParams.push(donorId.trim());
  }

  if (cpf.trim()) {
    monthlyRowsConditions.push(`
      EXISTS (
        SELECT 1
        FROM donor_cpf_links
        WHERE donor_cpf_links.donor_id = donors.id
          AND donor_cpf_links.is_active = TRUE
          AND donor_cpf_links.cpf = ?
      )
    `);
    monthlyRowsParams.push(normalizeCpf(cpf));
  }

  if (demand.trim()) {
    monthlyRowsConditions.push("lower(coalesce(donors.demand, '')) = lower(?)");
    monthlyRowsParams.push(demand.trim());
  }

  // Mesma cobertura de busca da query de doadores acima — as duas precisam
  // concordar, senão um doador apareceria numa e sumiria na outra.
  const monthlySearchCondition = buildTextSearchCondition(
    search,
    MONTHLY_SEARCH_COLUMNS,
  );

  if (monthlySearchCondition) {
    monthlyRowsConditions.push(monthlySearchCondition.condition);
    monthlyRowsParams.push(...monthlySearchCondition.params);
  }

  const [donorRows, monthlyRows, importContextRows] = await Promise.all([
    queryPrepared(
      `
        SELECT
          donors.id,
          donors.name,
          donors.cpf,
          donors.demand,
          donors.donor_type,
          donors.holder_donor_id,
          donors.holder_person_id,
          holder_people.name AS holder_name,
          holder_people.cpf AS holder_cpf,
          holder_active_donors.id AS active_holder_donor_id,
          strftime(donors.donation_start_date, '%Y-%m-%d') AS donation_start_date,
          ${MONTHLY_AUXILIARY_SUBSELECT},
          coalesce((
            SELECT string_agg(DISTINCT donor_cpf_links.cpf, ',')
            FROM donor_cpf_links
            WHERE donor_cpf_links.donor_id = donors.id
              AND donor_cpf_links.is_active = TRUE
          ), '') AS source_cpfs,
          coalesce((
            SELECT string_agg(
              source_rows.source_name || '|' ||
              source_rows.source_cpf || '|' ||
              source_rows.source_type || '|0',
              ';;'
            )
            FROM (
              SELECT
                donor_cpf_links.name AS source_name,
                donor_cpf_links.cpf AS source_cpf,
                donor_cpf_links.link_type AS source_type
              FROM donor_cpf_links
              WHERE donor_cpf_links.donor_id = donors.id
                AND donor_cpf_links.is_active = TRUE
              ORDER BY
                CASE WHEN donor_cpf_links.link_type = 'holder' THEN 0 ELSE 1 END,
                donor_cpf_links.name ASC
            ) AS source_rows
          ), '') AS source_details,
          coalesce((
            SELECT count(*)
            FROM donor_cpf_links
            WHERE donor_cpf_links.donor_id = donors.id
              AND donor_cpf_links.is_active = TRUE
          ), 0) AS source_cpf_count,
          coalesce((
            SELECT sum(coalesce(import_cpf_summary.invalid_notes_count, 0))
            FROM import_cpf_summary
            INNER JOIN donor_cpf_links
              ON donor_cpf_links.id = import_cpf_summary.matched_source_id
            WHERE donor_cpf_links.donor_id = donors.id
              AND donor_cpf_links.is_active = TRUE
              AND import_cpf_summary.reference_month = ?
          ), 0) AS invalid_notes_count
        FROM donors
        LEFT JOIN people AS holder_people
          ON holder_people.id = donors.holder_person_id
        LEFT JOIN donors AS holder_active_donors
          ON holder_active_donors.person_id = donors.holder_person_id
          AND holder_active_donors.donor_type = 'holder'
          AND holder_active_donors.is_active = TRUE
        ${activeDonorWhereClause}
        ORDER BY donors.name ASC
      `,
      [normalizedReferenceMonth, ...activeDonorParams],
    ),
    queryPrepared(
      `
        SELECT
          monthly_donor_summary.id,
          monthly_donor_summary.import_id,
          monthly_donor_summary.donor_id,
          strftime(monthly_donor_summary.reference_month, '%Y-%m-%d') AS reference_month,
          monthly_donor_summary.cpf,
          monthly_donor_summary.donor_name,
          monthly_donor_summary.demand,
          monthly_donor_summary.notes_count,
          coalesce(monthly_donor_summary.invalid_notes_count, 0) AS invalid_notes_count,
          monthly_donor_summary.value_per_note,
          monthly_donor_summary.abatement_amount,
          monthly_donor_summary.abatement_status,
          strftime(monthly_donor_summary.abatement_marked_at, '%Y-%m-%d %H:%M:%S') AS abatement_marked_at,
          ${MONTHLY_DONOR_PROJECTION},
          ${MONTHLY_SOURCE_SUBSELECTS}
        FROM monthly_donor_summary
        INNER JOIN donors
          ON donors.id = monthly_donor_summary.donor_id
        ${MONTHLY_HOLDER_JOINS}
        WHERE ${monthlyRowsConditions.join(" AND ")}
        ORDER BY monthly_donor_summary.donor_name ASC
      `,
      monthlyRowsParams,
    ),
    queryPrepared(
      `
        SELECT
          id,
          value_per_note
        FROM imports
        WHERE status = 'processed'
          AND reference_month = ?
        ORDER BY imported_at DESC
        LIMIT 1
      `,
      [normalizedReferenceMonth],
    ),
  ]);

  const summaryByDonorId = new Map(
    monthlyRows.map((row) => [row.donor_id, mapSummaryRow(row)]),
  );
  const activeDonorIds = new Set(donorRows.map((r) => r.id));
  const monthValuePerNote = Number(importContextRows[0]?.value_per_note ?? 0);

  const activeMerged = donorRows.map(
    (row) =>
      summaryByDonorId.get(row.id) ??
      mapDonorWithoutDonation(row, {
        referenceMonth: normalizedReferenceMonth,
        valuePerNote: monthValuePerNote,
      }),
  );

  const inactiveSummaries =
    donorActiveStatus !== "active"
      ? monthlyRows
          .filter((row) => !activeDonorIds.has(row.donor_id))
          .map(mapSummaryRow)
      : [];

  const baseRows =
    donorActiveStatus === "inactive"
      ? inactiveSummaries
      : [...activeMerged, ...inactiveSummaries];

  // Fetch both the same-month adjustments (for merging) and all adjustments
  // (for subsumed detection) in parallel — they share no data dependency.
  const [adjustments, allAdjustments] = await Promise.all([
    listAdjustmentsForMonth(normalizedReferenceMonth),
    listAllAdjustments(),
  ]);
  const mergedRows = mergeAdjustmentsByMonth(baseRows, adjustments);
  const taggedRows = markSubsumedRows(mergedRows, allAdjustments);

  return sortSummariesByAbatement(
    applySummaryFilters(taggedRows, {
      abatementStatus,
      donationActivity,
    }),
    abatementSort,
  );
}
