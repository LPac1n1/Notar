import { donorBelongedToProjectAtMonth } from "../project/projectAssignmentSql.js";

/**
 * "Esta linha do resumo mensal conta para a apuração deste projeto?"
 *
 * Fragmentos de SQL compartilhados por TODA tela que soma ou conta linhas de
 * `monthly_donor_summary` — Gestão Mensal, Dashboard, visão por mês de
 * Importações. Existem porque cada tela tinha a sua própria definição, e elas
 * discordavam: o Dashboard anunciava abatimentos pendentes que a Gestão
 * Mensal não mostrava, e não havia como o usuário "resolver" o que só uma
 * das duas enxergava.
 *
 * Módulo puro (sem import de banco) para o teste de integração rodar estas
 * condições contra o DuckDB. Node ESM não resolve import sem extensão: quem
 * importa este arquivo usa `.js` explícito.
 */

/**
 * A linha é do projeto quando o doador pertencia a ele NO MÊS da linha.
 *
 * Não é o vínculo de hoje: um doador transferido em abril tem março na
 * apuração do projeto antigo. E não é "qualquer linha do mês": um projeto sem
 * apuração mensal também gera linhas aqui (o resumo nasce de toda planilha
 * importada), e elas ficam `pending` para sempre porque ninguém as abate.
 */
export function summaryBelongsToProject(
  projectId,
  alias = "monthly_donor_summary",
) {
  return donorBelongedToProjectAtMonth(
    `${alias}.donor_id`,
    `${alias}.reference_month`,
    projectId,
  );
}

/**
 * A linha representa trabalho que o usuário CONSEGUE fazer.
 *
 * Duas situações deixam `abatement_status = 'pending'` no banco sem que haja
 * nada a marcar — e a Gestão Mensal não oferece o botão em nenhuma delas:
 *
 *   • sem nota no mês (`notes_count = 0`): a tela mostra "Sem doações no mês";
 *
 *   • mês coberto por um acumulado lançado em OUTRO mês: a tela mostra "Via
 *     acumulado" com o seletor travado, porque o valor já foi abatido junto
 *     do mês do acumulado (ver `markSubsumedRows`). O status cru dessas
 *     linhas continua `pending` para sempre.
 *
 * Contar `pending` sem esta condição gera pendência impossível de resolver.
 */
export function summaryIsActionable(alias = "monthly_donor_summary") {
  return `(
    coalesce(${alias}.notes_count, 0) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM abatement_adjustments AS covering_adjustment
      WHERE covering_adjustment.donor_id = ${alias}.donor_id
        AND covering_adjustment.reference_month <> ${alias}.reference_month
        AND covering_adjustment.range_start_month <= ${alias}.reference_month
        AND covering_adjustment.range_end_month >= ${alias}.reference_month
    )
  )`;
}

/**
 * O doador da linha está ATIVO.
 *
 * Desativar um doador tira as doações dele da apuração — listas, totais,
 * painel, planilha de abatimento — e reativar traz tudo de volta. Por isso o
 * critério é só de LEITURA: nenhuma linha é apagada quando o doador é
 * desativado (`reconcileImport` continua gerando o resumo dele), e o status
 * de abatimento de cada mês fica guardado para quando ele voltar.
 *
 * É a mesma regra que a lista da Gestão Mensal sempre usou
 * (`donors.is_active = TRUE`). O que faltava era as outras telas a seguirem:
 * o doador sumia da lista e continuava no painel, na visão por mês e na
 * planilha que vai para o sistema de baixa.
 *
 * Se um dia a regra virar "não conta a partir do mês da desativação", é
 * aqui — e em `cpfSummaryDonorIsActive` — que ela muda.
 */
export function summaryDonorIsActive(alias = "monthly_donor_summary") {
  return `EXISTS (
    SELECT 1
    FROM donors AS counted_donor
    WHERE counted_donor.id = ${alias}.donor_id
      AND counted_donor.is_active = TRUE
  )`;
}

/** O mesmo, para linhas de `import_cpf_summary`: o doador dono do CPF. */
export function cpfSummaryDonorIsActive(alias = "import_cpf_summary") {
  return `EXISTS (
    SELECT 1
    FROM donor_cpf_links AS counted_cpf_link
    INNER JOIN donors AS counted_cpf_donor
      ON counted_cpf_donor.id = counted_cpf_link.donor_id
    WHERE counted_cpf_link.id = ${alias}.matched_source_id
      AND counted_cpf_donor.is_active = TRUE
  )`;
}

/**
 * Mesma ideia de `summaryBelongsToProject`, para linhas de
 * `import_cpf_summary`: o CPF casou com um doador que pertencia ao projeto
 * no mês da planilha.
 */
export function cpfSummaryBelongsToProject(
  projectId,
  alias = "import_cpf_summary",
) {
  return `EXISTS (
    SELECT 1
    FROM donor_cpf_links AS scoped_cpf_link
    WHERE scoped_cpf_link.id = ${alias}.matched_source_id
      AND ${donorBelongedToProjectAtMonth(
        "scoped_cpf_link.donor_id",
        `${alias}.reference_month`,
        projectId,
      )}
  )`;
}
