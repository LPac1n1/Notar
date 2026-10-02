import { buildTextSearchCondition, normalizeCpf } from "../db";
import { donorCountsAtMonth } from "./summaryScopeSql.js";

/**
 * Source-aggregation subselects shared between the by-month and historical
 * monthly listings. They project four metadata columns per
 * `monthly_donor_summary` row:
 *
 *   - source_cpfs:                 distinct CPFs that contributed to the row
 *   - source_details:              "name|cpf|type|notes" tuples (titular first)
 *   - source_cpf_count:            distinct CPF count
 *   - source_start_conflict_count: appearances before donor's start date
 *
 * Defined here as a constant so the two listings stay in sync — any change to
 * these subselects automatically applies to both code paths.
 */
export const MONTHLY_SOURCE_SUBSELECTS = `
  coalesce((
    SELECT string_agg(DISTINCT import_cpf_summary.cpf, ',')
    FROM import_cpf_summary
    WHERE import_cpf_summary.import_id = monthly_donor_summary.import_id
      AND import_cpf_summary.matched_donor_id = monthly_donor_summary.donor_id
  ), '') AS source_cpfs,
  coalesce((
    SELECT string_agg(
      source_rows.source_name || '|' ||
      source_rows.source_cpf || '|' ||
      source_rows.source_type || '|' ||
      CAST(source_rows.source_notes AS VARCHAR),
      ';;'
    )
    FROM (
      SELECT
        donor_cpf_links.name AS source_name,
        donor_cpf_links.cpf AS source_cpf,
        donor_cpf_links.link_type AS source_type,
        sum(import_cpf_summary.notes_count) AS source_notes
      FROM import_cpf_summary
      INNER JOIN donor_cpf_links
        ON donor_cpf_links.id = import_cpf_summary.matched_source_id
      WHERE import_cpf_summary.import_id = monthly_donor_summary.import_id
        AND import_cpf_summary.matched_donor_id = monthly_donor_summary.donor_id
      GROUP BY
        donor_cpf_links.name,
        donor_cpf_links.cpf,
        donor_cpf_links.link_type
      ORDER BY
        CASE WHEN donor_cpf_links.link_type = 'holder' THEN 0 ELSE 1 END,
        donor_cpf_links.name ASC
    ) AS source_rows
  ), '') AS source_details,
  coalesce((
    SELECT count(DISTINCT import_cpf_summary.cpf)
    FROM import_cpf_summary
    WHERE import_cpf_summary.import_id = monthly_donor_summary.import_id
      AND import_cpf_summary.matched_donor_id = monthly_donor_summary.donor_id
  ), 0) AS source_cpf_count,
  coalesce((
    SELECT count(*)
    FROM import_cpf_summary
    INNER JOIN donor_cpf_links
      ON donor_cpf_links.id = import_cpf_summary.matched_source_id
    WHERE import_cpf_summary.import_id = monthly_donor_summary.import_id
      AND import_cpf_summary.matched_donor_id = monthly_donor_summary.donor_id
      AND donor_cpf_links.donation_start_date IS NOT NULL
      AND import_cpf_summary.reference_month < donor_cpf_links.donation_start_date
  ), 0) AS source_start_conflict_count
`;

/**
 * Holder lookup chain shared by both listings. Two left joins:
 *
 *   - `holder_people`: the human-record currently registered as the holder
 *     (used for the displayed name/CPF, even if no active donor exists).
 *   - `holder_active_donors`: the *active* donor whose `person_id` matches
 *     so navigation links surface only when the holder is still a donor.
 */
export const MONTHLY_HOLDER_JOINS = `
  LEFT JOIN people AS holder_people
    ON holder_people.id = donors.holder_person_id
  LEFT JOIN donors AS holder_active_donors
    ON holder_active_donors.person_id = donors.holder_person_id
    AND holder_active_donors.donor_type = 'holder'
    AND holder_active_donors.is_active = TRUE
`;

/**
 * Auxiliaries attached to the row's donor, as "name|cpf" tuples.
 *
 * Only ever non-empty for holders: auxiliaries point at their holder through
 * `holder_person_id`, and `ensurePersonCanBeAuxiliary` blocks a person that
 * already has auxiliaries from becoming one, so the chain never nests.
 *
 * Correlates on `donors.person_id`, so every query embedding this must have
 * `donors` in scope under that exact alias.
 */
