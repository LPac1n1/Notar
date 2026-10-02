/**
 * Série mensal consolidada, usada pelo gráfico de evolução do dashboard.
 *
 * Isolada num módulo sem import de banco para o teste de integração rodar a
 * query REAL contra DuckDB-Node — mesmo padrão de `topDonorsSql.js`.
 *
 * A janela é fixada nos meses mais recentes (ORDER BY DESC + LIMIT) e a
 * ordem cronológica é restaurada em JS. Ordenar ASC e cortar traria os meses
 * mais ANTIGOS, que é o oposto do que um gráfico de tendência precisa.
 */
import {
  donorBelongedToProjectAtMonth,
  MATCHED_CREDIT_BY_DONOR_MONTH,
} from "../project/projectAssignmentSql.js";
import { summaryDonorIsActive } from "../monthly/summaryScopeSql.js";

export const MONTHLY_TREND_LIMIT = 12;

/**
 * As duas grandezas vêm de origens diferentes e por isso são somadas em CTEs
 * separadas antes de se encontrarem:
 *
 *   - abatimento e notas saem de `monthly_donor_summary`, que é o resultado da
 *     apuração mensal;
 *   - crédito sai da conciliação com a planilha da NFP, cujo mês é o da NOTA.
 *
 * Um mês pode existir de um lado e não do outro (planilha de crédito ainda não
 * importada, ou crédito de um mês cuja apuração não foi feita). Por isso a
 * lista de meses é a UNIÃO das duas, e não uma delas: partir de
 * `monthly_donor_summary` esconderia o crédito de um mês ainda não apurado, que
 * é justamente o que se quer enxergar.
 *
 * `total_abatement` conta só o que está marcado como REALIZADO. "Já abatido" é
 * o que de fato saiu; incluir o pendente misturaria compromisso com execução e
 * inflaria a dedução do ganho líquido.
 */
export function buildMonthlyTrendSql(projectId) {
  const creditScope = donorBelongedToProjectAtMonth(
    "credit.donor_id",
    "CAST(credit.reference_month AS DATE)",
    projectId,
  );
  const summaryScope = donorBelongedToProjectAtMonth(
    "monthly_donor_summary.donor_id",
    "monthly_donor_summary.reference_month",
    projectId,
  );

  return `
  WITH credit AS (${MATCHED_CREDIT_BY_DONOR_MONTH}),
  project_credit AS (
    SELECT
      credit.reference_month AS reference_month,
      sum(credit.total_credit) AS total_credit
    FROM credit
    WHERE ${creditScope}
    GROUP BY credit.reference_month
  ),
  project_summary AS (
    SELECT
      strftime(monthly_donor_summary.reference_month, '%Y-%m-01') AS reference_month,
      sum(monthly_donor_summary.notes_count) AS total_notes,
      sum(
        CASE WHEN monthly_donor_summary.abatement_status = 'applied'
          THEN monthly_donor_summary.abatement_amount ELSE 0 END
      ) AS total_abatement,
      count(DISTINCT monthly_donor_summary.donor_id) AS donor_count
    FROM monthly_donor_summary
    WHERE ${summaryScope}
      AND ${summaryDonorIsActive()}
    GROUP BY strftime(monthly_donor_summary.reference_month, '%Y-%m-01')
  ),
  all_months AS (
    SELECT reference_month FROM project_summary
    UNION
    SELECT reference_month FROM project_credit
  )
  SELECT
    all_months.reference_month AS reference_month,
    coalesce(project_summary.total_notes, 0) AS total_notes,
    coalesce(project_summary.total_abatement, 0) AS total_abatement,
    coalesce(project_summary.donor_count, 0) AS donor_count,
    coalesce(project_credit.total_credit, 0) AS total_credit,
    coalesce(project_credit.total_credit, 0)
      - coalesce(project_summary.total_abatement, 0) AS net_gain
  FROM all_months
  LEFT JOIN project_summary
    ON project_summary.reference_month = all_months.reference_month
  LEFT JOIN project_credit
    ON project_credit.reference_month = all_months.reference_month
  ORDER BY all_months.reference_month DESC
  LIMIT ${MONTHLY_TREND_LIMIT}
`;
}
