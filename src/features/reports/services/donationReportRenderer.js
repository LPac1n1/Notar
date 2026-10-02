import { listDemands } from "../../../services/demandService";
import { listMonthlySummaries } from "../../../services/monthlyService";
import {
  formatMonthAbbrev,
  formatMonthYear,
  formatMonthsSpan,
  hasDonationStartConflict,
} from "../../../utils/date";
import { getContrastTextColor } from "../../../utils/demandColor";
import { formatCurrency, formatInteger } from "../../../utils/format";
import { buildSlug } from "../../../utils/slug";
import { estimateTextWidth, wrapText } from "../pdf/simplePdf";
import { mapDemandGroups } from "../utils/donationReportGroups";

const PAGE_MARGIN = 42;
const PAGE_BOTTOM = 800;
const TEXT = "#1F2937";
const MUTED = "#6B7280";
const LINE = "#D8DEE8";
const SOFT_LINE = "#E8ECF2";
const SURFACE = "#F7F8FA";
const FOOTER_Y = 820;


function formatGeneratedAt(date = new Date()) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function getPeriodLabel(referenceMonth, referenceMonths = []) {
  // Vários meses escolhidos: o cabeçalho nomeia o conjunto com a mesma regra
  // da planilha ("Mai/2026 e Jun/2026", "Mai/2026 até Jul/2026").
  if (referenceMonths.length > 1) {
    return formatMonthsSpan(referenceMonths);
  }

  return referenceMonth
    ? formatMonthYear(referenceMonth)
    : "Histórico completo";
}

function getPeriodSlugPart(reportData) {
  const months = reportData.referenceMonths ?? [];

  if (months.length > 1) {
    return buildSlug(months[0] + "-a-" + months[months.length - 1]);
  }

  return reportData.referenceMonth
    ? buildSlug(formatMonthYear(reportData.referenceMonth))
    : "historico";
}

/**
 * Linha fina sob o nome, com o que veio de cada mês.
 *
 * Só aparece quando o relatório soma mais de um mês: com um mês só as colunas
 * já dizem tudo, e a linha seria repetição.
 */
function getMonthBreakdownText(row, reportData) {
  if ((reportData.referenceMonths?.length ?? 0) < 2) {
    return "";
  }

  const months = row.months ?? [];

  if (months.length === 0) {
    return "";
  }

  return months
    .map(
      (month) =>
        formatMonthAbbrev(month.referenceMonth) +
        ": " +
        formatInteger(month.notesCount) +
        " nota(s) " +
        formatCurrency(month.abatementAmount),
    )
    .join("  |  ");
}

export async function buildDonationReportData(filters = {}) {
  const referenceMonths = Array.from(
    new Set(
      (filters.referenceMonths ?? [])
        .filter(Boolean)
        .map((month) => String(month).slice(0, 7)),
    ),
  ).sort();
  const [summaries, demands] = await Promise.all([
    listMonthlySummaries(filters),
    listDemands(),
  ]);

  const groups = mapDemandGroups({ demands, summaries });

  if (groups.length === 0) {
    throw new Error(
      "Não há dados para gerar o relatório com os filtros atuais.",
    );
  }

  return {
    generatedAt: formatGeneratedAt(),
    periodLabel: getPeriodLabel(filters.referenceMonth, referenceMonths),
    referenceMonth: filters.referenceMonth,
    referenceMonths,
    groups,
  };
}

export function getDemandReportFileName(reportData, group, extension = "pdf") {
  const demandPart = buildSlug(group.name);

  return `relatorio-doacoes-${demandPart || "demanda"}-${getPeriodSlugPart(reportData)}.${extension}`;
}

export function getZipReportFileName(reportData) {
  return `relatorios-doacoes-por-demanda-${getPeriodSlugPart(reportData)}.zip`;
}

export function getDemandRowCount(group) {
  return group.holders.length + group.auxiliaries.length;
}