export const MONTHLY_AUXILIARY_SUBSELECT = `
  coalesce((
    SELECT string_agg(aux_rows.aux_name || '|' || aux_rows.aux_cpf, ';;')
    FROM (
      SELECT
        auxiliary_donors.name AS aux_name,
        auxiliary_donors.cpf AS aux_cpf
      FROM donors AS auxiliary_donors
      WHERE auxiliary_donors.holder_person_id = donors.person_id
        AND auxiliary_donors.donor_type = 'auxiliary'
        AND auxiliary_donors.is_active = TRUE
      ORDER BY auxiliary_donors.name ASC
    ) AS aux_rows
  ), '') AS auxiliary_details
`;

/**
 * Donor metadata columns projected by both listings. Excludes the
 * `monthly_donor_summary` core columns (id, donor_id, etc.) which differ in
 * how the two queries select them.
 */
export const MONTHLY_DONOR_PROJECTION = `
  donors.donor_type,
  donors.holder_donor_id,
  donors.holder_person_id,
  holder_people.name AS holder_name,
  holder_people.cpf AS holder_cpf,
  holder_active_donors.id AS active_holder_donor_id,
  strftime(donors.donation_start_date, '%Y-%m-%d') AS donation_start_date,
  ${MONTHLY_AUXILIARY_SUBSELECT}
`;

export function parseSourceCpfs(value) {
  return String(value ?? "")
    .split(",")
    .map((cpfValue) => cpfValue.trim())
    .filter(Boolean);
}

export function parseAuxiliaries(value) {
  return String(value ?? "")
    .split(";;")
    .map((entry) => {
      const [name = "", cpfValue = ""] = entry.split("|");
      return { name, cpf: cpfValue };
    })
    .filter((auxiliary) => auxiliary.name || auxiliary.cpf);
}

export function parseSources(value) {
  return String(value ?? "")
    .split(";;")
    .map((sourceValue) => {
      const [name = "", cpfValue = "", type = "", notesCount = "0"] =
        sourceValue.split("|");

      return {
        name,
        cpf: cpfValue,
        type: type === "holder" ? "holder" : "auxiliary",
        typeLabel: type === "holder" ? "Titular" : "Auxiliar",
        notesCount: Number(notesCount || 0),
      };
    })
    .filter((source) => source.name || source.cpf);
}

export function mapSummaryRow(row) {
  const notesCount = Number(row.notes_count ?? 0);

  return {
    id: row.id,
    importId: row.import_id ?? "",
    donorId: row.donor_id,
    referenceMonth: row.reference_month,
    cpf: row.cpf,
    donorName: row.donor_name,
    demand: row.demand ?? "",
    notesCount,
    invalidNotesCount: Number(row.invalid_notes_count ?? 0),
    valuePerNote: Number(row.value_per_note ?? 0),
    abatementAmount: Number(row.abatement_amount ?? 0),
    abatementStatus: row.abatement_status ?? "pending",
    abatementMarkedAt: row.abatement_marked_at ?? "",
    donorType: row.donor_type === "auxiliary" ? "auxiliary" : "holder",
    donorTypeLabel: row.donor_type === "auxiliary" ? "Auxiliar" : "Titular",
    holderDonorId: row.active_holder_donor_id ?? row.holder_donor_id ?? "",
    holderPersonId: row.holder_person_id ?? "",
    holderName: row.holder_name ?? "",
    holderCpf: row.holder_cpf ?? "",
    holderIsActiveDonor: Boolean(row.active_holder_donor_id),
    donationStartDate: row.donation_start_date ?? "",
    auxiliaries: parseAuxiliaries(row.auxiliary_details),
    sourceCpfs: parseSourceCpfs(row.source_cpfs),
    sources: parseSources(row.source_details),
    sourceCpfCount: Number(row.source_cpf_count ?? 0),
    sourceStartConflictCount: Number(row.source_start_conflict_count ?? 0),
    hasDonationsInMonth: notesCount > 0,
    canUpdateAbatement: notesCount > 0,
  };
}

