import { donorBelongedToProjectAtMonth } from "../project/projectAssignmentSql.js";

/**
 * SQL da planilha de abatimento (uma linha por CPF de doador que enviou notas
 * no mês). Isolado num módulo sem imports para o teste de integração rodar a
 * query REAL contra DuckDB-Node em vez de espelhá-la e divergir.
 *
 * Pontos que a query resolve e que não são óbvios:
 *
 *  • Agrupa por `donor_cpf_links` (CPF), então cada auxiliar sai numa linha com
 *    a contagem dele — nunca somada à do titular.
 *
 *  • MAS as colunas NOME e CPF da planilha levam a identidade do TITULAR
 *    (`sheet_name` / `sheet_cpf`), porque é na conta dele que o abatimento é
 *    lançado. Quem distingue as linhas do grupo é a DESCRIÇÃO, que continua
 *    trazendo o nome de cada pessoa.
 *
 *  • `group_has_auxiliaries` decide se o nome entra na descrição. É TRUE para
 *    todo auxiliar (por definição o grupo dele tem um) e para o titular que
 *    tenha pelo menos um auxiliar ativo. Titular sozinho fica FALSE e recebe
 *    a descrição curta.
 *
 *  • `notes_count` do `import_cpf_summary` já é só a contagem válida — as
 *    descartadas por status de pedido vivem em `invalid_notes_count`.
 *
 * As duas planilhas (a de um mês e a de todos os pendentes) compartilham as
 * colunas, as junções e o agrupamento. Só o recorte muda — e é por isso que
 * esses trechos são constantes: duas cópias da identidade do titular
 * divergiriam na primeira correção feita numa só.
 */
const SHEET_COLUMNS = `
    donor_cpf_links.cpf AS cpf,
    donors.name AS donor_name,
    -- Identidade que vai para as colunas NOME e CPF da planilha. Para um
    -- auxiliar é a do TITULAR: o sistema de destino abate na conta de quem
    -- responde pelo grupo, e o auxiliar continua identificado na DESCRIÇÃO.
    -- O coalesce evita linha sem nome quando o vínculo com a pessoa de
    -- referência não resolve — nesse caso a linha volta a valer por si.
    coalesce(holder_people.name, donors.name) AS sheet_name,
    coalesce(holder_people.cpf, donor_cpf_links.cpf) AS sheet_cpf,
    donors.demand AS demand,
    donors.donor_type AS donor_type,
    sum(import_cpf_summary.notes_count) AS notes_count,
    CASE
      WHEN donors.donor_type = 'auxiliary' THEN TRUE
      ELSE EXISTS (
        SELECT 1
        FROM donors AS auxiliary_donors
        WHERE auxiliary_donors.holder_person_id = donors.person_id
          AND auxiliary_donors.donor_type = 'auxiliary'
          AND auxiliary_donors.is_active = TRUE
      )
    END AS group_has_auxiliaries`;

const SHEET_FROM = `
  FROM import_cpf_summary
  INNER JOIN donor_cpf_links
    ON donor_cpf_links.id = import_cpf_summary.matched_source_id
    AND donor_cpf_links.is_active = TRUE
  -- Doador inativo não vai para o sistema de baixa: a planilha é a lista de
  -- quem tem abatimento a receber, e desativar tira o doador da apuração.
  INNER JOIN donors
    ON donors.id = donor_cpf_links.donor_id
    AND donors.is_active = TRUE
  -- LEFT: só o auxiliar tem holder_person_id. Para o titular o join não casa,
  -- e o coalesce acima faz a linha usar a identidade dele mesmo.
  LEFT JOIN people AS holder_people
    ON holder_people.id = donors.holder_person_id`;

const SHEET_GROUP_AND_ORDER = `
  GROUP BY
    donor_cpf_links.cpf,
    donors.name,
    holder_people.name,
    holder_people.cpf,
    donors.demand,
    donors.donor_type,
    donors.person_id
  ORDER BY donors.name ASC, donor_cpf_links.cpf ASC`;

/**
 * A planilha é a lista de CPFs a abater no mês, e o abatimento é do
 * projeto que está apurando. O recorte usa o mês DA LINHA, então um doador
 * transferido não leva os meses antigos para a planilha do projeto novo.
 *
 * Recebe o mês de referência como único parâmetro (`?`).
 */
export function buildAbatementSheetSql(projectId) {
  return `
  SELECT ${SHEET_COLUMNS}
  ${SHEET_FROM}
  WHERE import_cpf_summary.reference_month = ?
    AND import_cpf_summary.notes_count > 0
    AND ${donorBelongedToProjectAtMonth(
      "donors.id",
      "import_cpf_summary.reference_month",
      projectId,
    )}
  ${SHEET_GROUP_AND_ORDER}
`;
}

/**
 * Todo mês em que cada CPF teve nota válida, em qualquer status e projeto.
 *
 * A descrição usa a diferença entre isto e os meses da planilha: um mês do
 * meio que teve doação e ficou de fora (abatido antes, ou não escolhido)
 * parte o "até"; um mês do meio sem doação é atravessado por ele.
 */