function getAdjustmentNoteText(row, reportData) {
  if (!row) {
    return "";
  }

  if ((row.adjustmentNotesCount ?? 0) <= 0) {
    // Sem acumulado próprio, mas com as doações do período abatidas junto de
    // um acumulado lançado em outro mês: a linha sai zerada, e sem esta nota
    // pareceria que a pessoa não doou.
    return row.coveredByAccumulatedMonth
      ? "Doações incluídas no acumulado de " +
          formatMonthAbbrev(row.coveredByAccumulatedMonth)
      : "";
  }

  const isMultiMonthReport = (reportData?.referenceMonths?.length ?? 0) > 1;

  const start = row.adjustmentRangeStartMonth;
  const end = row.adjustmentRangeEndMonth;

  // Prefer an explicit period label so the recipient understands which months
  // are being charged together. Fall back to the user-typed description, then
  // to a generic label if neither is available.
  if (start && end) {
    const startLabel = formatMonthYear(start);
    const endLabel = formatMonthYear(end);
    const period =
      startLabel === endLabel
        ? `Acumulado de ${startLabel}`
        : `Acumulado de ${startLabel} a ${endLabel}`;

    if (!row.adjustmentSubsumesMonth) {
      return `${period} somado a este mês`;
    }

    // Num relatório de vários meses "neste mês" não diz qual.
    return isMultiMonthReport && row.adjustmentReferenceMonth
      ? `${period} (consolidado em ${formatMonthAbbrev(row.adjustmentReferenceMonth)})`
      : `${period} (consolidado neste mês)`;
  }

  return row.adjustmentDescription || "Inclui acumulado de meses anteriores";
}

function getDonationCountLabel(row, reportData) {
  if (
    reportData.referenceMonth &&
    Number(row.notesCount ?? 0) === 0 &&
    hasDonationStartConflict(row.donationStartDate, reportData.referenceMonth)
  ) {
    return formatMonthYear(row.donationStartDate);
  }

  // When a catch-up adjustment was applied to this month, expose the
  // breakdown ("28 (12 + 16)") so the recipient can see why the number is
  // higher than usual. We skip the breakdown when the adjustment subsumes the
  // reference month — there is no separate "month" portion to show.
  if (
    (row.adjustmentNotesCount ?? 0) > 0 &&
    !row.adjustmentSubsumesMonth
  ) {
    const monthly = formatInteger(row.monthNotesCount ?? 0);
    const adjustment = formatInteger(row.adjustmentNotesCount);
    return `${formatInteger(row.notesCount)} (${monthly} + ${adjustment})`;
  }

  return formatInteger(row.notesCount);
}

function drawDocumentHeader(doc, reportData, pageState) {
  const headerColor = reportData.groups[0]?.color ?? "#181C23";
  const textColor = getContrastTextColor(headerColor);

  doc.drawRect({
    x: 0,
    y: 0,
    width: doc.width,
    height: 72,
    fillColor: headerColor,
  });
  doc.drawText({
    text: "Notar",
    x: PAGE_MARGIN,
    y: 30,
    font: "bold",
    size: 18,
    color: textColor,
  });
  doc.drawText({
    text: "Relatório de doações por demanda",
    x: PAGE_MARGIN,
    y: 52,
    size: 11,
    color: textColor,
  });
  doc.drawText({
    text: `Período: ${reportData.periodLabel}`,
    x: 360,
    y: 31,
    size: 9,
    color: textColor,
  });
  doc.drawText({
    text: `Gerado em: ${reportData.generatedAt}`,
    x: 360,
    y: 50,
    size: 9,
    color: textColor,
  });

  pageState.y = 104;
}

function ensureSpace(doc, reportData, pageState, height, onNewPage) {
  if (pageState.y + height <= PAGE_BOTTOM) {
    return;
  }

  doc.addPage();
  drawDocumentHeader(doc, reportData, pageState);
  onNewPage?.();
}

function drawDemandHeader(doc, reportData, pageState, group) {
  ensureSpace(doc, reportData, pageState, 66);
  const textColor = getContrastTextColor(group.color);

  doc.drawRect({
    x: PAGE_MARGIN,
    y: pageState.y,
    width: doc.width - PAGE_MARGIN * 2,
    height: 48,
    fillColor: group.color,
  });
  doc.drawText({
    text: group.name,
    x: PAGE_MARGIN + 14,
    y: pageState.y + 20,
    font: "bold",
    size: 14,
    color: textColor,
  });
  doc.drawText({
    text: `Titulares: ${formatInteger(group.holders.length)} | Auxiliares: ${formatInteger(group.auxiliaries.length)}`,
    x: PAGE_MARGIN + 14,
    y: pageState.y + 38,
    size: 9,
    color: textColor,
  });
  pageState.y += 66;
}

