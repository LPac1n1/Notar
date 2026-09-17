import { queryPrepared, startOfMonth } from "../db";
import { formatCpf } from "../../utils/cpf";
import {
  buildAbatementDescription,
  parseMonthList,
} from "./abatementSheetDescription";
import {
  buildAbatementSheetSql,
  buildMonthsAbatementSheetSql,
  buildPendingAbatementSheetSql,
} from "./abatementSheetSql";
import { getActiveProjectId } from "../activeProject.js";

export { buildAbatementDescription };

function mapSheetRow(
  row,
  { referenceMonth = "", referenceMonths = [], donationMonths } = {},
) {
  const donorName = row.donor_name ?? "";
  const groupHasAuxiliaries = Boolean(row.group_has_auxiliaries);

  return {
    cpf: formatCpf(row.cpf),
    cpfValue: row.cpf ?? "",
    donorName,
    // O que sai nas colunas NOME e CPF da planilha: do titular quando a
    // linha é de um auxiliar, da própria pessoa quando é de um titular.
    // `donorName` acima segue sendo o dono do CPF que gerou as notas, e é
    // ele que aparece na descrição.
    sheetName: row.sheet_name ?? donorName,
    sheetCpf: formatCpf(row.sheet_cpf ?? row.cpf),
    demand: row.demand ?? "",
    donorType: row.donor_type === "auxiliary" ? "auxiliary" : "holder",
    donorTypeLabel: row.donor_type === "auxiliary" ? "Auxiliar" : "Titular",
    notesCount: Number(row.notes_count ?? 0),
    groupHasAuxiliaries,
    description: buildAbatementDescription({
      donorName,
      referenceMonth,
      referenceMonths,
      donationMonths,
      groupHasAuxiliaries,
    }),
  };
}

/**
 * Uma linha por CPF de doador com notas no mês, pronta para importar no
 * sistema que faz o abatimento.
 */
export async function listAbatementSheetRows({ referenceMonth } = {}) {
  const normalizedMonth = startOfMonth(referenceMonth);

  if (!normalizedMonth) {
    return [];
  }

  const rows = await queryPrepared(buildAbatementSheetSql(getActiveProjectId()), [
    normalizedMonth,
  ]);

  // Sem `referenceMonth` na linha de propósito: todas usam o mês do arquivo.
  return rows.map((row) => mapSheetRow(row, { referenceMonth: normalizedMonth }));
}

/**
 * Linha de planilha que soma vários meses.
 *
 * Carrega o próprio `referenceMonth` — o mais recente do conjunto —, porque
 * aqui não existe um mês do arquivo: dois CPFs da mesma planilha podem ter
 * conjuntos diferentes, e a DATA de cada linha sai do conjunto dela.
 */
function mapMultiMonthSheetRow(row) {
  const referenceMonths = parseMonthList(row.reference_months);
  const donationMonths = parseMonthList(row.donation_months);

  return {
    ...mapSheetRow(row, { referenceMonths, donationMonths }),
    referenceMonths,
    referenceMonth:
      row.last_month ?? referenceMonths[referenceMonths.length - 1] ?? "",
  };
}

/**
 * Uma linha por CPF somando os meses ESCOLHIDOS na Gestão Mensal.
 *
 * A descrição nomeia o conjunto ("Doações NFP - Mai/2026 e Jun/2026"), e o
 * VALOR é a soma das notas desses meses. Diferente da planilha de pendentes,
 * o status não filtra nada: o operador escolheu o período.
 */
export async function listMonthsAbatementSheetRows(referenceMonths = []) {
  const months = Array.from(
    new Set(
      (referenceMonths ?? [])
        .map((month) => startOfMonth(month))
        .filter(Boolean),
    ),
  ).sort();

  if (months.length === 0) {
    return [];
  }

  const rows = await queryPrepared(
    buildMonthsAbatementSheetSql(getActiveProjectId(), months.length),
    months,
  );

  return rows.map(mapMultiMonthSheetRow);
}

/**
 * Uma linha por CPF com TODOS os meses ainda pendentes somados.
 *
 * VALOR é a soma das notas desses meses e a descrição nomeia o conjunto
 * ("Jan/2026 e Fev/2026", "Jan/2026 até Mar/2026; Mai/2026"). Os meses com
 * doação do CPF vão junto para a descrição saber onde partir o "até" — só num
 * mês com doação que ficou de fora, nunca num mês sem doação.
 *
 * Cada linha carrega o próprio `referenceMonth` — o mais recente dos meses
 * dela —, porque aqui não existe um mês do arquivo: dois CPFs da mesma
 * planilha podem ter pendências em meses diferentes, e a DATA de cada um sai
 * do conjunto dele.
 */
export async function listPendingAbatementSheetRows() {
  const rows = await queryPrepared(
    buildPendingAbatementSheetSql(getActiveProjectId()),
  );

  return rows.map(mapMultiMonthSheetRow);
}
