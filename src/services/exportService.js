import { listDonors } from "./donorService.js";
import {
  listAbatementSheetRows,
  listPendingAbatementSheetRows,
} from "./monthly/abatementSheet.js";
import { buildAbatementWorkbookBytes } from "./monthly/abatementSheetWorkbook.js";
import { listMonthlySummaries } from "./monthlyService.js";
import {
  listReconciliationByDonor,
  listReconciliationPairs,
} from "./reconciliation/creditReconciliationService.js";
import { createZipArchive } from "../features/reports/utils/simpleZip.js";
import { buildCsvContent } from "../utils/csv.js";
import { formatDatePtBR } from "../utils/date.js";
import { listRaffleNumbers } from "./raffle/raffleNumbersService.js";
import { downloadFile } from "../utils/download.js";
import { buildSlug } from "../utils/slug.js";

// `incomplete` was retired — surplus credit folds into `ok` because the
// user established that credit > abated is normal NFP behaviour. Kept
// the key here for back-compat with any persisted CSV export referencing
// the old wording, but it should never come back from the service.
const RECONCILIATION_STATUS_LABEL = {
  ok: "Com crédito conciliado",
  "no-credit": "Sem crédito conciliado",
};

const MATCH_STATUS_LABEL = {
  matched: "Casado",
  divergent: "Valor divergente",
};

// Tipo MIME do .xlsx. Sem ele o navegador entrega o arquivo como binário
// genérico e o Excel não se oferece para abri-lo.
const XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// UTF-8 BOM. Sem ele o Excel abre o CSV em ANSI e quebra os acentos.
const CSV_BOM = "\uFEFF";

function downloadCsv(fileName, csvContent) {
  downloadFile({
    fileName,
    content: `${CSV_BOM}${csvContent}`,
    mimeType: "text/csv;charset=utf-8",
  });
}

/**
 * `includeDemand` acompanha o módulo Demandas do projeto ativo — sem ele a
 * coluna sairia presente e vazia em todas as linhas, sugerindo dado faltando
 * em vez de dimensão que não se aplica.
 *
 * `includeDonorType` acompanha a Gestão Mensal: sem apuração todo doador é
 * titular, e uma coluna com o mesmo valor em toda linha não informa nada.
 */
export async function exportDonorsCsv(
  filters = {},
  { includeDemand = true, includeDonorType = true } = {},
) {
  const donors = await listDonors(filters);
  const csvContent = buildCsvContent(
    [
      { key: "name", label: "Nome" },
      ...(includeDonorType ? [{ key: "donorTypeLabel", label: "Tipo" }] : []),
      { key: "cpf", label: "CPF" },
      ...(includeDemand ? [{ key: "demand", label: "Demanda" }] : []),
      ...(includeDonorType
        ? [{ key: "holderName", label: "Pessoa vinculada" }]
        : []),
      { key: "donationStartDate", label: "Início das doações" },
      { key: "isActive", label: "Ativo" },
    ],
    donors.map((donor) => ({
      ...donor,
      isActive: donor.isActive ? "Sim" : "Não",
    })),
  );

  downloadCsv("notar-doadores.csv", csvContent);

  return { rowCount: donors.length };
}

export async function exportMonthlySummariesCsv(filters = {}) {
  const summaries = await listMonthlySummaries(filters);
  const csvContent = buildCsvContent(
    [
      { key: "referenceMonth", label: "Mês de referência" },
      { key: "donorName", label: "Doador" },
      { key: "donationActivity", label: "Situação no mês" },
      { key: "cpf", label: "CPF" },
      { key: "demand", label: "Demanda" },
      { key: "notesCount", label: "Quantidade de notas" },
      { key: "valuePerNote", label: "Valor por nota" },
      { key: "abatementAmount", label: "Valor de abatimento" },
      { key: "abatementStatus", label: "Status do abatimento" },
      { key: "abatementMarkedAt", label: "Marcado em" },
    ],
    summaries.map((summary) => ({
      ...summary,
      donationActivity: summary.hasDonationsInMonth
        ? "Doou no mês"
        : "Não doou no mês",
      abatementStatus:
        !summary.hasDonationsInMonth
          ? "Sem doações no mês"
          : summary.abatementStatus === "applied"
            ? "Realizado"
            : "Pendente",
    })),
  );

  const referenceMonthSuffix = filters.referenceMonth
    ? `-${filters.referenceMonth}`
    : "";

  downloadCsv(
    `notar-resumo-mensal${referenceMonthSuffix}.csv`,
    csvContent,
  );

  return { rowCount: summaries.length };
}

