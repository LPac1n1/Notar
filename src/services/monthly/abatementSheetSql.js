import { donorBelongedToProjectAtMonth } from "../project/projectAssignmentSql.js";
import { donorCountsAtMonth } from "./summaryScopeSql.js";

/**
 * SQL da planilha de abatimento (uma linha por CPF de doador com abatimento
 * no mês). Isolado num módulo sem import de banco para o teste de integração
 * rodar a query REAL contra DuckDB-Node em vez de espelhá-la e divergir.
 *
 * A REGRA QUE ORGANIZA O ARQUIVO: **a planilha de um mês diz o que a Gestão
 * Mensal mostra como abatimento daquele mês.** Isso tem duas origens, e a
 * CTE `sheet_entries` junta as duas:
 *
 *  (a) as notas do próprio mês, quando nenhum acumulado cobre aquele mês;
 *
 *  (b) o ACUMULADO lançado naquele mês, com o total gravado nele. Lançar em
 *      junho um acumulado de abril a junho faz a linha de junho levar as
 *      notas dos três meses — e abril e maio saem das planilhas deles, onde
 *      a Gestão Mensal os mostra como "Via acumulado". Antes a planilha
 *      somava as notas mês a mês e ignorava o acumulado: a de junho saía só
 *      com junho, e abril e maio não saíam em planilha nenhuma.
 *
 * Um mês coberto por acumulado nunca entra por (a) — inclusive o próprio mês
 * do lançamento, quando o período o inclui: as notas dele já estão no total
 * do acumulado, e somar as duas coisas abateria a mesma doação duas vezes. É
 * a mesma conta de `mergeAdjustmentIntoRow` e `markSubsumedRows`.
 *
 * O total de (b) é o número GRAVADO no acumulado, não uma soma refeita das
 * notas: é ele que a tela e o relatório mostram, e a planilha tem de dizer o
 * mesmo. (Se um mês do período for reimportado depois, o acumulado não se
 * atualiza sozinho — isso é da regra do acumulado, não da planilha.)
 *
 * Outros pontos que a query resolve e que não são óbvios:
 *
 *  • Agrupa por `donor_cpf_links` (CPF), então cada auxiliar sai numa linha com
 *    a contagem dele — nunca somada à do titular. O acumulado é do DOADOR e
 *    vai para a linha do CPF dele.
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
 * As três planilhas (a de um mês, a dos meses escolhidos e a de todos os
 * pendentes) compartilham a CTE, as colunas, as junções e o agrupamento. Só o
 * recorte muda — duas cópias da identidade do titular, ou da regra do
 * acumulado, divergiriam na primeira correção feita numa só.
 */

/**
 * Todo mês em que cada CPF teve nota válida, em qualquer status e projeto.
 *
 * A descrição usa a diferença entre isto e os meses da linha: um mês do
 * meio que teve doação e ficou de fora (abatido antes, ou não escolhido)
 * parte o "até"; um mês do meio sem doação é atravessado por ele.
 */