export function mapDonorWithoutDonation(
  row,
  { referenceMonth, valuePerNote = 0 },
) {
  return {
    id: `${row.id}-${referenceMonth}-without-donation`,
    importId: "",
    donorId: row.id,
    referenceMonth,
    cpf: row.cpf,
    donorName: row.name,
    demand: row.demand ?? "",
    notesCount: 0,
    invalidNotesCount: Number(row.invalid_notes_count ?? 0),
    valuePerNote: Number(valuePerNote ?? 0),
    abatementAmount: 0,
    abatementStatus: "none",
    abatementMarkedAt: "",
    donorType: row.donor_type === "auxiliary" ? "auxiliary" : "holder",
    donorTypeLabel: row.donor_type === "auxiliary" ? "Auxiliar" : "Titular",
    holderDonorId: row.active_holder_donor_id ?? row.holder_donor_id ?? "",
    holderPersonId: row.holder_person_id ?? "",
    holderName: row.holder_name ?? "",
    holderCpf: row.holder_cpf ?? "",
    holderIsActiveDonor: Boolean(row.active_holder_donor_id),
    donationStartDate: row.donation_start_date ?? "",
    auxiliaries: parseAuxiliaries(row.auxiliary_details),
    sourceCpfs: parseSourceCpfs(row.source_cpfs),
    sources: parseSources(row.source_details),
    sourceCpfCount: Number(row.source_cpf_count ?? 0),
    sourceStartConflictCount: 0,
    hasDonationsInMonth: false,
    canUpdateAbatement: false,
  };
}

/**
 * Folds a single abatement adjustment into its parent monthly summary row.
 *
 * Two regimes:
 *
 *  • Additive (range_end < reference_month): the adjustment covers ONLY past
 *    months, so it is summed on top of the regular row. The UI shows
 *    "X no mês + Y acumuladas".
 *
 *  • Subsumption (range_end >= reference_month): the adjustment range already
 *    covers the reference month, so the regular row's notes/value are part of
 *    the adjustment total. We REPLACE rather than sum to avoid double-counting.
 *    The UI shows just the total because there is nothing extra "for the month
 *    on top of the catch-up".
 *
 * In both regimes we propagate the adjustment's status if the underlying row
 * had no donations (status "none"), so filters such as "Pendentes" still see
 * the row.
 */
export function mergeAdjustmentIntoRow(row, adjustment) {
  if (!adjustment) {
    return row;
  }

  const adjustmentNotes = Number(adjustment.notesCount ?? 0);
  const adjustmentAmount = Number(adjustment.abatementAmount ?? 0);
  // String comparison works because both sides are 'YYYY-MM-DD' produced by
  // `startOfMonth`. If the column ever switches representation, revisit.
  const subsumes = Boolean(
    adjustment.rangeEndMonth &&
      row.referenceMonth &&
      adjustment.rangeEndMonth >= row.referenceMonth,
  );

  const monthNotesCount = subsumes ? 0 : row.notesCount;
  const monthAbatementAmount = subsumes ? 0 : row.abatementAmount;
  const combinedNotes = monthNotesCount + adjustmentNotes;
  const combinedAmount = monthAbatementAmount + adjustmentAmount;

  // If the underlying row had no real donation status (synthesized via
  // mapDonorWithoutDonation), inherit the adjustment's pending/applied state
  // so status filters and the toggle UI work as expected.
  const effectiveStatus =
    row.abatementStatus && row.abatementStatus !== "none"
      ? row.abatementStatus
      : adjustment.abatementStatus;

  return {
    ...row,
    notesCount: combinedNotes,
    abatementAmount: combinedAmount,
    monthNotesCount,
    monthAbatementAmount,
    hasDonationsInMonth: combinedNotes > 0,
    canUpdateAbatement: combinedNotes > 0,
    abatementStatus: effectiveStatus ?? row.abatementStatus,
    adjustment,
    hasAdjustment: true,
    adjustmentSubsumesMonth: subsumes,
  };
}

/**
 * Marks rows whose referenceMonth falls within another adjustment's range (but
 * is NOT that adjustment's own referenceMonth). These months are "subsumed" by
 * a catch-up: their individual amounts are already included in the catch-up
 * total, so they must be excluded from totals to avoid double-counting.
 */
export function markSubsumedRows(rows, adjustments) {
  if (!adjustments || adjustments.length === 0) return rows;

  return rows.map((row) => {
    const covering = adjustments.find(
      (adj) =>
        adj.donorId === row.donorId &&
        adj.referenceMonth !== row.referenceMonth &&
        adj.rangeStartMonth <= row.referenceMonth &&
        adj.rangeEndMonth >= row.referenceMonth,
    );
    if (!covering) return row;
    return {
      ...row,
      isSubsumed: true,
      subsumedByAdjustmentId: covering.id,
      subsumedByReferenceMonth: covering.referenceMonth,
      canUpdateAbatement: false,
    };
  });
}

