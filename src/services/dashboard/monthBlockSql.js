import { donorBelongsToProject } from "../project/projectAssignmentSql.js";
import {
  cpfSummaryBelongsToProject,
  cpfSummaryDonorCounts,
  summaryBelongsToProject,
  summaryDonorCounts,
  summaryIsActionable,
} from "../monthly/summaryScopeSql.js";

/**
 * SQL do bloco mensal do Dashboard de um projeto.
 *
 * Módulo puro, para o teste de integração rodar as consultas de produção.
 *
 * A regra que este arquivo existe para manter: **o bloco mensal diz o mesmo
 * que a Gestão Mensal do projeto, para o mesmo mês.** Se o painel anuncia N
 * abatimentos pendentes, abrir a Gestão Mensal mostra N linhas com o botão
 * de marcar. Por isso todo número aqui usa as condições de
 * `monthly/summaryScopeSql.js`:
 *
 *   • só linhas de doadores que pertenciam a ESTE projeto naquele mês;
 *   • só doadores cujas doações contam naquele mês — o desativado sai da
 *     apuração do mês da desativação em diante, e fica nos anteriores;
 *   • "pendente" só o que dá para resolver (com nota, não coberto por
 *     acumulado de outro mês).
 *
 * Antes cada consulta tinha o seu recorte. O contador usava o vínculo de
 * hoje e contava `pending` cru; a lista do modal não filtrava projeto
 * nenhum. No banco real, 201 de 203 "pendentes" de um projeto eram meses já
 * cobertos por acumulado, e a lista de maio mostrava só doadores de outro.
 */

// "Conta para a apuração deste projeto": pertencia a ele no mês e as doações
// dele contam naquele mês. Os dois juntos, para nenhuma consulta lembrar de
// um só.
function countedSummary(projectId) {
  return `${summaryBelongsToProject(projectId)}
          AND ${summaryDonorCounts()}`;
}

function countedCpfSummary(projectId) {
  return `${cpfSummaryBelongsToProject(projectId)}
          AND ${cpfSummaryDonorCounts()}`;
}

/** Limite da lista de pendentes. O contador é exato; a lista é para agir. */
export const MONTH_BLOCK_PENDING_LIMIT = 500;

/**
 * Totais do mês de uma importação. Parâmetro: o id da importação.
 */
export function buildMonthBlockSummarySql(projectId) {
  const summaryScope = countedSummary(projectId);
  const cpfScope = countedCpfSummary(projectId);

  return `
    SELECT
      strftime(imports.reference_month, '%Y-%m-01') AS reference_month,
      imports.file_name,
      imports.value_per_note,
      strftime(imports.imported_at, '%Y-%m-%d %H:%M:%S') AS imported_at,
      coalesce((
        SELECT sum(import_cpf_summary.notes_count)
        FROM import_cpf_summary
        WHERE import_cpf_summary.import_id = imports.id
          AND ${cpfScope}
      ), 0) AS total_notes,
      coalesce((
        SELECT sum(monthly_donor_summary.abatement_amount)
        FROM monthly_donor_summary
        WHERE monthly_donor_summary.import_id = imports.id
          AND ${summaryScope}
      ), 0) AS total_abatement,
      coalesce((
        SELECT count(DISTINCT monthly_donor_summary.donor_id)
        FROM monthly_donor_summary
        WHERE monthly_donor_summary.import_id = imports.id
          AND ${summaryScope}
      ), 0) AS donor_count,
      coalesce((
        SELECT count(*)
        FROM monthly_donor_summary
        WHERE monthly_donor_summary.import_id = imports.id
          AND monthly_donor_summary.abatement_status = 'pending'
          AND ${summaryIsActionable()}
          AND ${summaryScope}
      ), 0) AS pending_count,
      coalesce((
        SELECT count(*)
        FROM monthly_donor_summary
        WHERE monthly_donor_summary.import_id = imports.id
          AND monthly_donor_summary.abatement_status = 'applied'
          AND ${summaryScope}
      ), 0) AS applied_count,
      -- CPF sem cadastro não tem doador, logo não tem projeto: é um número
      -- da planilha, igual em todos os painéis.
      coalesce((
        SELECT count(*)
        FROM import_cpf_summary
        WHERE import_cpf_summary.import_id = imports.id
          AND import_cpf_summary.is_registered_donor = FALSE
      ), 0) AS unregistered_cpf_count
    FROM imports
    WHERE imports.id = ?
    LIMIT 1
  `;
}