const CPF_DONATION_MONTHS = `
  cpf_donation_months AS (
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

/**
 * O que é abatido, em que mês, na linha de qual CPF.
 *
 *   link_id          o vínculo de CPF cuja linha recebe o valor
 *   abatement_month  o mês em que o abatimento acontece (o do acumulado, para
 *                    as notas que ele cobre)
 *   source_months    os meses de onde as notas vieram, para a descrição
 *   is_pending       a Gestão Mensal mostra esse abatimento como pendente
 */
const SHEET_ENTRIES = `
  sheet_entries AS (
    -- (a) Notas de um mês que nenhum acumulado cobre.
    SELECT
      donor_cpf_links.id AS link_id,
      donor_cpf_links.donor_id AS donor_id,
      import_cpf_summary.reference_month AS abatement_month,
      import_cpf_summary.notes_count AS notes_count,
      strftime(import_cpf_summary.reference_month, '%Y-%m-01') AS source_months,
      -- O status mora no resumo mensal, cuja linha é do doador dono do
      -- vínculo de CPF: o casamento é por doador e mês, sem passar pelo CPF.
      EXISTS (
        SELECT 1
        FROM monthly_donor_summary
        WHERE monthly_donor_summary.donor_id = donor_cpf_links.donor_id
          AND monthly_donor_summary.reference_month = import_cpf_summary.reference_month
          AND monthly_donor_summary.abatement_status = 'pending'
          AND coalesce(monthly_donor_summary.notes_count, 0) > 0
      ) AS is_pending
    FROM import_cpf_summary
    INNER JOIN donor_cpf_links
      ON donor_cpf_links.id = import_cpf_summary.matched_source_id
      AND donor_cpf_links.is_active = TRUE
    WHERE import_cpf_summary.notes_count > 0
      AND NOT EXISTS (
        SELECT 1
        FROM abatement_adjustments AS covering_adjustment
        WHERE covering_adjustment.donor_id = donor_cpf_links.donor_id
          AND covering_adjustment.range_start_month <= import_cpf_summary.reference_month
          AND covering_adjustment.range_end_month >= import_cpf_summary.reference_month
      )

    UNION ALL

    -- (b) O acumulado, no mês em que foi lançado, com o total gravado nele.
    SELECT
      -- Vai para a linha do CPF do próprio doador; se ele não tiver vínculo
      -- com o CPF do cadastro, para o primeiro vínculo ativo. Sem vínculo
      -- ativo nenhum não há linha onde lançar, e a junção de fora o descarta.
      coalesce(
        (
          SELECT min(own_link.id)
          FROM donor_cpf_links AS own_link
          WHERE own_link.donor_id = adjustment_donor.id
            AND own_link.is_active = TRUE
            AND own_link.cpf = adjustment_donor.cpf
        ),
        (
          SELECT min(any_link.id)
          FROM donor_cpf_links AS any_link
          WHERE any_link.donor_id = adjustment_donor.id
            AND any_link.is_active = TRUE
        )
      ) AS link_id,
      abatement_adjustments.donor_id AS donor_id,
      abatement_adjustments.reference_month AS abatement_month,
      abatement_adjustments.notes_count AS notes_count,
      -- Os meses do período em que o doador teve nota. Sem nenhum (as
      -- planilhas mudaram depois do lançamento), o começo e o fim do período.
      coalesce(
        (
          SELECT string_agg(
            DISTINCT strftime(covered_summary.reference_month, '%Y-%m-01'),
            ','
          )
          FROM import_cpf_summary AS covered_summary
          INNER JOIN donor_cpf_links AS covered_link
            ON covered_link.id = covered_summary.matched_source_id
            AND covered_link.is_active = TRUE
          WHERE covered_link.donor_id = abatement_adjustments.donor_id
            AND covered_summary.notes_count > 0
            AND covered_summary.reference_month >= abatement_adjustments.range_start_month
            AND covered_summary.reference_month <= abatement_adjustments.range_end_month
        ),
        strftime(abatement_adjustments.range_start_month, '%Y-%m-01')
          || ',' || strftime(abatement_adjustments.range_end_month, '%Y-%m-01')
      ) AS source_months,
      -- Na tela, o status da linha do mês é o do resumo mensal; o do
      -- acumulado só vale quando o doador não tem resumo naquele mês.
      coalesce(
        (
          SELECT max(month_summary.abatement_status)
          FROM monthly_donor_summary AS month_summary
          WHERE month_summary.donor_id = abatement_adjustments.donor_id
            AND month_summary.reference_month = abatement_adjustments.reference_month
        ),
        abatement_adjustments.abatement_status
      ) = 'pending' AS is_pending
    FROM abatement_adjustments
    INNER JOIN donors AS adjustment_donor
      ON adjustment_donor.id = abatement_adjustments.donor_id
    WHERE coalesce(abatement_adjustments.notes_count, 0) > 0
  )`;

const SHEET_SELECT = `
  SELECT
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
    sum(sheet_entries.notes_count) AS notes_count,
    CASE
      WHEN donors.donor_type = 'auxiliary' THEN TRUE
      ELSE EXISTS (
        SELECT 1
        FROM donors AS auxiliary_donors
        WHERE auxiliary_donors.holder_person_id = donors.person_id
          AND auxiliary_donors.donor_type = 'auxiliary'
          AND auxiliary_donors.is_active = TRUE
      )
    END AS group_has_auxiliaries,
    -- Os meses somados na linha (a descrição é montada a partir deles). Uma
    -- entrada de acumulado traz vários; quem lê separa e tira repetição.
    string_agg(sheet_entries.source_months, ',') AS reference_months,
    -- O mês do abatimento mais recente da linha, de onde sai a DATA. É o mês
    -- do ACUMULADO, não o da última nota: um acumulado de abril e maio
    -- lançado em junho é abatido em junho.
    strftime(max(sheet_entries.abatement_month), '%Y-%m-01') AS last_month,
    -- Uma linha por CPF na CTE, então o max só tira o valor do agrupamento.
    max(cpf_donation_months.donation_months) AS donation_months
  FROM sheet_entries
  INNER JOIN donor_cpf_links
    ON donor_cpf_links.id = sheet_entries.link_id
  INNER JOIN donors
    ON donors.id = sheet_entries.donor_id
  -- LEFT: só o auxiliar tem holder_person_id. Para o titular o join não casa,
  -- e o coalesce acima faz a linha usar a identidade dele mesmo.
  LEFT JOIN people AS holder_people
    ON holder_people.id = donors.holder_person_id
  LEFT JOIN cpf_donation_months
    ON cpf_donation_months.cpf = donor_cpf_links.cpf`;

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
 * O que entra em QUALQUER das planilhas, entrada a entrada, sempre pelo mês
 * do ABATIMENTO:
 *
 *  • o doador pertencia ao projeto naquele mês — um doador transferido não
 *    leva os meses antigos para a planilha do projeto novo;
 *
 *  • as doações dele contam naquele mês — o doador desativado não vai para o
 *    sistema de baixa do mês da desativação em diante; os meses anteriores,
 *    em que ele doou como ativo, continuam saindo.
 */
function sheetScope(projectId) {
  return `${donorBelongedToProjectAtMonth(
    "donors.id",
    "sheet_entries.abatement_month",
    projectId,
  )}
    AND ${donorCountsAtMonth("sheet_entries.abatement_month")}`;
}

function buildSheetSql(projectId, where) {
  return `
  WITH ${CPF_DONATION_MONTHS},
  ${SHEET_ENTRIES}
  ${SHEET_SELECT}
  WHERE ${where}
    AND ${sheetScope(projectId)}
  ${SHEET_GROUP_AND_ORDER}
