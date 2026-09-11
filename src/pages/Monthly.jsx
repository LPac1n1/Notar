import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import DataSyncSectionLoading from "../components/ui/DataSyncSectionLoading";
import EmptyState from "../components/ui/EmptyState";
import FeedbackMessage from "../components/ui/FeedbackMessage";
import LoadingScreen from "../components/ui/LoadingScreen";
import PageHeader from "../components/ui/PageHeader";
import SectionCard from "../components/ui/SectionCard";
import { SkeletonRows } from "../components/ui/Skeleton";
import { ChevronDownIcon } from "../components/ui/icons";
import { INITIAL_MONTHLY_FILTERS } from "../features/monthly/constants";
import BulkAbatementModal from "../features/monthly/components/BulkAbatementModal";
import CatchUpAdjustmentModal from "../features/donors/components/CatchUpAdjustmentModal";
import ConsolidatedPendingDonors from "../features/monthly/components/ConsolidatedPendingDonors";
import ImportedMonthsCarousel from "../features/monthly/components/ImportedMonthsCarousel";
import BulkActionBar from "../features/monthly/components/BulkActionBar";
import MonthlyFiltersBar from "../features/monthly/components/MonthlyFiltersBar";
import MonthlySummaryList from "../features/monthly/components/MonthlySummaryList";
import MonthlySummaryToolbar from "../features/monthly/components/MonthlySummaryToolbar";
import MonthSwitcher from "../features/monthly/components/MonthSwitcher";
import FirstVisitHint from "../components/ui/FirstVisitHint";
import { useConsolidatedMonthlyDonors } from "../features/monthly/hooks/useConsolidatedMonthlyDonors";
import { useMonthlyOverviewMetrics } from "../features/monthly/hooks/useMonthlyOverviewMetrics";
import { useMonthlyStatusHandlers } from "../features/monthly/hooks/useMonthlyStatusHandlers";
import { useMonthlyExports } from "../features/monthly/hooks/useMonthlyExports";
import { listImports } from "../services/importService";
import { listMonthlySummaries } from "../services/monthlyService";
import {
  buildDonorMonthKey,
  listDonorMonthReconciliationStatuses,
} from "../services/reconciliation/creditReconciliationService";
import { getDonorInactivityStreakMap } from "../services/monthly/inactivityStreaks";
import { getAppScrollTop, scrollAppTo } from "../utils/appScroll";
import { formatMonthYear } from "../utils/date";
import { formatCpf } from "../utils/cpf";
import { buildSelectOptions } from "../utils/select";
import { usePagination } from "../hooks/usePagination";
import { useDataResource } from "../hooks/useDataResource";
import { useDatabaseChangeEffect } from "../hooks/useDatabaseChangeEffect";
import { useAsync } from "../hooks/useAsync";
import { useDataSyncFeedback } from "../hooks/useDataSyncFeedback";
import { useDelayedLoading } from "../hooks/useDelayedLoading";
import { useProjectPath } from "../hooks/useProjectPath";
import { logError } from "../services/logger";

const EMPTY_INACTIVITY = new Map();

function normalizeMonthlyFilters(filters) {
  return filters.referenceMonth
    ? filters
    : {
        ...filters,
        donationActivity: "all",
        abatementStatus: "all",
      };
}

function loadMonthlySummariesForFilters(filters) {
  return listMonthlySummaries(normalizeMonthlyFilters(filters));
}

function loadMonthlySummariesForOptions(filters) {
  return listMonthlySummaries({
    ...normalizeMonthlyFilters(filters),
    donationActivity: "all",
    abatementStatus: "all",
    abatementSort: "",
  });
}

