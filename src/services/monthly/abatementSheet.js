import { queryPrepared, startOfMonth } from "../db";
import { formatCpf } from "../../utils/cpf";
import { buildAbatementDescription } from "./abatementSheetDescription";
import {
  buildAbatementSheetSql,
  buildPendingAbatementSheetSql,
} from "./abatementSheetSql";
import { getActiveProjectId } from "../activeProject.js";

export { buildAbatementDescription };

function mapSheetRow(row, { referenceMonth = "", referenceMonths = [] } = {}) {
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
 * Uma linha por CPF com TODOS os meses ainda pendentes somados.
 *
 * VALOR é a soma das notas desses meses e a descrição nomeia o conjunto
 * ("Jan/2026 e Fev/2026", "Jan/2026 até Mar/2026"). Cada linha carrega o
 * próprio `referenceMonth` — o mais recente dos meses dela —, porque aqui não
 * existe um mês do arquivo: dois CPFs da mesma planilha podem ter pendências
 * em meses diferentes, e a DATA de cada um sai do conjunto dele.
 */
export async function listPendingAbatementSheetRows() {
  const rows = await queryPrepared(
    buildPendingAbatementSheetSql(getActiveProjectId()),
  );

  return rows.map((row) => {
    const referenceMonths = String(row.reference_months ?? "")
      .split(",")
      .map((month) => month.trim())
      .filter(Boolean)
      .sort();

    return {
      ...mapSheetRow(row, { referenceMonths }),
      referenceMonths,
      referenceMonth:
        row.last_month ?? referenceMonths[referenceMonths.length - 1] ?? "",
    };
  });
}