export function mergeAdjustmentsByMonth(rows, adjustments) {
  if (!adjustments || adjustments.length === 0) {
    return rows;
  }

  // Key by (donorId, referenceMonth) so the same donor can have separate
  // adjustments across multiple months in a historical view.
  const adjustmentMap = new Map(
    adjustments.map((adjustment) => [
      `${adjustment.donorId}|${adjustment.referenceMonth}`,
      adjustment,
    ]),
  );

  // monthly_donor_summary can have multiple rows per (donor, month) when
  // there are multiple imports for the same month. The catch-up belongs to
  // the (donor, month) pair as a whole, not to each import — so only ONE row
  // per key may consume the adjustment. The remaining duplicates pass through
  // unchanged, preventing the catch-up amount from being added N times.
  const consumedKeys = new Set();

  return rows.map((row) => {
    const key = `${row.donorId}|${row.referenceMonth}`;
    if (consumedKeys.has(key)) {
      return row;
    }
    const adjustment = adjustmentMap.get(key);
    if (!adjustment) {
      return row;
    }
    consumedKeys.add(key);
    return mergeAdjustmentIntoRow(row, adjustment);
  });
}

export function applySummaryFilters(
  rows,
  { abatementStatus = "all", donationActivity = "all" } = {},
) {
  let filteredRows = rows;

  // Subsumed rows belong to a catch-up in a different reference month. When
  // any filter narrows the result set they must be excluded so they don't
  // appear as independent pending/donated entries.
  if (abatementStatus !== "all" || donationActivity !== "all") {
    filteredRows = filteredRows.filter((row) => !row.isSubsumed);
  }

  if (donationActivity === "donated") {
    filteredRows = filteredRows.filter((row) => row.hasDonationsInMonth);
  }

  if (donationActivity === "not-donated") {
    filteredRows = filteredRows.filter((row) => !row.hasDonationsInMonth);
  }

  if (abatementStatus !== "all") {
    filteredRows = filteredRows.filter(
      (row) =>
        row.hasDonationsInMonth && row.abatementStatus === abatementStatus,
    );
  }

  return filteredRows;
}

export function sortSummariesByAbatement(rows, sortDirection = "") {
  if (!sortDirection) {
    return rows;
  }

  const direction = sortDirection === "asc" ? 1 : -1;

  return [...rows].sort((left, right) => {
    const amountDifference =
      (Number(left.abatementAmount ?? 0) - Number(right.abatementAmount ?? 0)) *
      direction;

    if (amountDifference !== 0) {
      return amountDifference;
    }

    return String(left.donorName ?? "").localeCompare(
      String(right.donorName ?? ""),
      "pt-BR",
    );
  });
}

/**
 * Builds the donors WHERE/params pair shared by both listing functions.
 * Returns {conditions: string[], params: any[]} so callers can splice them
 * into their query — keeps prepared statements honest about parameter
 * positions.
 */
/**
 * Colunas cobertas pela busca livre da Gestão Mensal. Extraído porque as duas
 * queries do `listByMonth` (donors e monthly_donor_summary) precisam da mesma
 * cobertura — se divergirem, um doador some da lista ao paginar.
 */
export const MONTHLY_SEARCH_COLUMNS = [
  { expression: "donors.name" },
  { expression: "donors.demand" },
  {
    expression: `(
      SELECT string_agg(donor_cpf_links.cpf, ' ')
      FROM donor_cpf_links
      WHERE donor_cpf_links.donor_id = donors.id
        AND donor_cpf_links.is_active = TRUE
    )`,
    type: "cpf",
  },
];