/**
 * O mês quebrado por demanda. Parâmetro: o id da importação.
 */
export function buildMonthBlockDemandsSql(projectId) {
  return `
    SELECT
      coalesce(nullif(trim(monthly_donor_summary.demand), ''), 'Sem demanda') AS demand,
      count(*) AS donor_count,
      sum(monthly_donor_summary.notes_count) AS total_notes,
      sum(monthly_donor_summary.abatement_amount) AS total_abatement,
      count(*) FILTER (
        WHERE monthly_donor_summary.abatement_status = 'pending'
          AND ${summaryIsActionable()}
      ) AS pending_count,
      count(*) FILTER (
        WHERE monthly_donor_summary.abatement_status = 'applied'
      ) AS applied_count
    FROM monthly_donor_summary
    WHERE monthly_donor_summary.import_id = ?
      AND ${countedSummary(projectId)}
    GROUP BY 1
    ORDER BY total_abatement DESC, total_notes DESC, demand ASC
  `;
}

/**
 * Quem ainda falta abater no mês. Parâmetro: o id da importação.
 *
 * Usa exatamente o predicado de `pending_count` acima — lista e contador
 * saindo de condições diferentes é o que fazia "Ver os 5 pendentes" abrir
 * uma lista com outras pessoas.
 */
export function buildMonthBlockPendingListSql(projectId) {
  return `
    SELECT
      monthly_donor_summary.donor_id,
      monthly_donor_summary.donor_name,
      monthly_donor_summary.cpf,
      coalesce(nullif(trim(monthly_donor_summary.demand), ''), 'Sem demanda') AS demand,
      monthly_donor_summary.notes_count,
      monthly_donor_summary.abatement_amount
    FROM monthly_donor_summary
    WHERE monthly_donor_summary.import_id = ?
      AND monthly_donor_summary.abatement_status = 'pending'
      AND ${summaryIsActionable()}
      AND ${countedSummary(projectId)}
    ORDER BY
      monthly_donor_summary.abatement_amount DESC,
      monthly_donor_summary.donor_name ASC
    LIMIT ${MONTH_BLOCK_PENDING_LIMIT}
  `;
}

/**
 * O mês anterior, para a variação, e quem estreou no mês escolhido.
 *
 * Parâmetros, nesta ordem: id da importação anterior (três vezes) e o mês
 * escolhido (`YYYY-MM-01`). Sem mês anterior, passe um id que não existe: a
 * consulta devolve zeros.
 */
export function buildMonthBlockComparisonSql(projectId) {
  const summaryScope = countedSummary(projectId);

  return `
    SELECT
      coalesce((
        SELECT sum(import_cpf_summary.notes_count)
        FROM import_cpf_summary
        WHERE import_cpf_summary.import_id = ?
          AND ${countedCpfSummary(projectId)}
      ), 0) AS previous_notes,
      coalesce((
        SELECT sum(monthly_donor_summary.abatement_amount)
        FROM monthly_donor_summary
        WHERE monthly_donor_summary.import_id = ?
          AND ${summaryScope}
      ), 0) AS previous_abatement,
      coalesce((
        SELECT count(DISTINCT monthly_donor_summary.donor_id)
        FROM monthly_donor_summary
        WHERE monthly_donor_summary.import_id = ?
          AND ${summaryScope}
      ), 0) AS previous_donors,
      -- "Estreou" é sobre o cadastro de hoje: quem é doador deste projeto
      -- agora e começou a doar neste mês.
      coalesce((
        SELECT count(*)
        FROM donors
        WHERE donors.is_active = TRUE
          AND strftime(donors.donation_start_date, '%Y-%m-01') = ?
          AND ${donorBelongsToProject("donors.id", projectId)}
      ), 0) AS new_donors
  `;
}
