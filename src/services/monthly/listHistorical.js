import { getActiveProjectId } from "../activeProject.js";
import { donorBelongedToProjectAtMonth } from "../project/projectAssignmentSql.js";
import {
  buildTextSearchCondition,
  normalizeCpf,
  queryPrepared,
  startOfMonth,
} from "../db";
import { listAllAdjustments } from "../abatementAdjustmentService";
import {
  MONTHLY_DONOR_PROJECTION,
  MONTHLY_HOLDER_JOINS,
  MONTHLY_SEARCH_COLUMNS,
  MONTHLY_SOURCE_SUBSELECTS,
  applySummaryFilters,
  findOrphanAdjustments,
  mapSummaryRow,
  markSubsumedRows,
  mergeAdjustmentsByMonth,
  sortSummariesByAbatement,
  synthesizeAdjustmentOnlyRow,
} from "./sharedFragments";
import {
  donorCountsAtMonth,
  donorCountsAtMonthValue,
  lastDeactivationMonthOf,
} from "./summaryScopeSql.js";

/**
 * Fetches donor metadata for a set of donor ids. Used to synthesize orphan-
 * adjustment rows: when a catch-up references a month with no monthly_donor_summary
 * row, we still need donor name/CPF/holder context to render and total it.
 */
async function fetchDonorContextById(donorIds) {
  if (!donorIds || donorIds.length === 0) return new Map();
  const placeholders = donorIds.map(() => "?").join(", ");
  const rows = await queryPrepared(
    `
      SELECT
        donors.id,
        donors.name AS donor_name,
        donors.cpf,
        donors.demand,
        donors.donor_type,
        donors.holder_donor_id,
        donors.holder_person_id,
        donors.is_active,
        donors.donation_start_date,
        strftime(donors.donation_start_date, '%Y-%m-%d') AS donation_start_date_iso,
        strftime(${lastDeactivationMonthOf("donors.id")}, '%Y-%m-01') AS last_deactivation_month,
        holder_people.name AS holder_name,
        holder_people.cpf AS holder_cpf,
        holder_active_donors.id AS active_holder_donor_id
      FROM donors
      LEFT JOIN people AS holder_people
        ON holder_people.id = donors.holder_person_id
      LEFT JOIN donors AS holder_active_donors
        ON holder_active_donors.person_id = donors.holder_person_id
        AND holder_active_donors.donor_type = 'holder'
        AND holder_active_donors.is_active = TRUE
      WHERE donors.id IN (${placeholders})
    `,
    donorIds,
  );
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Lists every monthly summary across history (no required reference month).
 *
 * Differs from `listMonthlySummariesByMonth` in that it never synthesizes
 * "no donation" rows — historical view only shows entries that actually
 * landed in `monthly_donor_summary`. The donors join is LEFT instead of INNER
 * because we want to surface rows even if the donor was later deleted.
 *
 * Donor-side conditions (id/type/start date) live alongside summary-side
 * conditions (reference_month, cpf-via-EXISTS, demand) in a single WHERE; the
 * shared fragments still produce identical projections to the by-month
 * variant.
 */
export async function listHistoricalMonthlySummaries({
  referenceMonth = "",
  referenceMonths = [],
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
  const conditions = [
    // Cada linha é um mês diferente, então o recorte usa a coluna de mês
    // da própria linha: a visão histórica de um projeto mostra os meses em
    // que o doador era dele, e só esses.
    donorBelongedToProjectAtMonth(
      "monthly_donor_summary.donor_id",
      "monthly_donor_summary.reference_month",
      getActiveProjectId(),
    ),
  ];
  const params = [];

  const searchCondition = buildTextSearchCondition(
    search,
    MONTHLY_SEARCH_COLUMNS,
  );

  if (searchCondition) {
    conditions.push(searchCondition.condition);
    params.push(...searchCondition.params);
  }

  // "Ativo" é em relação ao mês de CADA linha: o doador desativado em maio
  // continua com os meses anteriores aqui.
  const countsThatMonth = donorCountsAtMonth(
    "monthly_donor_summary.reference_month",
  );

  if (donorActiveStatus === "active") {
    // The coalesce keeps legacy rows where `donors` was deleted (and the join
    // produces NULL) — the historical view is meant to be the long-term
    // ledger, including for donors no longer registered.
    conditions.push(
      `(coalesce(donors.is_active, TRUE) = TRUE OR ${countsThatMonth})`,
    );
  } else if (donorActiveStatus === "inactive") {
    conditions.push(`(donors.is_active = FALSE AND NOT ${countsThatMonth})`);
  }

  if (referenceMonth) {
    conditions.push("monthly_donor_summary.reference_month = ?");
    params.push(startOfMonth(referenceMonth));
  }

  // Recorte por VÁRIOS meses — a seleção múltipla da Gestão Mensal. Cada linha
  // já é um mês, então o conjunto entra como IN e o resto da função (merge de
  // acumulado, subsunção, ordenação) continua valendo sem ramo novo.
  const normalizedMonths = Array.from(
    new Set(
      (referenceMonths ?? [])
        .map((month) => startOfMonth(month))
        .filter(Boolean),
    ),
  );

  if (normalizedMonths.length > 0) {
    conditions.push(
      `monthly_donor_summary.reference_month IN (${normalizedMonths
        .map(() => "?")
        .join(", ")})`,
    );
    params.push(...normalizedMonths);
  }

  if (donorId.trim()) {
    conditions.push("monthly_donor_summary.donor_id = ?");
    params.push(donorId.trim());
  }

  if (donorType === "holder" || donorType === "auxiliary") {
    conditions.push("donors.donor_type = ?");
    params.push(donorType);
  }

  if (donationStartDate === "with-date") {
    conditions.push("donors.donation_start_date IS NOT NULL");
  }

  if (donationStartDate === "without-date") {
    conditions.push("donors.donation_start_date IS NULL");
  }

  if (cpf.trim()) {
    conditions.push(`
      EXISTS (
        SELECT 1
        FROM import_cpf_summary
        WHERE import_cpf_summary.import_id = monthly_donor_summary.import_id
          AND import_cpf_summary.matched_donor_id = monthly_donor_summary.donor_id
          AND import_cpf_summary.cpf = ?
      )
    `);
    params.push(normalizeCpf(cpf));
  }

  if (demand.trim()) {
    conditions.push(
      "lower(coalesce(monthly_donor_summary.demand, '')) = lower(?)",
    );
    params.push(demand.trim());
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await queryPrepared(
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
      LEFT JOIN donors
        ON donors.id = monthly_donor_summary.donor_id
      ${MONTHLY_HOLDER_JOINS}
      ${whereClause}
      ORDER BY monthly_donor_summary.reference_month DESC, monthly_donor_summary.donor_name ASC
    `,
    params,
  );

  const adjustments = await listAllAdjustments();
  const baseRows = rows.map(mapSummaryRow);
  const mergedRows = mergeAdjustmentsByMonth(baseRows, adjustments);
  const taggedRows = markSubsumedRows(mergedRows, adjustments);

  // Synthesize rows for catch-ups whose reference month has no underlying
  // monthly_donor_summary entry. Without this the catch-up amount silently
  // disappears from totals, which causes the gestão mensal numbers to look
  // wrong after a catch-up is created on a month the donor didn't import.
  const orphanAdjustments = findOrphanAdjustments(taggedRows, adjustments);
  let orphanRows = [];
  if (orphanAdjustments.length > 0) {
    const orphanDonorIds = Array.from(
      new Set(orphanAdjustments.map((adj) => adj.donorId).filter(Boolean)),
    );
    const donorContextById = await fetchDonorContextById(orphanDonorIds);
    const normalizedReferenceMonth = referenceMonth
      ? startOfMonth(referenceMonth)
      : "";
    const normalizedCpf = cpf.trim() ? normalizeCpf(cpf) : "";
    const normalizedDemand = demand.trim() ? demand.trim().toLowerCase() : "";

    orphanRows = orphanAdjustments
      .map((adjustment) => {
        const donor = donorContextById.get(adjustment.donorId);
        if (!donor) return null;

        // Apply the same donor-side filters used in the SQL WHERE so orphan
        // rows respect filters like donorActiveStatus, donorType, demand etc.
        // "Ativo" é no mês do acumulado, pela mesma regra do WHERE.
        const donorActive = donorCountsAtMonthValue(
          {
            isActive: donor.is_active,
            lastDeactivationMonth: donor.last_deactivation_month,
          },
          adjustment.referenceMonth,
        );
        if (donorActiveStatus === "active" && !donorActive) return null;
        if (donorActiveStatus === "inactive" && donorActive) return null;
        if (donorId.trim() && donor.id !== donorId.trim()) return null;
        if (donorType !== "all" && donor.donor_type !== donorType) return null;
        if (
          normalizedReferenceMonth &&
          adjustment.referenceMonth !== normalizedReferenceMonth
        )
          return null;
        // Mesmo recorte do WHERE: sem isto, um acumulado lançado num mês fora
        // da seleção entraria como linha sintética e somaria no total exibido.
        if (
          normalizedMonths.length > 0 &&
          !normalizedMonths.includes(adjustment.referenceMonth)
        )
          return null;
        if (normalizedCpf && donor.cpf !== normalizedCpf) return null;
        if (
          normalizedDemand &&
          String(donor.demand ?? "").toLowerCase() !== normalizedDemand
        )
          return null;
        if (
          donationStartDate === "with-date" &&
          !donor.donation_start_date_iso
        )
          return null;
        if (
          donationStartDate === "without-date" &&
          donor.donation_start_date_iso
        )
          return null;

        return synthesizeAdjustmentOnlyRow(adjustment, {
          cpf: donor.cpf ?? "",
          donorName: donor.donor_name ?? "",
          demand: donor.demand ?? "",
          donorType: donor.donor_type === "auxiliary" ? "auxiliary" : "holder",
          donorTypeLabel:
            donor.donor_type === "auxiliary" ? "Auxiliar" : "Titular",
          holderDonorId:
            donor.active_holder_donor_id ?? donor.holder_donor_id ?? "",
          holderPersonId: donor.holder_person_id ?? "",
          holderName: donor.holder_name ?? "",
          holderCpf: donor.holder_cpf ?? "",
          holderIsActiveDonor: Boolean(donor.active_holder_donor_id),
          donationStartDate: donor.donation_start_date_iso ?? "",
        });
      })
      .filter(Boolean);
  }

  const combinedRows = [...taggedRows, ...orphanRows].sort((left, right) => {
    const monthDiff = String(right.referenceMonth ?? "").localeCompare(
      String(left.referenceMonth ?? ""),
    );
    if (monthDiff !== 0) return monthDiff;
    return String(left.donorName ?? "").localeCompare(
      String(right.donorName ?? ""),
      "pt-BR",
    );
  });

  return sortSummariesByAbatement(
    applySummaryFilters(combinedRows, {
      abatementStatus,
      donationActivity,
    }),
    abatementSort,
  );
}
