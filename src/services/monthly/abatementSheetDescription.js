// Extensão explícita: este módulo é importado direto pela suíte de testes em
// Node, que (ao contrário do Vite) não resolve import sem extensão.
import { formatMonthAbbrev, formatMonthsSpan } from "../../utils/date.js";

export { formatMonthsSpan };

function monthKey(month) {
  return String(month ?? "").slice(0, 7);
}

/**
 * Lista de meses agregada pela consulta ("2026-01-01,2026-03-01"), já
 * ordenada. Fica aqui, e não no serviço, para o teste de integração ler o
 * resultado da consulta com a mesma função que a produção usa.
 */
export function parseMonthList(value) {
  return String(value ?? "")
    .split(",")
    .map((month) => month.trim())
    .filter(Boolean)
    .sort();
}

/**
 * Meses COM doação que ficaram fora do conjunto pendente — abatidos antes,
 * cobertos por acumulado lançado em outro mês ou de outro projeto. São os
 * únicos que partem o "até" da planilha dos pendentes; mês sem doação no
 * meio é atravessado.
 *
 * Sem `donationMonths` não dá para distinguir mês sem doação de mês abatido,
 * e o rótulo volta a partir em qualquer mês que falte.
 */
function findBreakMonths(referenceMonths, donationMonths) {
  if (!Array.isArray(donationMonths)) {
    return undefined;
  }

  const included = new Set(referenceMonths.map(monthKey));
  return donationMonths.filter((month) => !included.has(monthKey(month)));
}

/**
 * Descrição de cada linha da planilha de abatimento, no formato que o sistema
 * de destino espera.
 *
 * Sem auxiliares no grupo:  "Doações NFP - Abr/2026"
 * Com auxiliares no grupo:  "Doações NFP - MARIA SILVA - Abr/2026"
 * Vários meses pendentes:   "Doações NFP - Jan/2026 até Mar/2026; Mai/2026"
 *
 * O nome entra justamente quando o grupo tem mais de uma pessoa doando para o
 * mesmo titular: lá o titular recebe vários lançamentos no mesmo mês e, sem o
 * nome, não haveria como saber a que CPF cada lançamento pertence.
 *
 * Fica num módulo sem dependência de banco para o teste poder exercitar a
 * função de produção em vez de reimplementar o formato.
 */
export function buildAbatementDescription({
  donorName = "",
  referenceMonth = "",
  referenceMonths = [],
  donationMonths,
  groupHasAuxiliaries = false,
} = {}) {
  // Vários meses vêm da planilha de pendentes; um só, da planilha do mês.
  const monthLabel =
    referenceMonths.length > 0
      ? formatMonthsSpan(referenceMonths, {
          breakMonths: findBreakMonths(referenceMonths, donationMonths),
        })
      : formatMonthAbbrev(referenceMonth);
  const parts = ["Doações NFP"];

  if (groupHasAuxiliaries && donorName) {
    parts.push(donorName);
  }

  if (monthLabel) {
    parts.push(monthLabel);
  }

  return parts.join(" - ");
}