export function buildDonorConditions({
  donorId = "",
  donorType = "all",
  cpf = "",
  demand = "",
  donationStartDate = "all",
  donorActiveStatus = "active",
  // Mês da consulta (`YYYY-MM-01`). "Ativo" é sempre em relação a um mês: o
  // doador desativado em maio ainda conta em abril.
  referenceMonth,
  search = "",
} = {}) {
  const conditions = [];
  const params = [];

  const searchCondition = buildTextSearchCondition(search, MONTHLY_SEARCH_COLUMNS);

  if (searchCondition) {
    conditions.push(searchCondition.condition);
    params.push(...searchCondition.params);
  }

  if (donorActiveStatus === "active") {
    conditions.push(donorCountsAtMonth("CAST(? AS DATE)"));
    params.push(referenceMonth);
  } else if (donorActiveStatus === "inactive") {
    conditions.push(`NOT ${donorCountsAtMonth("CAST(? AS DATE)")}`);
    params.push(referenceMonth);
  }

  if (donorId.trim()) {
    conditions.push("donors.id = ?");
    params.push(donorId.trim());
  }

  if (donorType === "holder" || donorType === "auxiliary") {
    conditions.push("donors.donor_type = ?");
    params.push(donorType);
  }

  if (cpf.trim()) {
    conditions.push(`
      EXISTS (
        SELECT 1
        FROM donor_cpf_links
        WHERE donor_cpf_links.donor_id = donors.id
          AND donor_cpf_links.is_active = TRUE
          AND donor_cpf_links.cpf = ?
      )
    `);
    params.push(normalizeCpf(cpf));
  }

  if (demand.trim()) {
    conditions.push("lower(coalesce(donors.demand, '')) = lower(?)");
    params.push(demand.trim());
  }

  if (donationStartDate === "with-date") {
    conditions.push("donors.donation_start_date IS NOT NULL");
  }

  if (donationStartDate === "without-date") {
    conditions.push("donors.donation_start_date IS NULL");
  }

  return { conditions, params };
}

// Synthetic ids generated by mapDonorWithoutDonation for active donors that
// have no monthly_donor_summary row in the period. They never match a real
// row in the database, so any UPDATE keyed by id is a no-op for them.
export function isSyntheticSummaryId(summaryId) {
  return (
    typeof summaryId === "string" &&
    (summaryId.endsWith("-without-donation") ||
      summaryId.endsWith("-adjustment-only"))
  );
}

/**
 * Returns adjustments that didn't get merged into any monthly summary row.
 * Happens when a catch-up references a month for which the donor has no
 * `monthly_donor_summary` entry (e.g., donor registered after the import).
 */
export function findOrphanAdjustments(rows, adjustments) {
  if (!adjustments || adjustments.length === 0) return [];
  const usedKeys = new Set(
    rows
      .filter((r) => r.hasAdjustment)
      .map((r) => `${r.donorId}|${r.referenceMonth}`),
  );
  return adjustments.filter(
    (adj) => !usedKeys.has(`${adj.donorId}|${adj.referenceMonth}`),
  );
}

/**
 * Builds a summary-row-like object from a catch-up adjustment that has no
 * underlying `monthly_donor_summary` row. The catch-up becomes the row itself
 * so totals and lists can surface it instead of silently losing the amount.
 */
export function synthesizeAdjustmentOnlyRow(adjustment, donorContext = {}) {
  const adjustmentNotes = Number(adjustment.notesCount ?? 0);
  const adjustmentAmount = Number(adjustment.abatementAmount ?? 0);

  return {
    id: `${adjustment.id}-adjustment-only`,
    importId: "",
    donorId: adjustment.donorId,
    referenceMonth: adjustment.referenceMonth,
    cpf: donorContext.cpf ?? "",
    donorName: donorContext.donorName ?? "",
    demand: donorContext.demand ?? "",
    notesCount: adjustmentNotes,
    invalidNotesCount: 0,
    valuePerNote: 0,
    abatementAmount: adjustmentAmount,
    abatementStatus: adjustment.abatementStatus,
    abatementMarkedAt: adjustment.abatementMarkedAt ?? "",
    donorType: donorContext.donorType ?? "holder",
    donorTypeLabel: donorContext.donorTypeLabel ?? "Titular",
    holderDonorId: donorContext.holderDonorId ?? "",
    holderPersonId: donorContext.holderPersonId ?? "",
    holderName: donorContext.holderName ?? "",
    holderCpf: donorContext.holderCpf ?? "",
    holderIsActiveDonor: Boolean(donorContext.holderIsActiveDonor),
    donationStartDate: donorContext.donationStartDate ?? "",
    auxiliaries: donorContext.auxiliaries ?? [],
    sourceCpfs: [],
    sources: [],
    sourceCpfCount: 0,
    sourceStartConflictCount: 0,
    hasDonationsInMonth: adjustmentNotes > 0,
    canUpdateAbatement: adjustmentNotes > 0,
    monthNotesCount: 0,
    monthAbatementAmount: 0,
    adjustment,
    hasAdjustment: true,
    adjustmentSubsumesMonth: true,
    isAdjustmentOnly: true,
    isSubsumed: false,
  };
}