`;
}

/**
 * Planilha de UM mês: o que a Gestão Mensal mostra como abatimento dele —
 * as notas do mês de quem não tem acumulado cobrindo, e o total de cada
 * acumulado lançado nele.
 *
 * Recebe o mês de referência como único parâmetro (`?`).
 */
export function buildAbatementSheetSql(projectId) {
  return buildSheetSql(projectId, "sheet_entries.abatement_month = ?");
}

/**
 * Planilha dos meses ESCOLHIDOS na Gestão Mensal, somados por CPF.
 *
 * O recorte é a seleção do operador, não o status: mês já realizado entra se
 * estiver marcado, porque quem decide o período é quem exporta. E é pelo mês
 * do ABATIMENTO: marcar junho traz o acumulado lançado em junho inteiro,
 * mesmo cobrindo abril e maio; marcar só abril não traz as notas de abril de
 * quem as teve acumuladas em junho.
 *
 * Recebe um `?` por mês, na ordem em que forem passados.
 */
export function buildMonthsAbatementSheetSql(projectId, monthCount) {
  const placeholders = Array.from(
    { length: Math.max(1, Number(monthCount) || 0) },
    () => "?",
  ).join(", ");

  return buildSheetSql(
    projectId,
    `sheet_entries.abatement_month IN (${placeholders})`,
  );
}

/**
 * Planilha de TODOS os abatimentos ainda pendentes, somados por CPF.
 *
 * Entra o que a Gestão Mensal deixa o usuário resolver — a mesma regra do
 * contador de pendências:
 *
 *  • as notas de um mês cujo resumo está `pending` e que nenhum acumulado
 *    cobre. O mês coberto aparece na tela como "Via acumulado" e o status
 *    cru dele continua `pending` no banco; mandá-lo por aqui abateria a
 *    mesma doação duas vezes;
 *
 *  • o acumulado cujo mês de lançamento está pendente — com o total dele.
 *
 * `reference_months` lista os meses somados e `last_month` é o mês de
 * abatimento mais recente, de onde sai a DATA da linha.
 *
 * `donation_months` lista TODO mês em que o CPF teve nota válida, em qualquer
 * status e projeto. A descrição usa a diferença entre as duas listas: um mês
 * do meio que teve doação e não está pendente (abatido antes) parte o "até";
 * um mês do meio sem doação é atravessado por ele.
 *
 * Sem parâmetro nenhum: o projeto é embutido pelo helper, que o valida.
 */
export function buildPendingAbatementSheetSql(projectId) {
  return buildSheetSql(projectId, "sheet_entries.is_pending");
}
