import { startOfMonth } from "../../utils/date.js";
import { donorBelongsToProject } from "../project/projectAssignmentSql.js";
import { summaryDonorCounts } from "../monthly/summaryScopeSql.js";

/**
 * Builder do ranking de maiores doadores.
 *
 * Isolado num módulo sem import de banco (só o helper de data) para que o
 * teste de integração rode a query REAL contra DuckDB-Node em vez de manter
 * uma cópia que pode divergir — mesmo padrão de `inactivityStreaksSql.js` e
 * `abatementSheetSql.js`.
 */

// A chave escolhida na UI é splicada no ORDER BY (DuckDB não aceita `?`
// nessa posição), então só pode vir desta whitelist — nunca do input.
export const TOP_DONOR_SORTS = {
  abatement: "total_abatement DESC, total_notes DESC, donor_name ASC",
  notes: "total_notes DESC, total_abatement DESC, donor_name ASC",
  months: "imported_month_count DESC, total_abatement DESC, donor_name ASC",
};

export const TOP_DONOR_SORT_OPTIONS = [
  { value: "abatement", label: "Maior abatimento" },
  { value: "notes", label: "Mais notas" },
  { value: "months", label: "Mais meses doando" },
];

const DEMAND_EXPRESSION = "coalesce(nullif(trim(demand), ''), 'Sem demanda')";

export function buildTopDonorsQuery({
  referenceMonth = "",
  demand = "",
  sort = "abatement",
  limit = 5,
  projectId = "",
} = {}) {
  // O ranking é do projeto ativo. Sem o recorte, um projeto novo mostraria
  // os maiores doadores do projeto principal.
  const conditions = projectId
    ? [donorBelongsToProject("monthly_donor_summary.donor_id", projectId)]
    : [];
  // O ranking é da apuração: do doador desativado entram só os meses
  // anteriores à desativação.
  conditions.push(summaryDonorCounts());
  const params = [];

  if (referenceMonth) {
    conditions.push("reference_month = CAST(? AS DATE)");
    params.push(startOfMonth(referenceMonth));
  }

  if (demand) {
    conditions.push(`lower(${DEMAND_EXPRESSION}) = lower(?)`);
    params.push(demand);
  }

  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";
  const orderBy = TOP_DONOR_SORTS[sort] ?? TOP_DONOR_SORTS.abatement;
  const safeLimit = Number(limit) > 0 ? Math.floor(Number(limit)) : 5;

  return {
    // `limit` é interpolado, não bindado: DuckDB-WASM não aceita `?` em
    // LIMIT. Seguro porque acabou de passar por Math.floor sobre Number.
    sql: `
    SELECT
      donor_id,
      donor_name,
      ${DEMAND_EXPRESSION} AS demand,
      sum(notes_count) AS total_notes,
      sum(abatement_amount) AS total_abatement,
      count(DISTINCT reference_month) AS imported_month_count
    FROM monthly_donor_summary
    ${whereClause}
    GROUP BY donor_id, donor_name, ${DEMAND_EXPRESSION}
    ORDER BY ${orderBy}
    LIMIT ${safeLimit}
  `,
    params,
  };
}

export const TOP_DONOR_FILTER_OPTIONS_SQL = {
  months: (projectId) => `
    SELECT DISTINCT strftime(reference_month, '%Y-%m-01') AS reference_month
    FROM monthly_donor_summary
    WHERE ${donorBelongsToProject("monthly_donor_summary.donor_id", projectId)}
    ORDER BY reference_month DESC
  `,
  demands: (projectId) => `
    SELECT DISTINCT ${DEMAND_EXPRESSION} AS demand
    FROM monthly_donor_summary
    WHERE ${donorBelongsToProject("monthly_donor_summary.donor_id", projectId)}
    ORDER BY demand ASC
  `,
};