export default function Monthly() {
  const location = useLocation();
  const [availableImports, setAvailableImports] = useState([]);
  const [filters, setFilters] = useState({
    ...INITIAL_MONTHLY_FILTERS,
    ...(location.state?.monthlyFilters ?? {}),
  });
  const [updatingSummaryId, setUpdatingSummaryId] = useState("");
  const [updatingDonorId, setUpdatingDonorId] = useState("");
  // Bulk selection — Set of summary ids selected via row checkbox. Cleared
  // when filters change or after a successful bulk apply so the operator
  // doesn't accidentally re-act on stale rows.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [showBulkAbatementModal, setShowBulkAbatementModal] = useState(false);
  const [catchUpDonor, setCatchUpDonor] = useState(null);
  const [isBulkAbating, setIsBulkAbating] = useState(false);
  const [isFiltersExpanded, setIsFiltersExpanded] = useState(true);
  const [successMessage, setSuccessMessage] = useState("");
  const [successAction, setSuccessAction] = useState(null);
  const navigate = useNavigate();
  const projectPath = useProjectPath();

  const {
    data: rawSummaries,
    optionSource: summaryOptionSource,
    isLoading,
    error,
    setError,
    reload: reloadSummaries,
  } = useDataResource({
    loader: loadMonthlySummariesForFilters,
    filters,
    errorMessage: "Não foi possível carregar o resumo mensal.",
    scope: "MonthlyPage",
    neutralizedKeys: ["search", "donorId", "cpf", "demand"],
    optionLoader: loadMonthlySummariesForOptions,
  });

  // Optimistic UI for status toggles. The keys are summary ids (the synthetic
  // adjustment-only ids included). Each value is a partial row replacement —
  // status, amount, marker — applied on top of the row from the server. The
  // overlay is cleared whenever the underlying `rawSummaries` reference
  // changes (i.e. after a real reload), so once the server's truth lands the
  // optimistic guess is automatically discarded.
  const [optimisticStatusOverrides, setOptimisticStatusOverrides] = useState({});

  // Ajuste DURANTE o render, e não em efeito: o efeito só roda depois da
  // primeira pintura, então existiria um quadro em que o palpite otimista
  // antigo aparece sobreposto aos dados novos que acabaram de chegar.
  const [overrideSource, setOverrideSource] = useState(rawSummaries);
  if (overrideSource !== rawSummaries) {
    setOverrideSource(rawSummaries);
    setOptimisticStatusOverrides({});
  }

  const summaries = useMemo(() => {
    if (Object.keys(optimisticStatusOverrides).length === 0) {
      return rawSummaries;
    }
    return rawSummaries.map((summary) => {
      const override = optimisticStatusOverrides[summary.id];
      return override ? { ...summary, ...override } : summary;
    });
  }, [rawSummaries, optimisticStatusOverrides]);

  const { handleBulkAbate, handleConsolidatedDonorStatusChange, handleStatusChange } =
    useMonthlyStatusHandlers({
      setError,
      setSuccessMessage,
      setSuccessAction,
      setUpdatingDonorId,
      setUpdatingSummaryId,
      reload: reloadSummaries,
      summaries,
      rawSummaries,
      setOptimisticStatusOverrides,
      setIsBulkAbating,
      onBulkAbateSuccess: () => setShowBulkAbatementModal(false),
    });

  const [reconciliationByDonor, setReconciliationByDonor] = useState(new Map());
  const [inactivityByDonor, setInactivityByDonor] = useState(new Map());

  const loadAvailableImports = useCallback(async () => {
    const rows = await listImports({ status: "processed" });
    setAvailableImports(rows);
  }, []);

  // Mês implícito (Sprint 2 / P2): quando o usuário entra na Gestão
  // Mensal sem `referenceMonth` previamente guardado em location.state e
  // já temos importações processadas, ancoramos no mês mais recente. A
  // ordem de `listImports` já é DESC, então rows[0] é o mais novo.
  //
  // Não chumbamos para sobrescrever uma navegação intencional (back do
  // browser, deep-link com filtros) — só age quando o filtro está
  // vazio. `hasAutoAnchoredRef` garante que isso rode no máximo uma vez
  // por sessão da página: sem ele, limpar o mês manualmente (carrossel,
  // "Meses importados") também deixa `referenceMonth` vazio e o efeito
  // reiria imediatamente, tornando a visão consolidada "Abatimentos por
  // doador" impossível de alcançar depois da primeira importação.
  // A trava virou ESTADO, e o ajuste acontece no render em vez de num efeito.
  // Em efeito, a lista chegaria a ser pintada uma vez sem mês nenhum antes de
  // a âncora entrar — e é justamente esse quadro que a visão consolidada
  // ocupa, fazendo a tela piscar entre as duas visões.
  const [hasAutoAnchored, setHasAutoAnchored] = useState(false);

  if (!hasAutoAnchored) {
    if (filters.referenceMonth) {
      // Já chegou com mês (deep-link via location.state) — o ponto de decisão
      // passou, desarma para sempre.
      setHasAutoAnchored(true);
    } else if (availableImports[0]?.referenceMonth) {
      const mostRecentMonth = availableImports[0].referenceMonth;
      setHasAutoAnchored(true);
      setFilters((current) =>
        current.referenceMonth
          ? current
          : { ...current, referenceMonth: mostRecentMonth },
      );
    }
  }

  // Keyed by (donor, month) so each row's "Crédito real" / "Saldo" describe
  // the month that row is about. The previous all-time rollup repeated the
  // donor's lifetime total on every one of their months.
  //
  // Recortado pelo mês escolhido: sem isso a consulta varria todo o
  // histórico e montava um Map de (doadores × meses) toda vez que a tela
  // abria, mesmo com o usuário olhando um mês só. Sem mês escolhido é a
  // visão consolidada, que precisa mesmo de tudo.
  const selectedMonth = filters.referenceMonth;
  const loadReconciliationStatuses = useCallback(async () => {
    try {
      const map = await listDonorMonthReconciliationStatuses({
        referenceMonth: selectedMonth,
      });
      setReconciliationByDonor(map);
    } catch (err) {
      logError("Monthly.reconciliation", err);
    }
  }, [selectedMonth]);

  // "Há quantos meses seguidos este doador não manda nota?" — rendered as a
  // badge on the row so the user spots a stalled donor while working the
  // month, instead of having to cross-reference months by hand.
  //
  // A métrica é "estado atual", então o emblema só aparece nas linhas do mês
  // mais recente. Num mês anterior o Map seria montado e nunca lido — e ele
  // custa uma varredura de todo o histórico. Por isso a carga só acontece
  // quando a visão pode exibi-lo: no mês mais recente, ou na consolidada
  // (sem mês), que inclui as linhas dele.
  const latestImportedMonth = availableImports[0]?.referenceMonth ?? "";
  const canShowInactivity =
    !selectedMonth ||
    (Boolean(latestImportedMonth) &&
      String(selectedMonth).slice(0, 10) ===
        String(latestImportedMonth).slice(0, 10));

  const loadInactivityStreaks = useCallback(async () => {
    // Sem limpar o mapa aqui: quando a visão não pode exibir o emblema, quem
    // resolve isso é a leitura (`inactivityForDisplay`, abaixo). Zerar o
    // estado neste ponto era uma escrita síncrona dentro do efeito de carga,
    // e ainda faria a consulta ser refeita ao voltar para o mês recente.
    if (!canShowInactivity) {
      return;
    }

    try {
      const map = await getDonorInactivityStreakMap();
      setInactivityByDonor(map);
    } catch (err) {
      logError("Monthly.inactivityStreaks", err);
    }
  }, [canShowInactivity]);

  // O emblema de inatividade descreve o ESTADO ATUAL do doador, então só faz
  // sentido nas linhas do mês mais recente. Num mês anterior a leitura devolve
  // um mapa vazio em vez de zerar o estado — assim voltar ao mês recente não
  // exige refazer a consulta.
  const inactivityForDisplay = canShowInactivity ? inactivityByDonor : EMPTY_INACTIVITY;

  // Carga inicial dos três dados auxiliares.
  //
  // A regra `set-state-in-effect` marca este efeito, mas aqui ela erra: as
  // três funções são `async` e só escrevem estado DEPOIS do `await`, que é
  // exatamente o caso que a própria regra descreve como legítimo ("subscribe
  // for updates from some external system, calling setState in a callback").
  // Verificado uma a uma: nenhuma tem escrita síncrona no corpo.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    loadAvailableImports();
    loadReconciliationStatuses();
    loadInactivityStreaks();
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [loadAvailableImports, loadReconciliationStatuses, loadInactivityStreaks]);

  const refreshAll = useCallback(async () => {
    await Promise.all([
      loadAvailableImports(),
      reloadSummaries(),
      loadReconciliationStatuses(),
      loadInactivityStreaks(),
    ]);
  }, [
    loadAvailableImports,
    reloadSummaries,
    loadReconciliationStatuses,
    loadInactivityStreaks,
  ]);

  // Monthly cares about almost every database mutation (donor/import/abate
  // change can shift summary rows), but ignore notes — saving an annotation
  // doesn't move any number on this page.
  useDatabaseChangeEffect(refreshAll, {
    domains: ["demands", "donors", "imports", "monthly"],
  });

  const restoredScrollTopRef = useRef(location.state?.monthlyScrollTop ?? null);
  const monthlyOperation = useAsync({ reportGlobal: true });
  const dataSyncFeedback = useDataSyncFeedback();
  const hasSelectedReferenceMonth = Boolean(filters.referenceMonth);

  const {
    handleExport,
    handleExportReconciliationCsv,
    handleExportAbatementSheet,
    handleExportPdf,
    handleExportJpeg,
    isExporting,
    isExportingPdf,
    isExportingJpeg,
    isExportingReconciliation,
    isExportingAbatementSheet,
  } = useMonthlyExports({
    filters,
    hasSelectedReferenceMonth,
    monthlyOperation,
    setError,
    setSuccessMessage,
    setSuccessAction,
  });

  // Selection helpers. Clear whenever the underlying month / filters
  // shift so the bar never carries over stale ids the user can't see.
  //
  // Também durante o render: em efeito, a barra de ações em massa apareceria
  // por um quadro dizendo "3 selecionados" sobre uma lista que já é outra.
  const [selectionFilters, setSelectionFilters] = useState(filters);
  if (selectionFilters !== filters) {
    setSelectionFilters(filters);
    setSelectedIds(new Set());
  }

  const handleToggleSelect = useCallback((summaryId, nextSelected) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (nextSelected) {
        next.add(summaryId);
      } else {
        next.delete(summaryId);
      }
      return next;
    });
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // Eligible-for-bulk = selected AND pending AND row can be edited.
  const eligibleBulkSummaries = useMemo(() => {
    if (selectedIds.size === 0 || !summaries) return [];
    return summaries.filter(
      (summary) =>
        selectedIds.has(summary.id) &&
        summary.canUpdateAbatement &&
        summary.abatementStatus === "pending",
    );
  }, [summaries, selectedIds]);

  const handleApplyBulkSelection = useCallback(async () => {
    if (eligibleBulkSummaries.length === 0) return;
    await handleBulkAbate(eligibleBulkSummaries.map((summary) => summary.id));
    setSelectedIds(new Set());
  }, [eligibleBulkSummaries, handleBulkAbate]);
  const isNotDonatedFilterActive =
    hasSelectedReferenceMonth && filters.donationActivity === "not-donated";
  const activeFilterCount = [
    filters.donorId !== "",
    filters.donorType !== "all",
    filters.cpf !== "",
    filters.demand !== "",
    filters.donationActivity !== "all",
    filters.abatementStatus !== "all",
    filters.abatementSort !== "",
    filters.donationStartDate !== "all",
  ].filter(Boolean).length;

  const donorOptions = useMemo(
    () =>
      buildSelectOptions(summaryOptionSource, {
        getValue: (summary) => summary.donorId,
        getLabel: (summary) => summary.donorName,
        emptyLabel: "Todos os doadores",
      }),
    [summaryOptionSource],
  );

  const cpfOptions = useMemo(
    () => {
      const sourceCpfItems = summaryOptionSource.flatMap((summary) =>
        (summary.sourceCpfs?.length ? summary.sourceCpfs : [summary.cpf]).map(
          (cpfValue) => ({ cpf: cpfValue }),
        ),
      );

      return buildSelectOptions(sourceCpfItems, {
        getValue: (item) => item.cpf,
        getLabel: (item) => formatCpf(item.cpf),
        emptyLabel: "Todos os CPFs",
      });
    },
    [summaryOptionSource],
  );

  const demandOptions = useMemo(
    () =>
      buildSelectOptions(summaryOptionSource, {
        getValue: (summary) => summary.demand,
        getLabel: (summary) => summary.demand,
        emptyLabel: "Todas as demandas",
      }),
    [summaryOptionSource],
  );

  useEffect(() => {
    if (isLoading || restoredScrollTopRef.current === null) {
      return;
    }

    const scrollTop = restoredScrollTopRef.current;
    restoredScrollTopRef.current = null;

    window.requestAnimationFrame(() => {
      scrollAppTo(scrollTop);
    });
  }, [isLoading]);

  const getMonthlyNavigationState = useCallback(
    () => ({
      from: {
        label: "Voltar para gestão mensal",
        pathname: projectPath("mensal"),
        state: {
          monthlyFilters: filters,
          monthlyScrollTop: getAppScrollTop(),
        },
      },
    }),
    [filters, projectPath],
  );

  const handleOpenDonorProfile = useCallback(
    (donorId) => {
      navigate(projectPath(`doadores/${encodeURIComponent(donorId)}`), {
        state: getMonthlyNavigationState(),
      });
    },
    [getMonthlyNavigationState, navigate, projectPath],
  );

  const handleOpenCatchUp = useCallback((donor) => {
    setCatchUpDonor({
      id: donor.donorId,
      name: donor.donorName,
      donationStartDateValue: donor.donationStartDate
        ? donor.donationStartDate.slice(0, 7)
        : "",
    });
  }, []);

  const handleFilterChange = (event) => {
    const { name, value } = event.target;
    setFilters((current) => ({
      ...current,
      ...(name === "referenceMonth"
        ? {
            donorId: "",
            cpf: "",
            demand: "",
            ...(!value
              ? {
                  abatementStatus: "all",
                  donationActivity: "all",
                }
              : {}),
          }
        : {}),
      ...(name === "donationActivity" && value === "not-donated"
        ? {
            abatementStatus: "all",
          }
        : {}),
      [name]: value,
    }));
  };

  const handleClearRefinements = () => {
    setFilters((current) => ({
      ...current,
      donorId: "",
      donorType: "all",
      cpf: "",
      demand: "",
      donationActivity: "all",
      abatementStatus: "all",
      abatementSort: "",
      donationStartDate: "all",
    }));
  };

  const handleSelectImportedMonth = (referenceMonth) => {
    if (!referenceMonth) {
      setFilters({ ...INITIAL_MONTHLY_FILTERS });
      return;
    }

    setFilters((current) => ({
      ...current,
      referenceMonth,
      donorId: "",
      cpf: "",
      demand: "",
    }));
  };

  const {
    donatedCount,
    filteredConsolidatedDonors,
    notDonatedCount,
    totalAbatement,
    totalAppliedAbatement,
    totalPendingAbatement,
  } = useConsolidatedMonthlyDonors({
    abatementStatus: filters.abatementStatus,
    summaries,
  });
  const selectedImport = availableImports.find(
    (item) => item.referenceMonth.slice(0, 7) === filters.referenceMonth,
  );
  const isDataSyncRefreshLoading =
    dataSyncFeedback.isActive ||
    dataSyncFeedback.isVisible ||
    (dataSyncFeedback.isSettling && isLoading);
  const isRefreshingMonthlyData =
    isDataSyncRefreshLoading ||
    (isLoading && (availableImports.length > 0 || summaries.length > 0));
  const delayedRefreshingMonthlyData = useDelayedLoading(isRefreshingMonthlyData);
  const showRefreshingMonthlyData =
    isDataSyncRefreshLoading || delayedRefreshingMonthlyData;
  // Client-side filter by reconciliation status. Applied here (before
  // pagination) so page counters and the empty state reflect the user's
  // chosen subset. `reconciliationByDonor` is loaded async; rows whose
  // donor isn't in the map yet get "no-credit" as their effective status.
  const filteredSummaries = useMemo(() => {
    if (
      !filters.reconciliationStatus ||
      filters.reconciliationStatus === "all"
    ) {
      return summaries;
    }
    return summaries.filter((summary) => {
      const status =
        reconciliationByDonor.get(
          buildDonorMonthKey(summary.donorId, summary.referenceMonth),
        )?.status ?? "no-credit";
      return status === filters.reconciliationStatus;
    });
  }, [summaries, reconciliationByDonor, filters.reconciliationStatus]);

  const monthlyPagination = usePagination(filteredSummaries, {
    initialPageSize: 25,
  });
  const visibleDonatedSummaries = useMemo(
    () =>
      monthlyPagination.visibleItems.filter((summary) => summary.hasDonationsInMonth),
    [monthlyPagination.visibleItems],
  );
  const visibleNotDonatedSummaries = useMemo(
    () =>
      monthlyPagination.visibleItems.filter(
        (summary) => !summary.hasDonationsInMonth,
      ),
    [monthlyPagination.visibleItems],
  );
  const overviewMetrics = useMonthlyOverviewMetrics({
    donatedCount,
    hasSelectedReferenceMonth,
    notDonatedCount,
    summariesCount: summaries.length,
    totalAbatement,
    totalAppliedAbatement,
    totalPendingAbatement,
    visibleRange: {
      endItem: monthlyPagination.endItem,
      startItem: monthlyPagination.startItem,
    },
  });

  if (isLoading && !availableImports.length && !error) {
    return (
      <div>
        <PageHeader
          title="Gestão Mensal"
          subtitle="Abatimentos por mês, doador e status."
          className="mb-6"
        />
        <LoadingScreen
          title="Montando o resumo mensal"
          description="Carregando meses e abatimentos."
        />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <PageHeader
          title="Gestão Mensal"
          subtitle="Abatimentos por mês, doador e status."
          className=""
        />
        {/* Mês corrente persistente — sempre visível no topo. Substitui o
            ato de scroll-find-no-carrossel a cada navegação. */}
        <MonthSwitcher
          selectedReferenceMonth={filters.referenceMonth}
          availableImports={availableImports}
          onSelectMonth={handleSelectImportedMonth}
        />
      </div>
      <FirstVisitHint
        storageKey="notar:monthly-hint-v1"
        title="Como usar a Gestão Mensal"
      >
        Selecione um mês importado no carrossel para ver os doadores daquele
        período. Use os filtros para refinar por status ou tipo. Para doadores
        com meses pendentes acumulados, use "Lançar acumulado" para consolidar
        em um único abatimento.
      </FirstVisitHint>
      <FeedbackMessage message={error} tone="error" />
      <FeedbackMessage
        message={
          showRefreshingMonthlyData
            ? isDataSyncRefreshLoading
              ? `${dataSyncFeedback.label}. Atualizando a gestão mensal com os dados mais recentes...`
              : "Atualizando a gestão mensal com os dados mais recentes..."
            : ""
        }
        tone="info"
        persistent
      />
      <FeedbackMessage
        actionLabel={successAction?.label}
        message={successMessage}
        onAction={successAction?.onAction}
        tone="success"
      />

      <SectionCard
        title="Resumo mensal"
        className="mt-6"
      >
        {availableImports.length === 0 ? (
          <div className="mb-5">
            <EmptyState
              title="Nenhuma importação processada ainda"
              description="Depois que você importar uma planilha, os meses disponíveis para consulta aparecerão aqui."
            />
          </div>
        ) : (
          <ImportedMonthsCarousel
            imports={availableImports}
            selectedReferenceMonth={filters.referenceMonth}
            onSelectMonth={handleSelectImportedMonth}
          />
        )}

        <MonthlySummaryToolbar
          metrics={overviewMetrics}
          onBulkAbate={() => setShowBulkAbatementModal(true)}
          onClearRefinements={handleClearRefinements}
          onExportCsv={handleExport}
          onExportPdf={handleExportPdf}
          onExportJpeg={handleExportJpeg}
          onExportReconciliationCsv={handleExportReconciliationCsv}
          onExportAbatementSheet={handleExportAbatementSheet}
          isBulkAbateDisabled={summaries.length === 0}
          isExportingCsv={isExporting}
          isExportingPdf={isExportingPdf}
          isExportingJpeg={isExportingJpeg}
          isExportingReconciliation={isExportingReconciliation}
          isExportingAbatementSheet={isExportingAbatementSheet}
          isPdfDisabled={summaries.length === 0}
          hasSelectedReferenceMonth={hasSelectedReferenceMonth}
        />

        {selectedImport ? (
          <p className="mb-5 text-sm text-[var(--muted)]">
            Visualizando {formatMonthYear(selectedImport.referenceMonth)} a partir
            do arquivo <span className="font-medium">{selectedImport.fileName}</span>.
          </p>
        ) : null}

        <div className="mb-3 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setIsFiltersExpanded((v) => !v)}
            className="flex items-center gap-2 rounded-md border border-transparent px-2 py-1 text-sm font-medium text-[var(--muted-strong)] transition hover:border-[var(--line)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-main)]"
          >
            <ChevronDownIcon
              className={`h-4 w-4 shrink-0 transition-transform duration-200 ${isFiltersExpanded ? "rotate-180" : ""}`}
            />
            Filtros
            {activeFilterCount > 0 ? (
              <span className="rounded-full bg-[var(--accent)] px-1.5 py-0.5 text-xs font-bold text-[var(--on-accent)]">
                {activeFilterCount}
              </span>
            ) : null}
          </button>
        </div>

        {isFiltersExpanded ? (
          <MonthlyFiltersBar
            filters={filters}
            donorOptions={donorOptions}
            cpfOptions={cpfOptions}
            demandOptions={demandOptions}
            hasSelectedReferenceMonth={hasSelectedReferenceMonth}
            isNotDonatedFilterActive={isNotDonatedFilterActive}
            onChange={handleFilterChange}
          />
        ) : null}

        {!hasSelectedReferenceMonth ? (
          isDataSyncRefreshLoading || isLoading ? (
            <DataSyncSectionLoading
              className="mb-5"
              message={isDataSyncRefreshLoading ? dataSyncFeedback.label : "Carregando abatimentos por doador..."}
              rows={4}
            />
          ) : (
            <ConsolidatedPendingDonors
              donors={filteredConsolidatedDonors}
              onCatchUp={handleOpenCatchUp}
              onOpenDonor={handleOpenDonorProfile}
              onStatusChange={handleConsolidatedDonorStatusChange}
              updatingDonorId={updatingDonorId}
            />
          )
        ) : null}

        {!hasSelectedReferenceMonth ? null : isDataSyncRefreshLoading ? (
          <DataSyncSectionLoading
            className="mb-5"
            message={dataSyncFeedback.label}
            rows={4}
          />
        ) : showRefreshingMonthlyData && summaries.length === 0 ? (
          <SkeletonRows rows={4} className="mb-5" />
        ) : summaries.length === 0 ? (
          <EmptyState
            title="Nenhum doador encontrado"
            description={
              hasSelectedReferenceMonth
                ? "Não há doadores para os filtros aplicados neste mês."
                : "Selecione um mês para visualizar a gestão mensal com todos os doadores."
            }
          />
        ) : (
          <>
            <BulkActionBar
              selectedCount={selectedIds.size}
              eligibleCount={eligibleBulkSummaries.length}
              onApplyBulk={handleApplyBulkSelection}
              onClear={handleClearSelection}
              isApplying={isBulkAbating}
            />
            <MonthlySummaryList
              pagination={monthlyPagination}
              donatedSummaries={visibleDonatedSummaries}
              notDonatedSummaries={visibleNotDonatedSummaries}
              updatingSummaryId={updatingSummaryId}
              onNavigate={handleOpenDonorProfile}
              onStatusChange={handleStatusChange}
              reconciliationByDonor={reconciliationByDonor}
              inactivityByDonor={inactivityForDisplay}
              latestImportedMonth={latestImportedMonth}
              showReferenceMonth={!hasSelectedReferenceMonth}
              selectedIds={selectedIds}
              onToggleSelect={handleToggleSelect}
            />
          </>
        )}
      </SectionCard>

      {showBulkAbatementModal ? (
        <BulkAbatementModal
          summaries={summaries}
          onApply={handleBulkAbate}
          onClose={() => setShowBulkAbatementModal(false)}
          isApplying={isBulkAbating}
        />
      ) : null}

      {catchUpDonor ? (
        <CatchUpAdjustmentModal
          donor={catchUpDonor}
          onClose={() => setCatchUpDonor(null)}
          onConfirmed={() => {
            setCatchUpDonor(null);
            setSuccessMessage("Acumulado lançado com sucesso.");
            reloadSummaries();
          }}
        />
      ) : null}
    </div>
  );
}