/**
 * Per-donor reconciliation rollup CSV (Fase 5). One row per active donor —
 * the "executive summary" view: how much real credit each donor generated
 * vs. how much the system has marked as abated, with the comparison status
 * spelled out in Portuguese for the spreadsheet reader.
 *
 * Accepts the same `{ referenceMonth, statusFilter }` options as
 * `listReconciliationByDonor` so the export mirrors whatever the user is
 * looking at on screen.
 */
export async function exportReconciliationByDonorCsv(filters = {}) {
  const rows = await listReconciliationByDonor(filters);
  const csvContent = buildCsvContent(
    [
      { key: "donorName", label: "Doador" },
      { key: "cpf", label: "CPF" },
      { key: "demand", label: "Demanda" },
      { key: "statusLabel", label: "Status" },
      { key: "totalCredit", label: "Crédito real (R$)" },
      { key: "totalAbated", label: "Total abatido (R$)" },
      { key: "difference", label: "Diferença (R$)" },
      { key: "matchedNoteCount", label: "Notas casadas" },
      { key: "divergentNoteCount", label: "Notas divergentes" },
      { key: "divergentCreditValue", label: "Crédito em divergência (R$)" },
      { key: "orphanDonationNoteCount", label: "Notas sem crédito" },
    ],
    rows.map((row) => ({
      ...row,
      statusLabel: RECONCILIATION_STATUS_LABEL[row.status] ?? row.status,
    })),
  );

  const monthSuffix = filters.referenceMonth
    ? `-${filters.referenceMonth}`
    : "";
  const statusSuffix =
    filters.statusFilter && filters.statusFilter !== "all"
      ? `-${filters.statusFilter}`
      : "";
  downloadCsv(
    `notar-conciliacao-doadores${monthSuffix}${statusSuffix}.csv`,
    csvContent,
  );

  return { rowCount: rows.length };
}

/**
 * Pair-level audit CSV (Fase 5). One row per (credit ↔ donation) pairing,
 * matched and divergent only. Lets the user trace the exact nota fiscal
 * behind every line in the rollup CSV.
 */
export async function exportReconciliationPairsCsv(filters = {}) {
  const rows = await listReconciliationPairs(filters);
  const csvContent = buildCsvContent(
    [
      { key: "statusLabel", label: "Pareamento" },
      { key: "donorName", label: "Doador" },
      { key: "donorCpf", label: "CPF" },
      { key: "donorDemand", label: "Demanda" },
      { key: "cnpjEstabelecimento", label: "CNPJ estabelecimento" },
      { key: "numeroNota", label: "Número da nota" },
      { key: "dataNota", label: "Data da nota (doações)" },
      { key: "dataEmissao", label: "Data de emissão (créditos)" },
      { key: "donationReferenceMonth", label: "Mês de referência" },
      { key: "valorDonation", label: "Valor doação (R$)" },
      { key: "valorCredit", label: "Valor crédito (R$)" },
      { key: "valorDifference", label: "Diferença de valor (R$)" },
      { key: "creditoReal", label: "Crédito real gerado (R$)" },
    ],
    rows.map((row) => ({
      ...row,
      statusLabel: MATCH_STATUS_LABEL[row.matchStatus] ?? row.matchStatus,
    })),
  );

  const pairsMonthSuffix = filters.referenceMonth
    ? `-${filters.referenceMonth}`
    : "";
  const pairsStatusSuffix =
    filters.statusFilter && filters.statusFilter !== "all"
      ? `-${filters.statusFilter}`
      : "";
  downloadCsv(
    `notar-conciliacao-pareamentos${pairsMonthSuffix}${pairsStatusSuffix}.csv`,
    csvContent,
  );

  return { rowCount: rows.length };
}