function drawPageFooters(doc) {
  const totalPages = doc.getPageCount();

  for (let index = 0; index < totalPages; index += 1) {
    doc.withPage(index, () => {
      const text = `Página ${formatInteger(index + 1)} de ${formatInteger(totalPages)}`;
      const textWidth = estimateTextWidth(text, 10);

      doc.drawLine({
        x1: PAGE_MARGIN,
        y1: FOOTER_Y - 14,
        x2: doc.width - PAGE_MARGIN,
        y2: FOOTER_Y - 14,
        color: LINE,
        lineWidth: 1,
      });
      doc.drawText({
        text,
        x: doc.width - PAGE_MARGIN - textWidth,
        y: FOOTER_Y,
        font: "bold",
        size: 10,
        color: MUTED,
      });
    });
  }
}

function drawTableHeader(doc, pageState, columns) {
  const tableWidth = doc.width - PAGE_MARGIN * 2;
  let x = PAGE_MARGIN;

  doc.drawRect({
    x,
    y: pageState.y,
    width: tableWidth,
    height: 24,
    fillColor: SURFACE,
    strokeColor: LINE,
  });

  for (const column of columns) {
    doc.drawText({
      text: column.label,
      x: x + 8,
      y: pageState.y + 16,
      font: "bold",
      size: 8.5,
      color: TEXT,
    });
    x += column.width;
  }

  pageState.y += 24;
}

function drawTableTitle(doc, reportData, pageState, group, title) {
  ensureSpace(doc, reportData, pageState, 34, () => {
    drawDemandHeader(doc, reportData, pageState, group);
  });
  doc.drawLine({
    x1: PAGE_MARGIN,
    y1: pageState.y - 2,
    x2: doc.width - PAGE_MARGIN,
    y2: pageState.y - 2,
    color: group.color,
    lineWidth: 1.4,
  });
  doc.drawText({
    text: title,
    x: PAGE_MARGIN,
    y: pageState.y + 17,
    font: "bold",
    size: 11,
    color: group.color,
  });
  pageState.y += 26;
}

function getColumnLineCount(column, row) {
  const mainLines = wrapText(column.getValue(row), column.width - 16, 9).length;
  const subText = column.getSubValue ? column.getSubValue(row) : "";
  const subLines = subText
    ? wrapText(subText, column.width - 16, 8).length
    : 0;
  return mainLines + subLines;
}

function getRowHeight(columns, row) {
  const lineCount = Math.max(
    1,
    ...columns.map((column) => getColumnLineCount(column, row)),
  );

  return Math.max(28, lineCount * 12 + 14);
}

function drawTableRow(doc, pageState, columns, row, rowIndex) {
  const rowHeight = getRowHeight(columns, row);
  const tableWidth = doc.width - PAGE_MARGIN * 2;
  let x = PAGE_MARGIN;

  doc.drawRect({
    x,
    y: pageState.y,
    width: tableWidth,
    height: rowHeight,
    fillColor: rowIndex % 2 === 0 ? "#FFFFFF" : "#FBFCFE",
    strokeColor: SOFT_LINE,
  });

  for (const column of columns) {
    const mainLines = wrapText(column.getValue(row), column.width - 16, 9);

    mainLines.forEach((line, lineIndex) => {
      doc.drawText({
        text: line,
        x: x + 8,
        y: pageState.y + 17 + lineIndex * 12,
        font: column.bold ? "bold" : "regular",
        size: 9,
        color: column.color ?? TEXT,
      });
    });

    const subText = column.getSubValue ? column.getSubValue(row) : "";
    if (subText) {
      const subLines = wrapText(subText, column.width - 16, 8);
      subLines.forEach((line, lineIndex) => {
        doc.drawText({
          text: line,
          x: x + 8,
          y: pageState.y + 17 + (mainLines.length + lineIndex) * 12,
          font: "regular",
          size: 8,
          color: MUTED,
        });
      });
    }

    x += column.width;
  }

  pageState.y += rowHeight;
}

