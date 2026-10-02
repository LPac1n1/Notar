import { query, queryPrepared } from "./db";
import { getActiveProjectId } from "./activeProject.js";
import {
  cpfLinkBelongsToProject,
  donorBelongedToProjectAtMonth,
  donorBelongsToProject,
  MATCHED_CREDIT_BY_DONOR_MONTH,
} from "./project/projectAssignmentSql.js";
import { buildMonthlyTrendSql } from "./dashboard/monthlyTrendSql.js";
import { summaryDonorCounts } from "./monthly/summaryScopeSql.js";
import {
  buildMonthBlockComparisonSql,
  buildMonthBlockDemandsSql,
  buildMonthBlockPendingListSql,
  buildMonthBlockSummarySql,
} from "./dashboard/monthBlockSql.js";
// A mesma consulta que alimenta o painel de projetos de crédito. Reusá-la faz
// o crédito do mês bater por construção entre as duas telas, em vez de depender
// de duas somas escritas separadamente continuarem concordando.
import { buildProjectCreditByMonthSql } from "./dashboard/projectCreditSql.js";
import {
  buildTopDonorsQuery,
  TOP_DONOR_FILTER_OPTIONS_SQL,
  TOP_DONOR_SORT_OPTIONS,
} from "./dashboard/topDonorsSql.js";
import { getReconciliationStats } from "./reconciliation/creditReconciliationService";
import {
  INACTIVITY_ALERT_THRESHOLD,
  mapInactivityRow,
} from "./monthly/inactivityStreaks";
import { buildDonorInactivityStreaksSql } from "./monthly/inactivityStreaksSql";
import { getCached, setCached } from "./queryCache.js";

// A chave inclui o projeto E o mês escolhido: sem o projeto, trocar de
// projeto serviria o panorama do anterior; sem o mês, trocar de mês
// devolveria o mês anterior a partir do cache.
const dashboardCacheKey = (referenceMonth) =>
  `dashboard:overview:${getActiveProjectId()}:${referenceMonth || "ultimo"}`;
const DASHBOARD_TTL_MS = 30_000;

function toNumber(value) {
  return Number(value ?? 0);
}

export { TOP_DONOR_SORT_OPTIONS };

/**
 * Ranking de doadores com recorte por mês e por demanda.
 *
 * Vive fora do payload de `getDashboardOverview` porque é o único bloco do
 * dashboard que o usuário filtra: recarregá-lo não deve reprocessar as ~13
 * agregações do panorama geral.
 *
 * Sem `referenceMonth` o ranking é histórico (soma de todos os meses); com
 * mês, `imported_month_count` vale 1 por construção e a UI esconde a coluna.
 */
export async function listTopDonors(filters = {}) {
  const { sql, params } = buildTopDonorsQuery({
    ...filters,
    projectId: getActiveProjectId(),
  });
  const rows = await queryPrepared(sql, params);

  return rows.map((row) => ({
    donorId: row.donor_id,
    donorName: row.donor_name,
    demand: row.demand,
    totalNotes: toNumber(row.total_notes),
    totalAbatement: toNumber(row.total_abatement),
    importedMonthCount: toNumber(row.imported_month_count),
  }));
}

/**
 * Opções dos filtros do ranking. Derivadas do que existe em
 * `monthly_donor_summary` — e não de `imports`/`demands` — para que nenhum
 * filtro oferecido devolva lista vazia.
 */
/**
 * Série dos últimos meses para o gráfico de evolução. Devolvida em ordem
 * cronológica (a query busca os mais recentes primeiro).
 */
export async function listMonthlyTrend() {
  const rows = await query(buildMonthlyTrendSql(getActiveProjectId()));

  return rows
    .map((row) => ({
      referenceMonth: row.reference_month,
      totalNotes: toNumber(row.total_notes),
      totalAbatement: toNumber(row.total_abatement),
      donorCount: toNumber(row.donor_count),
      totalCredit: toNumber(row.total_credit),
      netGain: toNumber(row.net_gain),
    }))
    .reverse();
}