/**
 * Planilha de abatimento para importar no sistema externo que dá baixa nas
 * doações. Uma linha por CPF de doador com notas no mês — inclusive
 * auxiliares, que no resumo mensal aparecem somados ao titular mas aqui
 * precisam de linha própria porque o abatimento lá é por CPF.
 *
 * Sai no formato .xlsx do modelo do sistema de destino (`base_extrato.xlsx`),
 * e não em CSV: o modelo tem um bloco de parâmetros no topo, uma nota
 * mesclada e duas linhas em branco antes do cabeçalho das colunas. Nada disso
 * sobrevive a um CSV.
 *
 * A demanda não é coluna no modelo de destino — ela vive no NOME DO ARQUIVO,
 * porque a importação lá é feita demanda a demanda. Demandas sem doação no
 * mês não geram arquivo: a consulta já só devolve CPF com nota, então o
 * agrupamento nunca produz grupo vazio.
 *
 * Com mais de uma demanda os arquivos vão num .zip (mesmo padrão dos
 * relatórios PDF/JPEG por demanda); com uma só, baixa a planilha direto.
 *
 * Sem mês, sai a planilha de TODOS os meses pendentes, somados por CPF. Não
 * fica ambígua no destino: a descrição de cada linha nomeia os meses que ela
 * soma, e a data sai do mês mais recente daquela linha.
 */
export async function exportAbatementSheetWorkbook({ referenceMonth } = {}) {
  const isPendingSheet = !referenceMonth;
  const rows = isPendingSheet
    ? await listPendingAbatementSheetRows()
    : await listAbatementSheetRows({ referenceMonth });
  const monthSuffix = isPendingSheet
    ? "-pendentes"
    : `-${String(referenceMonth).slice(0, 7)}`;
  const monthCount = isPendingSheet
    ? new Set(rows.flatMap((row) => row.referenceMonths ?? [])).size
    : 1;

  if (rows.length === 0) {
    return {
      rowCount: 0,
      demandCount: 0,
      monthCount: 0,
      fileNames: [],
      isPendingSheet,
    };
  }

  // Agrupa preservando a ordem em que as demandas aparecem (a query já vem
  // ordenada por nome do doador, então o Map mantém uma ordem estável).
  const rowsByDemand = new Map();
  for (const row of rows) {
    const demandName = row.demand?.trim() || "Sem demanda";
    if (!rowsByDemand.has(demandName)) {
      rowsByDemand.set(demandName, []);
    }
    rowsByDemand.get(demandName).push(row);
  }

  const files = await Promise.all(
    Array.from(rowsByDemand.entries())
      .sort(([left], [right]) => left.localeCompare(right, "pt-BR"))
      .map(async ([demandName, demandRows]) => ({
        fileName: `notar-abatimento-${buildSlug(demandName) || "demanda"}${monthSuffix}.xlsx`,
        demandName,
        rowCount: demandRows.length,
        bytes: await buildAbatementWorkbookBytes({
          rows: demandRows,
          referenceMonth,
        }),
      })),
  );

  if (files.length === 1) {
    downloadFile({
      fileName: files[0].fileName,
      content: new Blob([files[0].bytes], { type: XLSX_MIME_TYPE }),
      mimeType: XLSX_MIME_TYPE,
    });
  } else {
    downloadFile({
      fileName: `notar-abatimento${monthSuffix}.zip`,
      content: createZipArchive(
        files.map((file) => ({ name: file.fileName, bytes: file.bytes })),
      ),
      mimeType: "application/zip",
    });
  }

  return {
    rowCount: rows.length,
    demandCount: files.length,
    monthCount,
    fileNames: files.map((file) => file.fileName),
    isPendingSheet,
  };
}

/**
 * Lista de números da sorte, para sorteio.
 *
 * Sai com nome e CPF já mascarados — a máscara vive no serviço, não aqui,
 * porque este arquivo é só mais um consumidor. O valor da nota e o crédito
 * que ela gerou não aparecem porque não são consultados em lugar nenhum
 * deste caminho.
 */
export async function exportRaffleNumbersCsv({
  period = "",
  scope = "month",
} = {}) {
  const rows = await listRaffleNumbers({ period, scope });

  const csvContent = buildCsvContent(
    [
      { key: "number", label: "Número" },
      { key: "name", label: "Nome" },
      { key: "cpf", label: "CPF" },
      { key: "noteDate", label: "Data da nota" },
    ],
    rows.map((row) => ({
      ...row,
      noteDate: formatDatePtBR(row.noteDate),
    })),
  );

  const sufixo = scope === "year" ? period.slice(0, 4) : period.slice(0, 7);
  downloadCsv(`notar-numeros-da-sorte-${sufixo}.csv`, csvContent);

  return { rowCount: rows.length };
}