function drawEmptyTableRow(doc, pageState, message) {
  const tableWidth = doc.width - PAGE_MARGIN * 2;

  doc.drawRect({
    x: PAGE_MARGIN,
    y: pageState.y,
    width: tableWidth,
    height: 32,
    fillColor: "#FFFFFF",
    strokeColor: SOFT_LINE,
  });
  doc.drawText({
    text: message,
    x: PAGE_MARGIN + 8,
    y: pageState.y + 20,
    size: 9,
    color: MUTED,
  });
  pageState.y += 32;
}

function drawPeopleTable({
  doc,
  reportData,
  pageState,
  group,
  title,
  columns,
  rows,
  emptyMessage,
}) {
  drawTableTitle(doc, reportData, pageState, group, title);
  drawTableHeader(doc, pageState, columns);

  if (rows.length === 0) {
    ensureSpace(doc, reportData, pageState, 32, () => {
      drawDemandHeader(doc, reportData, pageState, group);
      drawTableTitle(doc, reportData, pageState, group, title);
      drawTableHeader(doc, pageState, columns);
    });
    drawEmptyTableRow(doc, pageState, emptyMessage);
    pageState.y += 18;
    return;
  }

  rows.forEach((row, rowIndex) => {
    const rowHeight = getRowHeight(columns, row);

    ensureSpace(doc, reportData, pageState, rowHeight, () => {
      drawDemandHeader(doc, reportData, pageState, group);
      drawTableTitle(doc, reportData, pageState, group, title);
      drawTableHeader(doc, pageState, columns);
    });
    drawTableRow(doc, pageState, columns, row, rowIndex);
  });

  pageState.y += 18;
}

export function drawDonationReport(doc, reportData) {
  const pageState = { y: 0 };
  const tableWidth = doc.width - PAGE_MARGIN * 2;
  // A coluna de valor abatido fica ao lado da de doações de propósito: as duas
  // descrevem a mesma linha em unidades diferentes (quantidade e dinheiro), e
  // lê-las juntas é o que deixa o valor por nota evidente sem precisar dizê-lo.
  const abatementColumn = (width) => ({
    label: "Valor abatido",
    width,
    getValue: (row) => formatCurrency(row.abatementAmount ?? 0),
    bold: true,
  });

  const holdersColumns = [
    {
      label: "Doador titular",
      width: tableWidth * 0.52,
      getValue: (row) => row.name,
      getSubValue: (row) =>
        [getAdjustmentNoteText(row, reportData), getMonthBreakdownText(row, reportData)]
          .filter(Boolean)
          .join("  |  "),
      bold: true,
    },
    {
      label: "Doações",
      width: tableWidth * 0.22,
      getValue: (row) => getDonationCountLabel(row, reportData),
      bold: true,
    },
    abatementColumn(tableWidth * 0.26),
  ];
  const auxiliariesColumns = [
    {
      label: "Doador auxiliar",
      width: tableWidth * 0.34,
      getValue: (row) => row.name,
      getSubValue: (row) =>
        [getAdjustmentNoteText(row, reportData), getMonthBreakdownText(row, reportData)]
          .filter(Boolean)
          .join("  |  "),
      bold: true,
    },
    {
      label: "Auxilia",
      width: tableWidth * 0.22,
      getValue: (row) => row.holderName || "Pessoa de referência",
    },
    {
      label: "Doações",
      width: tableWidth * 0.18,
      getValue: (row) => getDonationCountLabel(row, reportData),
      bold: true,
    },
    abatementColumn(tableWidth * 0.26),
  ];

  drawDocumentHeader(doc, reportData, pageState);

  reportData.groups.forEach((group, groupIndex) => {
    if (groupIndex > 0) {
      ensureSpace(doc, reportData, pageState, 86);
    }

    drawDemandHeader(doc, reportData, pageState, group);
    drawPeopleTable({
      doc,
      reportData,
      pageState,
      group,
      title: "Doadores titulares",
      columns: holdersColumns,
      rows: group.holders,
      emptyMessage:
        "Nenhum doador titular encontrado para os filtros atuais.",
    });
    drawPeopleTable({
      doc,
      reportData,
      pageState,
      group,
      title: "Doadores auxiliares",
      columns: auxiliariesColumns,
      rows: group.auxiliaries,
      emptyMessage:
        "Nenhum doador auxiliar encontrado para os filtros atuais.",
    });
  });

  drawPageFooters(doc);
}
