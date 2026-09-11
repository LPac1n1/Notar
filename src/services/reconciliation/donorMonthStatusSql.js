/**
 * Crédito conciliado e abatimento aplicado, agregados por (doador, mês).
 *
 * Módulo puro — sem import de banco — para o teste de integração rodar a
 * consulta DE PRODUÇÃO contra o DuckDB em vez de espelhá-la e divergir com
 * o tempo. Mesmo padrão de `inactivityStreaksSql.js`.
 *
 * `referenceMonth` recorta os DOIS lados no mesmo mês. Eles precisam andar
 * juntos: escopar só o crédito compararia um mês contra o abatimento de
 * todos os meses, e a coluna "Saldo" passaria a mostrar uma diferença que
 * nunca existiu. Omitir o mês devolve o histórico inteiro, que é o que a
 * visão consolidada precisa.
 */
/**
 * Primeiro dia do mês, a partir de `AAAA-MM` ou de uma data completa.
 *
 * A Gestão Mensal entrega o mês em dois formatos: a âncora automática manda a
 * data completa (`2026-03-01`), mas escolher o mês no campo manda só
 * `2026-03`. Recortar só com `slice(0, 10)` passava `2026-03` inteiro para o
 * `CAST(? AS DATE)` e a consulta falhava — as colunas de crédito real e saldo
 * paravam de atualizar sem nenhum aviso na tela.
 */
function toFirstDayOfMonth(value) {
  const match = /^(\d{4})-(\d{2})/.exec(String(value ?? ""));
  return match ? `${match[1]}-${match[2]}-01` : "";
}

export function buildDonorMonthStatusQuery({ referenceMonth = "" } = {}) {
  const month = toFirstDayOfMonth(referenceMonth);

  const creditScope = month
    ? "AND donation_notes.reference_month = CAST(? AS DATE)"
    : "";
  const abatementScope = month
    ? "AND monthly_donor_summary.reference_month = CAST(? AS DATE)"
    : "";

  const sql = `
    WITH credit_by_month AS (
      SELECT
        donor_cpf_links.donor_id AS donor_id,
        strftime(donation_notes.reference_month, '%Y-%m-%d') AS reference_month,
        sum(credit_notes.credito) AS total_credit,
        count(*) AS matched_count
      FROM credit_reconciliation
      INNER JOIN donation_notes
        ON donation_notes.id = credit_reconciliation.donation_note_id
      INNER JOIN donor_cpf_links
        ON donor_cpf_links.cpf = donation_notes.cpf
        AND donor_cpf_links.is_active = TRUE
      INNER JOIN credit_notes
        ON credit_notes.id = credit_reconciliation.credit_note_id
      WHERE credit_reconciliation.match_status = 'matched'
        ${creditScope}
      GROUP BY
        donor_cpf_links.donor_id,
        strftime(donation_notes.reference_month, '%Y-%m-%d')
    ),
    abated_by_month AS (
      SELECT
        donor_id,
        strftime(reference_month, '%Y-%m-%d') AS reference_month,
        sum(abatement_amount) AS total_abated
      FROM monthly_donor_summary
      WHERE abatement_status = 'applied'
        ${abatementScope}
      GROUP BY donor_id, strftime(reference_month, '%Y-%m-%d')
    ),
    donor_months AS (
      SELECT donor_id, reference_month FROM credit_by_month
      UNION
      SELECT donor_id, reference_month FROM abated_by_month
    )
    SELECT
      donor_months.donor_id,
      donor_months.reference_month,
      coalesce(credit_by_month.total_credit, 0) AS total_credit,
      coalesce(credit_by_month.matched_count, 0) AS matched_count,
      coalesce(abated_by_month.total_abated, 0) AS total_abated
    FROM donor_months
    LEFT JOIN credit_by_month
      ON credit_by_month.donor_id = donor_months.donor_id
      AND credit_by_month.reference_month = donor_months.reference_month
    LEFT JOIN abated_by_month
      ON abated_by_month.donor_id = donor_months.donor_id
      AND abated_by_month.reference_month = donor_months.reference_month
  `;

  return { sql, params: month ? [month, month] : [] };
}
