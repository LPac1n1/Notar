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
 * O mês em que o doador foi desativado pela ÚLTIMA vez — o "inativo a partir
 * de" que o usuário informou. NULL se ele nunca foi desativado pelo sistema.
 *
 * `donorIdExpr` é a expressão SQL do id do doador na consulta de fora.
 */
export function lastDeactivationMonthOf(donorIdExpr) {
  return `(
    SELECT max(deactivation_event.reference_month)
    FROM donor_activity_history AS deactivation_event
    WHERE deactivation_event.donor_id = ${donorIdExpr}
      AND deactivation_event.event_type = 'deactivated'
  )`;
}

/**
 * "As doações deste doador CONTAM neste mês?"
 *
 *   • doador ativo: contam em todos os meses;
 *   • doador inativo: contam os meses ANTERIORES ao mês da desativação. Do
 *     mês da desativação em diante, não — até ele ser reativado.
 *
 * Desativar não reescreve o passado: os meses em que ele doou como ativo
 * foram apurados e abatidos, e continuam nos totais, nas listas e nos
 * relatórios. Reativar traz de volta tudo o que ficou de fora, com o status
 * de abatimento que cada mês tinha — por isso o critério é só de LEITURA:
 * nenhuma linha é apagada quando o doador é desativado (`reconcileImport`
 * continua gerando o resumo dele).
 *
 * Doador inativo SEM evento de desativação (cadastro anterior ao histórico)
 * não conta em mês nenhum: não há como saber desde quando.
 *
 * Para consultas que já têm `donors` no FROM. `monthExpr` é a expressão SQL
 * do mês da linha (uma coluna DATE ou `CAST(? AS DATE)` — aparece uma vez
 * só, então pode ser parâmetro).
 *
 * Toda tela que soma, conta ou lista doação por mês usa esta condição. Antes
 * cada uma tinha a sua, e o doador sumia da lista e continuava no painel.
 *
 * Os dois `coalesce` fazem a condição ser sempre TRUE ou FALSE, nunca NULL:
 * quem a nega (`NOT …`, para listar os inativos) receberia NULL de um doador
 * sem evento de desativação, e a linha sumiria dos dois lados.
 */
export function donorCountsAtMonth(monthExpr, donorAlias = "donors") {
  return `(
    coalesce(${donorAlias}.is_active, FALSE)
    OR coalesce(
      ${monthExpr} < ${lastDeactivationMonthOf(`${donorAlias}.id`)},
      FALSE
    )
  )`;
}

/**
 * A mesma regra em JavaScript, para a linha que é montada fora do SQL (o
 * acumulado sem resumo do mês, na visão histórica). Fica ao lado da versão
 * SQL de propósito: são a mesma regra e mudam juntas.
 *
 * `month` e `lastDeactivationMonth` no formato `YYYY-MM-01`.
 */
export function donorCountsAtMonthValue(
  { isActive, lastDeactivationMonth } = {},
  month,
) {
  if (isActive !== false) {
    return true;
  }

  const deactivation = String(lastDeactivationMonth ?? "").slice(0, 7);
  const target = String(month ?? "").slice(0, 7);

  return Boolean(deactivation && target && target < deactivation);
}

/** A regra, para uma linha de `monthly_donor_summary`. */
export function summaryDonorCounts(alias = "monthly_donor_summary") {
  return `EXISTS (
    SELECT 1
    FROM donors AS counted_donor
    WHERE counted_donor.id = ${alias}.donor_id
      AND ${donorCountsAtMonth(`${alias}.reference_month`, "counted_donor")}
  )`;
}

/** A regra, para uma linha de `import_cpf_summary`: o doador dono do CPF. */
export function cpfSummaryDonorCounts(alias = "import_cpf_summary") {
  return `EXISTS (
    SELECT 1
    FROM donor_cpf_links AS counted_cpf_link
    INNER JOIN donors AS counted_cpf_donor
      ON counted_cpf_donor.id = counted_cpf_link.donor_id
    WHERE counted_cpf_link.id = ${alias}.matched_source_id
      AND ${donorCountsAtMonth(`${alias}.reference_month`, "counted_cpf_donor")}
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