export async function getTopDonorFilterOptions() {
  const [monthRows, demandRows] = await Promise.all([
    query(TOP_DONOR_FILTER_OPTIONS_SQL.months(getActiveProjectId())),
    query(TOP_DONOR_FILTER_OPTIONS_SQL.demands(getActiveProjectId())),
  ]);

  return {
    months: monthRows.map((row) => row.reference_month).filter(Boolean),
    demands: demandRows.map((row) => row.demand).filter(Boolean),
  };
}

/*
 * Dashboard overview is composed from many independent aggregation queries.
 * They are dispatched in two `Promise.all` phases so DuckDB-WASM (single
 * threaded) batches them efficiently:
 *
 *   Phase 1: queries that depend only on the live tables — totals, recent
 *            imports, active donors/demands, and the "inconsistency" probes
 *            plus their detail rows.
 *   Phase 2: 4 queries that target the latest processed import (so they
 *            need its id from Phase 1 first).
 *
 * Sequential round-trips were measurable on real data — five years of
 * imports made the dashboard take 800-1200ms to first paint. With the
 * Promise.all groups we land in 200-300ms because DuckDB pipelines the
 * statements internally.
 */
/**
 * `referenceMonth` escolhe o mês do bloco mensal. Sem ele, o mais recente.
 *
 * O painel inteiro NÃO muda de mês: cadastros, inconsistências e totais do
 * projeto não pertencem a competência nenhuma. O que o mês recorta é o bloco
 * de apuração — notas, abatimento, demandas, participação.
 */
export async function getDashboardOverview({ referenceMonth = "" } = {}) {
  const cached = getCached(dashboardCacheKey(referenceMonth));
  if (cached !== undefined) return cached;

  const result = await _fetchDashboardOverview(referenceMonth);
  setCached(dashboardCacheKey(referenceMonth), result, DASHBOARD_TTL_MS);
  return result;
}