const CPF_DONATION_MONTHS_CTE = `
  WITH cpf_donation_months AS (
    SELECT
      import_cpf_summary.cpf AS cpf,
      string_agg(
        DISTINCT strftime(import_cpf_summary.reference_month, '%Y-%m-01'),
        ','
      ) AS donation_months
    FROM import_cpf_summary
    INNER JOIN imports
      ON imports.id = import_cpf_summary.import_id
    WHERE import_cpf_summary.notes_count > 0
      AND imports.status = 'processed'
    GROUP BY import_cpf_summary.cpf
  )`;

// Colunas das planilhas que somam MAIS DE UM mês numa linha: os meses
// somados, o mais recente deles (de onde sai a DATA) e os meses com doação.
const SHEET_MULTI_MONTH_COLUMNS = `
    string_agg(
      DISTINCT strftime(import_cpf_summary.reference_month, '%Y-%m-01'),
      ','
    ) AS reference_months,
    strftime(max(import_cpf_summary.reference_month), '%Y-%m-01') AS last_month,
    -- Uma linha por CPF na CTE, então o max só tira o valor do agrupamento.
    max(cpf_donation_months.donation_months) AS donation_months`;

const SHEET_DONATION_MONTHS_JOIN = `
  LEFT JOIN cpf_donation_months
    ON cpf_donation_months.cpf = donor_cpf_links.cpf`;

/**
 * Planilha dos meses ESCOLHIDOS na Gestão Mensal, somados por CPF.
 *
 * Mesma forma da planilha de pendentes — uma linha por CPF, VALOR somado e
 * descrição nomeando o conjunto —, mas o recorte aqui é a seleção do
 * operador, não o status: mês já realizado entra se estiver marcado, porque
 * quem decide o período é quem exporta.
 *
 * Recebe um `?` por mês, na ordem em que forem passados.
 */
export function buildMonthsAbatementSheetSql(projectId, monthCount) {
  const placeholders = Array.from(
    { length: Math.max(1, Number(monthCount) || 0) },
    () => "?",
  ).join(", ");

  return `
  ${CPF_DONATION_MONTHS_CTE}
  SELECT ${SHEET_COLUMNS},${SHEET_MULTI_MONTH_COLUMNS}
  ${SHEET_FROM}
  ${SHEET_DONATION_MONTHS_JOIN}
  WHERE import_cpf_summary.reference_month IN (${placeholders})
    AND import_cpf_summary.notes_count > 0
    AND ${donorBelongedToProjectAtMonth(
      "donors.id",
      "import_cpf_summary.reference_month",
      projectId,
    )}
  ${SHEET_GROUP_AND_ORDER}
`;
}

/**
 * Planilha de TODOS os meses ainda pendentes, somados por CPF.
 *
 * Um mês entra quando é uma pendência que a Gestão Mensal deixa o usuário
 * resolver — a mesma regra do contador de pendências da visão por mês:
 *
 *  • o resumo do doador naquele mês está `pending` e tem nota;
 *  • nenhum acumulado lançado em OUTRO mês cobre aquele mês. Esses aparecem
 *    na tela como "Via acumulado", já foram abatidos junto com o acumulado,
 *    e o status cru deles continua `pending` no banco. Mandá-los para a
 *    planilha abateria a mesma doação duas vezes no destino.
 *
 * O status mora em `monthly_donor_summary`, cuja linha é do doador dono do
 * vínculo de CPF (`donor_cpf_links.donor_id`) — o mesmo `donors.id` desta
 * consulta. Por isso o casamento é por doador e mês, sem passar pelo CPF.
 *
 * `reference_months` lista os meses somados (a descrição é montada a partir
 * deles) e `last_month` é o mais recente, de onde sai a DATA da linha.
 *
 * `donation_months` lista TODO mês em que o CPF teve nota válida, em qualquer
 * status e projeto. A descrição usa a diferença entre as duas listas: um mês
 * do meio que teve doação e não está pendente (abatido antes) parte o "até";
 * um mês do meio sem doação é atravessado por ele.
 *
 * Sem parâmetro nenhum: o projeto é embutido pelo helper, que o valida.
 */
export function buildPendingAbatementSheetSql(projectId) {
  return `
  ${CPF_DONATION_MONTHS_CTE}
  SELECT ${SHEET_COLUMNS},${SHEET_MULTI_MONTH_COLUMNS}
  ${SHEET_FROM}
  ${SHEET_DONATION_MONTHS_JOIN}
  WHERE import_cpf_summary.notes_count > 0
    AND ${donorBelongedToProjectAtMonth(
      "donors.id",
      "import_cpf_summary.reference_month",
      projectId,
    )}
    AND EXISTS (
      SELECT 1
      FROM monthly_donor_summary
      WHERE monthly_donor_summary.donor_id = donors.id
        AND monthly_donor_summary.reference_month = import_cpf_summary.reference_month
        AND monthly_donor_summary.abatement_status = 'pending'
        AND coalesce(monthly_donor_summary.notes_count, 0) > 0
        AND NOT EXISTS (
          SELECT 1
          FROM abatement_adjustments
          WHERE abatement_adjustments.donor_id = monthly_donor_summary.donor_id
            AND abatement_adjustments.reference_month <> monthly_donor_summary.reference_month
            AND abatement_adjustments.range_start_month <= monthly_donor_summary.reference_month
            AND abatement_adjustments.range_end_month >= monthly_donor_summary.reference_month
        )
    )
  ${SHEET_GROUP_AND_ORDER}
`;
}
