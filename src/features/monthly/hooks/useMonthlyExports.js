import { useState } from "react";
import { createActionHistoryEntry } from "../../../services/actionHistoryService";
import {
  exportMonthlySummariesCsv,
  exportAbatementSheetWorkbook,
  exportReconciliationByDonorCsv,
} from "../../../services/exportService";
import { logError } from "../../../services/logger";
import { getErrorMessage } from "../../../utils/error";
import { formatInteger } from "../../../utils/format";

// Os relatorios em PDF e JPEG arrastam uma cadeia grande de dependencias
// (escritor de PDF proprio, compactador zip, pipeline de canvas). Ficam em
// import dinamico para quem nunca exporta relatorio nao pagar esse custo.
const loadPdfReportExporter = () =>
  import("../../reports/services/donationPdfReportService").then(
    (mod) => mod.exportDonationReportPdf,
  );
const loadJpegReportExporter = () =>
  import("../../reports/services/donationJpegReportService").then(
    (mod) => mod.exportDonationReportJpeg,
  );

function describeAbatementSheetExport(result, isPendingSheet) {
  if (result.rowCount === 0) {
    return isPendingSheet
      ? "Nenhum abatimento pendente — nenhuma planilha foi gerada."
      : "Nenhuma doação neste mês — nenhuma planilha foi gerada.";
  }

  if (isPendingSheet) {
    return `${formatInteger(result.rowCount)} CPF(s) com ${formatInteger(result.monthCount)} mês(es) pendente(s) somados, em ${formatInteger(result.demandCount)} planilha(s), uma por demanda.`;
  }

  return `${result.rowCount} CPF(s) em ${result.demandCount} planilha(s), uma por demanda.`;
}

/**
 * Os cinco caminhos de exportacao da Gestao Mensal.
 *
 * Saiu da pagina porque nao compartilha nada com o resto dela: depende so
 * dos filtros vigentes e dos avisos de resultado. As flags de "exportando"
 * passaram a viver aqui, entao a pagina deixou de carregar cinco estados
 * que so estes handlers liam.
 */
