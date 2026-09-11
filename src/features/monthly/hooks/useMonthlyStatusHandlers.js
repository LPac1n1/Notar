import { useCallback } from "react";
import { buildAbatementHistoryEntry } from "../utils/abatementHistory";
import { groupChangesByStatus } from "../utils/statusChanges";
import { useStatusChangeAction } from "./useStatusChangeAction";
import {
  updateAbatementStatusWithHistory,
  updateAbatementStatuses,
  updateAbatementStatusesWithHistory,
} from "../../../services/monthlyService";
import { formatCurrency, formatInteger } from "../../../utils/format";

export function useMonthlyStatusHandlers({
  setError,
  setSuccessMessage,
  setSuccessAction,
  setUpdatingDonorId,
  setUpdatingSummaryId,
  reload,
  summaries,
  rawSummaries,
  setOptimisticStatusOverrides,
  setBulkStatusInProgress,
  onBulkStatusSuccess,
}) {
  const runStatusChangeAction = useStatusChangeAction({
    setError,
    setSuccessMessage,
    setSuccessAction,
    setUpdatingDonorId,
    setUpdatingSummaryId,
    reload,
  });

  const applyStatusChanges = useCallback(async (changes = [], history = null) => {
    const changesByStatus = groupChangesByStatus(changes);
    let didRecordHistory = false;

    for (const [status, { summaryIds, adjustmentIds }] of changesByStatus.entries()) {
      if (history && !didRecordHistory) {
        await updateAbatementStatusesWithHistory({
          history,
          status,
          summaryIds,
          adjustmentIds,
        });
        didRecordHistory = true;
      } else {
        await updateAbatementStatuses({ summaryIds, adjustmentIds, status });
      }
    }
  }, []);

  const handleUndoStatusChanges = useCallback(
    async ({
      changes = [],
      donorId = "",
      history = null,
      summaryId = "",
      message = "Alteracao desfeita.",
    } = {}) =>
      runStatusChangeAction({
        scope: "MonthlyPage.undoStatus",
        donorId,
        summaryId,
        run: () => applyStatusChanges(changes, history),
        successMessage: message,
        errorMessage: "Não foi possível desfazer a alteração.",
      }),
    [applyStatusChanges, runStatusChangeAction],
  );

  const handleStatusChange = useCallback(
    async (summaryId, status) => {
      const currentSummary = summaries.find((summary) => summary.id === summaryId);

      if (!currentSummary || currentSummary.abatementStatus === status) {
        return;
      }

      const adjustmentId = currentSummary.adjustment?.id ?? "";
      const previousStatus = currentSummary.abatementStatus;
      const history = buildAbatementHistoryEntry({
        donor: currentSummary,
        months: [currentSummary],
        status,
      });

      await runStatusChangeAction({
        scope: "MonthlyPage.updateStatus",
        summaryId,
        onStart: () => {
          setOptimisticStatusOverrides((current) => ({
            ...current,
            [summaryId]: {
              abatementStatus: status,
              abatementMarkedAt:
                status === "applied" ? new Date().toISOString() : "",
            },
          }));
        },
        run: () =>
          updateAbatementStatusWithHistory({
            history,
            summaryId,
            adjustmentId,
            status,
          }),
        successMessage: "Status do abatimento atualizado.",
        errorMessage: "Não foi possível atualizar o status do abatimento.",
        onError: () => {
          setOptimisticStatusOverrides((current) => ({
            ...current,
            [summaryId]: { abatementStatus: previousStatus },
          }));
        },
        undo: () =>
          handleUndoStatusChanges({
            changes: [{ summaryId, adjustmentId, status: currentSummary.abatementStatus }],
            history: buildAbatementHistoryEntry({
              actionType: "monthly_abatement_status_undo",
              donor: currentSummary,
              months: [currentSummary],
              operation: "undo",
              status: currentSummary.abatementStatus,
            }),
            summaryId,
            message: "Status anterior restaurado.",
          }),
      });
    },
    [handleUndoStatusChanges, runStatusChangeAction, setOptimisticStatusOverrides, summaries],
  );

  const handleConsolidatedDonorStatusChange = useCallback(
    async (
      donor,
      status,
      { monthLimit = "", operation = "manual", summaryIds = [] } = {},
    ) => {
      if (!donor || (status !== "applied" && status !== "pending")) {
        return;
      }

      const summaryIdSet = new Set(summaryIds);
      const changedMonths = donor.months.filter((month) => {
        if (month.abatementStatus === status) return false;
        if (summaryIdSet.size === 0) return true;
        const monthIds = month.ids ?? [month.id];
        return monthIds.some((id) => summaryIdSet.has(id));
      });

      if (changedMonths.length === 0) {
        return;
      }

      const statusLabel = status === "applied" ? "realizado" : "pendente";
      const previousStatusLabel =
        status === "applied" ? "pendente(s)" : "realizado(s)";
      const allChangedIds = changedMonths.flatMap(
        (month) => month.ids ?? [month.id],
      );
      const previousStatusByMonthId = new Map(
        changedMonths.flatMap((month) =>
          (month.ids ?? [month.id]).map((id) => [id, month.abatementStatus]),
        ),
      );
      const optimisticMarker = new Date().toISOString();

      await runStatusChangeAction({
        scope: "MonthlyPage.updateDonorAbatement",
        donorId: donor.donorId,
        onStart: () => {
          setOptimisticStatusOverrides((current) => {
            const next = { ...current };
            for (const id of allChangedIds) {
              next[id] = {
                abatementStatus: status,
                abatementMarkedAt: status === "applied" ? optimisticMarker : "",
              };
            }
            return next;
          });
        },
        run: () =>
          updateAbatementStatusesWithHistory({
            history: buildAbatementHistoryEntry({
              donor,
              monthLimit,
              months: changedMonths,
              operation,
              status,
            }),
            summaryIds: changedMonths.flatMap(
              (month) => month.ids ?? [month.id],
            ),
            adjustmentIds: changedMonths.flatMap(
              (month) =>
                month.adjustmentIds ??
                (month.adjustmentId ? [month.adjustmentId] : []),
            ),
            status,
          }),
        successMessage: `${formatInteger(changedMonths.length)} mês(es) de ${donor.donorName} marcado(s) como ${statusLabel}.`,
        errorMessage: "Não foi possível atualizar os abatimentos do doador.",
        onError: () => {
          setOptimisticStatusOverrides((current) => {
            const next = { ...current };
            for (const id of allChangedIds) {
              next[id] = {
                abatementStatus: previousStatusByMonthId.get(id) ?? "pending",
              };
            }
            return next;
          });
        },
        undo: () =>
          handleUndoStatusChanges({
            changes: changedMonths.flatMap((month) => {
              const ids = month.ids ?? [month.id];
              const adjIds =
                month.adjustmentIds ??
                (month.adjustmentId ? [month.adjustmentId] : []);
              return ids.map((id, index) => ({
                summaryId: id,
                adjustmentId: adjIds[index] ?? adjIds[0] ?? "",
                status: month.abatementStatus,
              }));
            }),
            donorId: donor.donorId,
            history: buildAbatementHistoryEntry({
              actionType: "monthly_abatement_status_undo",
              donor,
              months: changedMonths,
              operation: "undo",
              status: status === "applied" ? "pending" : "applied",
            }),
            message: `Abatimentos do doador restaurados como ${previousStatusLabel}.`,
          }),
      });
    },
    [handleUndoStatusChanges, runStatusChangeAction, setOptimisticStatusOverrides],
  );

  /**
   * Abater ou desabater várias linhas de uma vez.
   *
   * As duas direções são a mesma operação com o status invertido. A cascata
   * para o acumulado do mês e a proteção das linhas "Via acumulado" moram no
   * serviço e valem igual para as duas; o que muda aqui é o texto e o status
   * que o "Desfazer" restaura.
   *
   * `setBulkStatusInProgress` recebe o status em andamento (e "" ao terminar)
   * para a página saber QUAL botão mostra "carregando" — com um booleano só,
   * "Abatendo..." apareceria também no botão de desabater.
   *
   * O "Desfazer" devolve cada linha ao status anterior, mas não a data em que
   * o abatimento tinha sido marcado: desabater apaga essa data, e marcar de
   * novo grava a de agora. É o mesmo comportamento do desfazer de uma linha.
   */
  const handleBulkStatusChange = useCallback(
    async (summaryIds, status) => {
      if (
        summaryIds.length === 0 ||
        (status !== "applied" && status !== "pending")
      ) {
        return;
      }

      const isRevert = status === "pending";
      const affectedSummaries = rawSummaries.filter((s) =>
        summaryIds.includes(s.id),
      );
      const totalAmount = affectedSummaries.reduce(
        (sum, s) => sum + Number(s.abatementAmount ?? 0),
        0,
      );
      const adjustmentIdBySummaryId = new Map(
        affectedSummaries.map((s) => [s.id, s.adjustment?.id ?? ""]),
      );
      const affectedAdjustmentIds = Array.from(
        adjustmentIdBySummaryId.values(),
      ).filter(Boolean);
      const previousStatusBySummaryId = new Map(
        affectedSummaries.map((s) => [s.id, s.abatementStatus]),
      );
      const donorCount = new Set(affectedSummaries.map((s) => s.donorId)).size;
      const countLabel = formatInteger(summaryIds.length);
      const restoredStatus = isRevert ? "applied" : "pending";
      const optimisticMarker = new Date().toISOString();

      const success = await runStatusChangeAction({
        scope: isRevert ? "MonthlyPage.bulkUnabate" : "MonthlyPage.bulkAbate",
        setBusy: (busy) => setBulkStatusInProgress?.(busy ? status : ""),
        onStart: () => {
          setOptimisticStatusOverrides((current) => {
            const next = { ...current };
            for (const id of summaryIds) {
              next[id] = {
                abatementStatus: status,
                abatementMarkedAt: isRevert ? "" : optimisticMarker,
              };
            }
            return next;
          });
        },
        run: () =>
          updateAbatementStatusesWithHistory({
            history: {
              actionType: "monthly_abatement_status_update",
              entityType: "monthly_abatement",
              entityId: "bulk",
              label: isRevert ? "Desabatimento em massa" : "Abatimento em massa",
              description: `${countLabel} abatimento(s) marcado(s) como ${isRevert ? "pendente" : "realizado"}.`,
              payload: {
                summaryIds,
                adjustmentIds: affectedAdjustmentIds,
                donorCount,
                totalAmount,
                operation: isRevert ? "bulk-revert" : "bulk",
              },
            },
            status,
            summaryIds,
            adjustmentIds: affectedAdjustmentIds,
          }),
        successMessage: isRevert
          ? `${countLabel} abatimento(s) voltaram a pendente — ${formatCurrency(totalAmount)} total.`
          : `${countLabel} abatimento(s) realizado(s) — ${formatCurrency(totalAmount)} total.`,
        errorMessage: isRevert
          ? "Não foi possível desabater em massa."
          : "Não foi possível realizar o abatimento em massa.",
        onError: () => {
          setOptimisticStatusOverrides((current) => {
            const next = { ...current };
            for (const id of summaryIds) {
              next[id] = {
                abatementStatus:
                  previousStatusBySummaryId.get(id) ?? restoredStatus,
              };
            }
            return next;
          });
        },
        undo: () =>
          handleUndoStatusChanges({
            changes: summaryIds.map((summaryId) => ({
              summaryId,
              adjustmentId: adjustmentIdBySummaryId.get(summaryId) ?? "",
              status: previousStatusBySummaryId.get(summaryId) ?? restoredStatus,
            })),
            history: {
              actionType: "monthly_abatement_status_undo",
              entityType: "monthly_abatement",
              entityId: "bulk",
              label: isRevert
                ? "Desabatimento em massa desfeito"
                : "Abatimento em massa desfeito",
              description: `${countLabel} abatimento(s) restaurado(s) como ${isRevert ? "realizado" : "pendente"}.`,
              payload: {
                summaryIds,
                adjustmentIds: affectedAdjustmentIds,
                operation: "undo",
              },
            },
            message: `${countLabel} abatimento(s) restaurado(s) como ${isRevert ? "realizado(s)" : "pendente(s)"}.`,
          }),
      });

      if (success) {
        onBulkStatusSuccess?.();
      }
    },
    [
      handleUndoStatusChanges,
      onBulkStatusSuccess,
      rawSummaries,
      runStatusChangeAction,
      setBulkStatusInProgress,
      setOptimisticStatusOverrides,
    ],
  );

  const handleBulkAbate = useCallback(
    (summaryIds) => handleBulkStatusChange(summaryIds, "applied"),
    [handleBulkStatusChange],
  );

  const handleBulkUnabate = useCallback(
    (summaryIds) => handleBulkStatusChange(summaryIds, "pending"),
    [handleBulkStatusChange],
  );

  return {
    handleBulkAbate,
    handleBulkUnabate,
    handleConsolidatedDonorStatusChange,
    handleStatusChange,
  };
}