async function _fetchDashboardOverview(referenceMonth) {
  // O dashboard é do PROJETO ATIVO. Tudo que deriva de doador ou de demanda
  // ganha o recorte; importação e conciliação NÃO, porque a base é uma só
  // para toda a plataforma — os números delas são a verdade compartilhada.
  const projectId = getActiveProjectId();
  const donorScope = donorBelongsToProject("donors.id", projectId);
  const cpfLinkScope = cpfLinkBelongsToProject(
    "import_cpf_summary.matched_source_id",
    projectId,
  );
  const [
    totalsRows,
    recentImportsRows,
    activeDonorRows,
    activeDemandRows,
    inconsistencyCountRows,
    donationStartConflictRows,
    donorWithoutDemandRows,
    donorWithoutStartDateRows,
    emptyImportRows,
    importErrorRows,
    inactivityStreakRows,
    reconciliationStats,
    creditByMonthRows,
  ] = await Promise.all([
    query(`
      SELECT
        (SELECT count(*) FROM donors WHERE is_active = TRUE AND ${donorScope}) AS donor_count,
        (SELECT count(*) FROM demands WHERE is_active = TRUE AND project_id = '${projectId}') AS demand_count,
        (SELECT coalesce(sum(monthly_donor_summary.notes_count), 0)
         FROM monthly_donor_summary
         WHERE ${donorBelongedToProjectAtMonth(
           "monthly_donor_summary.donor_id",
           "monthly_donor_summary.reference_month",
           projectId,
         )}
           AND ${summaryDonorCounts()}) AS notes_count,
        (SELECT coalesce(sum(monthly_donor_summary.invalid_notes_count), 0)
         FROM monthly_donor_summary
         WHERE ${donorBelongedToProjectAtMonth(
           "monthly_donor_summary.donor_id",
           "monthly_donor_summary.reference_month",
           projectId,
         )}
           AND ${summaryDonorCounts()}) AS invalid_notes_count,
        (SELECT coalesce(sum(project_credit.total_credit), 0) FROM (
          WITH credit AS (${MATCHED_CREDIT_BY_DONOR_MONTH})
          SELECT credit.total_credit
          FROM credit
          WHERE ${donorBelongedToProjectAtMonth(
            "credit.donor_id",
            "CAST(credit.reference_month AS DATE)",
            projectId,
          )}
        ) AS project_credit) AS total_credit,
        (SELECT coalesce(sum(monthly_donor_summary.abatement_amount), 0)
         FROM monthly_donor_summary
         WHERE monthly_donor_summary.abatement_status = 'applied'
           AND ${summaryDonorCounts()}
           AND ${donorBelongedToProjectAtMonth(
             "monthly_donor_summary.donor_id",
             "monthly_donor_summary.reference_month",
             projectId,
           )}) AS total_abated
    `),
    query(`
      SELECT
        id,
        strftime(reference_month, '%Y-%m-01') AS reference_month,
        file_name,
        value_per_note,
        matched_rows,
        matched_donors,
        strftime(imported_at, '%Y-%m-%d %H:%M:%S') AS imported_at
      FROM imports
      WHERE status = 'processed'
      ORDER BY reference_month DESC, imported_at DESC
    `),
    query(`
      SELECT
        id,
        name,
        cpf,
        demand,
        strftime(donation_start_date, '%Y-%m-01') AS donation_start_date
      FROM donors
      WHERE is_active = TRUE
        AND ${donorScope}
      ORDER BY name ASC
      LIMIT 20
    `),
    query(`
      SELECT
        demands.id,
        demands.name,
        count(donors.id) AS donor_count
      FROM demands
      LEFT JOIN donors
        ON lower(trim(donors.demand)) = lower(trim(demands.name))
        AND donors.is_active = TRUE
        AND ${donorScope}
      WHERE demands.is_active = TRUE
        AND demands.project_id = '${projectId}'
      GROUP BY demands.id, demands.name
      ORDER BY demands.name ASC
      LIMIT 20
    `),
    query(`
      SELECT
        (SELECT count(*)
         FROM import_cpf_summary
         INNER JOIN donor_cpf_links
           ON donor_cpf_links.id = import_cpf_summary.matched_source_id
         WHERE donor_cpf_links.donation_start_date IS NOT NULL
           AND import_cpf_summary.reference_month < donor_cpf_links.donation_start_date
           AND ${cpfLinkScope}) AS donation_start_conflict_count,
        (SELECT count(*)
         FROM donors
         WHERE is_active = TRUE
           AND coalesce(trim(demand), '') = ''
           AND ${donorScope}) AS donor_without_demand_count,
        (SELECT count(*)
         FROM donor_cpf_links
         INNER JOIN donors
           ON donors.id = donor_cpf_links.donor_id
         WHERE donor_cpf_links.is_active = TRUE
           AND donors.is_active = TRUE
           AND donor_cpf_links.donation_start_date IS NULL
           AND ${donorScope}) AS donor_without_start_date_count,
        (SELECT count(*)
         FROM imports
         WHERE status = 'processed'
           AND coalesce(total_rows, 0) = 0) AS empty_import_count,
        (SELECT count(*)
         FROM imports
         WHERE status = 'error') AS import_error_count
    `),
    query(`
      SELECT
        donor_cpf_links.name AS source_name,
        donor_cpf_links.cpf,
        donors.id AS donor_id,
        donors.name AS donor_name,
        donors.donor_type,
        strftime(import_cpf_summary.reference_month, '%Y-%m-01') AS reference_month,
        strftime(donor_cpf_links.donation_start_date, '%Y-%m-01') AS donation_start_date
      FROM import_cpf_summary
      INNER JOIN donor_cpf_links
        ON donor_cpf_links.id = import_cpf_summary.matched_source_id
      INNER JOIN donors
        ON donors.id = donor_cpf_links.donor_id
      WHERE donor_cpf_links.donation_start_date IS NOT NULL
        AND import_cpf_summary.reference_month < donor_cpf_links.donation_start_date
        AND ${donorScope}
      ORDER BY import_cpf_summary.reference_month DESC, donor_cpf_links.name ASC
      LIMIT 500
    `),
    query(`
      SELECT
        id,
        name,
        cpf
      FROM donors
      WHERE is_active = TRUE
        AND coalesce(trim(demand), '') = ''
        AND ${donorScope}
      ORDER BY name ASC
      LIMIT 500
    `),
    // Traz também o histórico de doações de cada CPF. Sem isso não dá para
    // saber qual início informar: quem já doou precisa de um mês que COBRE a
    // primeira nota — preencher com um mês posterior fecha esta pendência e
    // abre uma "Doações antes do início" no lugar.
    query(`
      SELECT
        donor_cpf_links.id,
        donor_cpf_links.name,
        donor_cpf_links.cpf,
        donors.donor_type,
        donors.id AS donor_id,
        donors.name AS donor_name,
        donors.demand,
        donation_history.first_month,
        donation_history.last_month,
        donation_history.total_notes,
        donation_history.month_count,
        -- Auxiliares ATIVOS deste titular. O recorte por "ativo" não é
        -- cosmético: é exatamente a condição que faz deleteDonor preservar
        -- a linha em people em vez de removê-la junto, ou seja, o que decide
        -- se dá para converter o titular em pessoa de referência.
        coalesce((
          SELECT string_agg(aux_rows.aux_name, ', ')
          FROM (
            SELECT auxiliary_donors.name AS aux_name
            FROM donors AS auxiliary_donors
            WHERE auxiliary_donors.holder_person_id = donors.person_id
              AND auxiliary_donors.donor_type = 'auxiliary'
              AND auxiliary_donors.is_active = TRUE
            ORDER BY auxiliary_donors.name ASC
          ) AS aux_rows
        ), '') AS auxiliary_names,
        (
          SELECT count(*)
          FROM donors AS auxiliary_donors
          WHERE auxiliary_donors.holder_person_id = donors.person_id
            AND auxiliary_donors.donor_type = 'auxiliary'
            AND auxiliary_donors.is_active = TRUE
        ) AS auxiliary_count,
        -- Caminho inverso: o titular a que este auxiliar está vinculado.
        coalesce((
          SELECT holder_donors.name
          FROM donors AS holder_donors
          WHERE holder_donors.person_id = donors.holder_person_id
            AND holder_donors.is_active = TRUE
          LIMIT 1
        ), '') AS holder_name
      FROM donor_cpf_links
      INNER JOIN donors
        ON donors.id = donor_cpf_links.donor_id
      LEFT JOIN (
        SELECT
          matched_source_id,
          strftime(min(reference_month), '%Y-%m-01') AS first_month,
          strftime(max(reference_month), '%Y-%m-01') AS last_month,
          sum(notes_count) AS total_notes,
          count(DISTINCT reference_month) AS month_count
        FROM import_cpf_summary
        WHERE matched_source_id IS NOT NULL
        GROUP BY matched_source_id
      ) AS donation_history
        ON donation_history.matched_source_id = donor_cpf_links.id
      WHERE donor_cpf_links.is_active = TRUE
        AND donors.is_active = TRUE
        AND donor_cpf_links.donation_start_date IS NULL
        AND ${donorScope}
      -- Quem já doou vem primeiro: são os casos que estão gerando nota sem
      -- início declarado, e portanto os mais urgentes.
      ORDER BY (donation_history.first_month IS NULL) ASC, donor_cpf_links.name ASC
      LIMIT 500
    `),
    query(`
      SELECT
        id,
        strftime(reference_month, '%Y-%m-01') AS reference_month,
        file_name,
        total_rows
      FROM imports
      WHERE status = 'processed'
        AND coalesce(total_rows, 0) = 0
      ORDER BY reference_month DESC, imported_at DESC
      LIMIT 500
    `),
    query(`
      SELECT
        id,
        strftime(reference_month, '%Y-%m-01') AS reference_month,
        file_name,
        notes
      FROM imports
      WHERE status = 'error'
      ORDER BY updated_at DESC
      LIMIT 500
    `),
    query(buildDonorInactivityStreaksSql(projectId)),
    getReconciliationStats(),
    query(buildProjectCreditByMonthSql(projectId)),
  ]);

  // Crédito conciliado por mês, do projeto. Vira mapa para o bloco mensal
  // pegar o mês escolhido sem varrer a lista de novo.
  //
  // O total de todos os meses já vem em `totals.totalCredit`, da MESMA origem
  // (`MATCHED_CREDIT_BY_DONOR_MONTH` com o mesmo recorte de projeto) — por
  // isso não é somado aqui de novo: duas somas independentes do mesmo número
  // é exatamente o que faz duas telas discordarem com o tempo.
  const creditByMonth = new Map(
    creditByMonthRows.map((row) => [
      row.reference_month,
      toNumber(row.total_credit),
    ]),
  );

  // Donors that stopped sending notes for N consecutive imported months.
  // The SQL returns every active donor (streak 0 included) already sorted by
  // streak desc, so the "call list" is just the head of it above the alert
  // threshold — no second query needed.
  const inactiveDonors = inactivityStreakRows
    .map(mapInactivityRow)
    .filter(
      (row) => row.monthsWithoutDonating >= INACTIVITY_ALERT_THRESHOLD,
    );

  // A lista de meses com importação processada alimenta o seletor. Sai de
  // `recentImports`, que já vem ordenada do mais recente para o mais antigo.
  const availableMonths = [
    ...new Set(recentImportsRows.map((row) => row.reference_month).filter(Boolean)),
  ];

  const newestImport = recentImportsRows[0] ?? null;
  // Mês pedido que não existe cai no mais recente em vez de esvaziar a tela:
  // pode ser um link antigo, ou a importação daquele mês foi apagada.
  const selectedImport =
    (referenceMonth &&
      recentImportsRows.find((row) => row.reference_month === referenceMonth)) ||
    newestImport;
  const latestImport = selectedImport;

  let latestMonth = null;
  let demandBreakdown = [];
  let latestMonthPendingSummaries = [];
  let latestMonthUnregisteredCpfSamples = [];
  // Per-month reconciliation roll-up. Globally we already have
  // `reconciliationStats`; the month-scoped variant gives the dashboard
  // a "atual: X% casado" KPI without forcing the user to leave the
  // overview. Only computed once we know the latest reference_month —
  // there's no point hitting the table for a month that doesn't exist.
  let reconciliationLatestMonth = null;

  if (latestImport) {
    const latestImportId = latestImport.id;
    const selectedMonthKey = latestImport.reference_month ?? "";
    // O mês anterior é o vizinho na lista de importações processadas, e não
    // o mês do calendário: se março não foi importado, o anterior a abril é
    // fevereiro. Comparar com um mês vazio diria que a arrecadação despencou.
    const selectedIndex = recentImportsRows.findIndex(
      (row) => row.id === latestImportId,
    );
    const previousImport =
      selectedIndex >= 0 ? (recentImportsRows[selectedIndex + 1] ?? null) : null;
    // Sem mês anterior, a consulta roda com um id que não casa com nada e
    // devolve zeros — mais simples que ramificar a fase inteira.
    const previousImportId = previousImport?.id ?? "";
    // Phase 2: four queries narrowed to the latest import. Bind the id via
    // prepared parameters since the value originated from the previous
    // query's result row (string-built it would be safe today, but prepared
    // matches the convention used elsewhere in this codebase).
    const [
      latestMonthRows,
      demandRows,
      latestPendingRows,
      latestUnregisteredRows,
      comparisonRows,
    ] = await Promise.all([
      // As consultas do bloco mensal vivem em `dashboard/monthBlockSql.js`:
      // todas usam o mesmo recorte de projeto (o vínculo NO MÊS) e a mesma
      // definição de pendente da Gestão Mensal.
      queryPrepared(buildMonthBlockSummarySql(projectId), [latestImportId]),
      queryPrepared(buildMonthBlockDemandsSql(projectId), [latestImportId]),
      queryPrepared(buildMonthBlockPendingListSql(projectId), [latestImportId]),
      queryPrepared(
        `
          SELECT
            cpf,
            notes_count
          FROM import_cpf_summary
          WHERE import_id = ?
            AND is_registered_donor = FALSE
          ORDER BY notes_count DESC, cpf ASC
        `,
        [latestImportId],
      ),
      // O mês anterior e os doadores que estrearam no mês escolhido.
      //
      // Um número sozinho não diz se o mês foi bom: 1.200 notas é ótimo
      // depois de 900 e preocupante depois de 1.500. A comparação vem da
      // MESMA ida ao banco para não abrir a chance de descrever um estado
      // diferente do bloco que ela acompanha.
      //
      // `previousImportId` pode ser nulo — no primeiro mês não há anterior —,
      // e aí a consulta devolve zeros que o mapeamento converte em ausência
      // de comparação.
      queryPrepared(buildMonthBlockComparisonSql(projectId), [
        previousImportId,
        previousImportId,
        previousImportId,
        selectedMonthKey,
      ]),
    ]);

    latestMonth = latestMonthRows[0]
      ? {
          referenceMonth: latestMonthRows[0].reference_month,
          fileName: latestMonthRows[0].file_name,
          valuePerNote: toNumber(latestMonthRows[0].value_per_note),
          importedAt: latestMonthRows[0].imported_at,
          totalNotes: toNumber(latestMonthRows[0].total_notes),
          totalAbatement: toNumber(latestMonthRows[0].total_abatement),
          // Crédito que a NFP de fato pagou pelas notas deste mês, já
          // conciliado. Fica ao lado de "A abater" de propósito: um é o que o
          // projeto vai descontar, o outro é o que entrou — e a diferença
          // entre os dois é a pergunta que o painel existe para responder.
          totalCredit: creditByMonth.get(latestMonthRows[0].reference_month) ?? 0,
          donorCount: toNumber(latestMonthRows[0].donor_count),
          pendingCount: toNumber(latestMonthRows[0].pending_count),
          appliedCount: toNumber(latestMonthRows[0].applied_count),
          unregisteredCpfCount: toNumber(latestMonthRows[0].unregistered_cpf_count),
          newDonorCount: toNumber(comparisonRows[0]?.new_donors),
          // Nulo quando não há mês anterior importado: a tela mostra o
          // indicador sem variação, em vez de uma queda de 100% inventada.
          previous: previousImport
            ? {
                referenceMonth: previousImport.reference_month,
                totalNotes: toNumber(comparisonRows[0]?.previous_notes),
                totalAbatement: toNumber(comparisonRows[0]?.previous_abatement),
                totalCredit: creditByMonth.get(previousImport.reference_month) ?? 0,
                donorCount: toNumber(comparisonRows[0]?.previous_donors),
              }
            : null,
        }
      : null;

    if (latestMonth) {
      reconciliationLatestMonth = await getReconciliationStats({
        referenceMonth: latestMonth.referenceMonth,
      }).catch(() => null);
    }

    demandBreakdown = demandRows.map((row) => ({
      demand: row.demand,
      donorCount: toNumber(row.donor_count),
      totalNotes: toNumber(row.total_notes),
      totalAbatement: toNumber(row.total_abatement),
      pendingCount: toNumber(row.pending_count),
      appliedCount: toNumber(row.applied_count),
    }));

    latestMonthPendingSummaries = latestPendingRows.map((row) => ({
      donorId: row.donor_id,
      donorName: row.donor_name,
      cpf: row.cpf,
      demand: row.demand,
      notesCount: toNumber(row.notes_count),
      abatementAmount: toNumber(row.abatement_amount),
    }));

    latestMonthUnregisteredCpfSamples = latestUnregisteredRows.map((row) => ({
      cpf: row.cpf,
      notesCount: toNumber(row.notes_count),
    }));
  }

  const inconsistencyCounts = inconsistencyCountRows[0] ?? {};

  return {
    totals: {
      donorCount: toNumber(totalsRows[0]?.donor_count),
      demandCount: toNumber(totalsRows[0]?.demand_count),
      notesCount: toNumber(totalsRows[0]?.notes_count),
      invalidNotesCount: toNumber(totalsRows[0]?.invalid_notes_count),
      totalCredit: toNumber(totalsRows[0]?.total_credit),
      totalAbated: toNumber(totalsRows[0]?.total_abated),
    },
    // O bloco do mês ESCOLHIDO. `newestMonth` é o mês mais recente com
    // importação, e serve ao aviso de atraso — que não pode olhar o mês
    // selecionado, senão abrir um mês antigo acusaria atraso inexistente.
    month: latestMonth,
    newestMonth: newestImport?.reference_month ?? null,
    availableMonths,
    latestMonthPendingSummaries,
    latestMonthUnregisteredCpfSamples,
    activeDonors: activeDonorRows.map((row) => ({
      donorId: row.id,
      donorName: row.name,
      cpf: row.cpf,
      demand: row.demand ?? "",
      donationStartDate: row.donation_start_date ?? "",
    })),
    activeDemands: activeDemandRows.map((row) => ({
      demandId: row.id,
      demandName: row.name,
      donorCount: toNumber(row.donor_count),
    })),
    demandBreakdown,
    // O ranking de maiores doadores NÃO vem daqui: é filtrável por mês e
    // demanda, então tem seu próprio recurso (`listTopDonors`) e recarrega
    // sozinho, sem reprocessar as agregações do panorama.
    inconsistencies: {
      donationStartConflictCount: toNumber(
        inconsistencyCounts.donation_start_conflict_count,
      ),
      donorWithoutDemandCount: toNumber(
        inconsistencyCounts.donor_without_demand_count,
      ),
      donorWithoutStartDateCount: toNumber(
        inconsistencyCounts.donor_without_start_date_count,
      ),
      emptyImportCount: toNumber(
        inconsistencyCounts.empty_import_count,
      ),
      importErrorCount: toNumber(
        inconsistencyCounts.import_error_count,
      ),
      inactiveDonorCount: inactiveDonors.length,
      // Full list, not a 5-row sample: this one is meant to be worked
      // through (call each donor and check if they're still registered).
      inactiveDonors,
      donationStartConflictRows: donationStartConflictRows.map((row) => ({
        sourceName: row.source_name,
        donorId: row.donor_id,
        donorName: row.donor_name,
        donorType: row.donor_type,
        cpf: row.cpf,
        referenceMonth: row.reference_month,
        donationStartDate: row.donation_start_date,
      })),
      donorWithoutDemandRows: donorWithoutDemandRows.map((row) => ({
        donorId: row.id,
        donorName: row.name,
        cpf: row.cpf,
      })),
      donorWithoutStartDateRows: donorWithoutStartDateRows.map((row) => ({
        sourceId: row.id,
        sourceName: row.name,
        sourceType: row.donor_type,
        donorId: row.donor_id,
        donorName: row.donor_name,
        cpf: row.cpf,
        demand: row.demand ?? "",
        firstDonationMonth: row.first_month ?? "",
        lastDonationMonth: row.last_month ?? "",
        totalNotes: toNumber(row.total_notes),
        donatedMonthCount: toNumber(row.month_count),
        auxiliaryNames: row.auxiliary_names
          ? String(row.auxiliary_names).split(", ").filter(Boolean)
          : [],
        auxiliaryCount: toNumber(row.auxiliary_count),
        holderName: row.holder_name ?? "",
      })),
      emptyImportRows: emptyImportRows.map((row) => ({
        importId: row.id,
        referenceMonth: row.reference_month,
        fileName: row.file_name,
        totalRows: toNumber(row.total_rows),
      })),
      importErrorRows: importErrorRows.map((row) => ({
        importId: row.id,
        referenceMonth: row.reference_month,
        fileName: row.file_name,
        notes: row.notes ?? "",
      })),
    },
    reconciliation: reconciliationStats,
    reconciliationLatestMonth,
  };
}