export function useMonthlyExports({
  filters,
  hasSelectedReferenceMonth,
  monthlyOperation,
  setError,
  setSuccessMessage,
  setSuccessAction,
}) {
  const [isExporting, setIsExporting] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [isExportingJpeg, setIsExportingJpeg] = useState(false);
  const [isExportingReconciliation, setIsExportingReconciliation] =
    useState(false);
  const [isExportingAbatementSheet, setIsExportingAbatementSheet] =
    useState(false);
  const handleExport = async () => {
    setError("");
    setSuccessAction(null);
    // Show the hint up-front when no month is selected so the user sees it
    // while the CSV builds. After the export resolves we replace it with the
    // result message.
    setSuccessMessage(
      !hasSelectedReferenceMonth
        ? "Exportando a visão geral. Se quiser um mês específico, selecione um mês antes."
        : "",
    );
    setIsExporting(true);

    try {
      const result = await monthlyOperation.run(
        () => exportMonthlySummariesCsv(filters),
        {
          loadingMessage: "Exportando resumo mensal...",
        },
      );
      await createActionHistoryEntry({
        actionType: "export",
        entityType: "export",
        entityId: "monthly-csv",
        label: "Gestão mensal CSV",
        description: `${result.rowCount} linha(s) exportada(s) do resumo mensal em CSV.`,
        payload: {
          filters,
          rowCount: result.rowCount,
        },
      });
      setSuccessMessage(
        `${result.rowCount} linha(s) exportada(s) do resumo mensal em CSV.`,
      );
    } catch (err) {
      logError("MonthlyPage.exportCsv", err);
      setError("Não foi possível exportar o resumo mensal.");
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportReconciliationCsv = async () => {
    if (isExportingReconciliation) return;
    setError("");
    setSuccessMessage("");
    setSuccessAction(null);
    setIsExportingReconciliation(true);
    try {
      // Mirror the current Monthly filters into the export so the user
      // downloads "what they see". Reference month + reconciliation status
      // are the two that actually narrow the donor rollup.
      const result = await monthlyOperation.run(
        () =>
          exportReconciliationByDonorCsv({
            referenceMonth: filters.referenceMonth,
            statusFilter:
              filters.reconciliationStatus &&
              filters.reconciliationStatus !== "all"
                ? filters.reconciliationStatus
                : "",
          }),
        { loadingMessage: "Exportando conciliação..." },
      );
      await createActionHistoryEntry({
        actionType: "export",
        entityType: "export",
        entityId: "reconciliation-by-donor-csv",
        label: "Conciliação por doador CSV",
        description: `${result.rowCount} doador(es) exportado(s) na conciliação.`,
        payload: {
          referenceMonth: filters.referenceMonth,
          statusFilter: filters.reconciliationStatus,
          rowCount: result.rowCount,
        },
      });
      setSuccessMessage(
        `${result.rowCount} doador(es) exportado(s) na conciliação.`,
      );
    } catch (err) {
      logError("MonthlyPage.exportReconciliation", err);
      setError("Não foi possível exportar a conciliação.");
    } finally {
      setIsExportingReconciliation(false);
    }
  };

  // Planilha para o sistema externo dar baixa nas doações. Com um mês
  // selecionado, é a daquele mês. Sem mês, é a de TODOS os meses ainda
  // pendentes somados por CPF — a descrição de cada linha nomeia os meses que
  // ela soma ("Jan/2026 e Fev/2026"), então o destino continua sabendo o que
  // está sendo abatido.
  const handleExportAbatementSheet = async () => {
    if (isExportingAbatementSheet) return;
    setError("");
    setSuccessMessage("");
    setSuccessAction(null);

    const isPendingSheet = !filters.referenceMonth;

    setIsExportingAbatementSheet(true);
    try {
      const result = await monthlyOperation.run(
        () =>
          exportAbatementSheetWorkbook({ referenceMonth: filters.referenceMonth }),
        {
          loadingMessage: isPendingSheet
            ? "Gerando planilha dos meses pendentes..."
            : "Gerando planilha de abatimento...",
        },
      );
      const exportSummary = describeAbatementSheetExport(result, isPendingSheet);
      await createActionHistoryEntry({
        actionType: "export",
        entityType: "export",
        entityId: isPendingSheet ? "abatement-sheet-pending" : "abatement-sheet",
        label: isPendingSheet
          ? "Planilha de abatimento (pendentes)"
          : "Planilha de abatimento",
        description: exportSummary,
        payload: {
          referenceMonth: filters.referenceMonth,
          rowCount: result.rowCount,
          demandCount: result.demandCount,
          monthCount: result.monthCount,
          fileNames: result.fileNames,
        },
      });
      setSuccessMessage(exportSummary);
    } catch (err) {
      logError("MonthlyPage.exportAbatementSheet", err);
      setError("Não foi possível exportar a planilha de abatimento.");
    } finally {
      setIsExportingAbatementSheet(false);
    }
  };

  const handleExportPdf = async () => {
    try {
      setError("");
      setSuccessMessage("");
      setSuccessAction(null);
      setIsExportingPdf(true);
      const exportDonationReportPdf = await loadPdfReportExporter();
      const result = await monthlyOperation.run(
        () => exportDonationReportPdf(filters),
        {
          loadingMessage: "Gerando PDFs por demanda...",
        },
      );
      if (result.archiveName) {
        await createActionHistoryEntry({
          actionType: "export",
          entityType: "export",
          entityId: "donation-report-zip",
          label: result.archiveName,
          description: `ZIP gerado com ${formatInteger(result.demandCount)} PDF(s).`,
          payload: {
            archiveName: result.archiveName,
            demandCount: result.demandCount,
            filters,
            rowCount: result.rowCount,
          },
        });
        setSuccessMessage(
          `ZIP gerado com ${formatInteger(result.demandCount)} PDF(s) e ${formatInteger(result.rowCount)} pessoa(s).`,
        );
      } else {
        await createActionHistoryEntry({
          actionType: "export",
          entityType: "export",
          entityId: "donation-report-pdf",
          label: result.fileName ?? "PDF por demanda",
          description: `PDF gerado com ${formatInteger(result.rowCount)} pessoa(s).`,
          payload: {
            fileName: result.fileName ?? "",
            filters,
            rowCount: result.rowCount,
          },
        });
        setSuccessMessage(
          `PDF gerado com ${formatInteger(result.rowCount)} pessoa(s).`,
        );
      }
    } catch (err) {
      logError("MonthlyPage.exportPdf", err);
      setError(getErrorMessage(err, "Não foi possível gerar os PDFs por demanda."));
    } finally {
      setIsExportingPdf(false);
    }
  };

  const handleExportJpeg = async () => {
    try {
      setError("");
      setSuccessMessage("");
      setSuccessAction(null);
      setIsExportingJpeg(true);
      const exportDonationReportJpeg = await loadJpegReportExporter();
      const result = await monthlyOperation.run(
        () => exportDonationReportJpeg(filters),
        {
          loadingMessage: "Gerando JPEGs por demanda...",
        },
      );
      if (result.archiveName) {
        setSuccessMessage(
          `ZIP gerado com ${formatInteger(result.demandCount)} JPEG(s) e ${formatInteger(result.rowCount)} pessoa(s).`,
        );
      } else {
        setSuccessMessage(
          `JPEG gerado com ${formatInteger(result.rowCount)} pessoa(s).`,
        );
      }
    } catch (err) {
      logError("MonthlyPage.exportJpeg", err);
      setError(
        getErrorMessage(err, "Não foi possível gerar os JPEGs por demanda."),
      );
    } finally {
      setIsExportingJpeg(false);
    }
  };

  return {
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
  };
}
