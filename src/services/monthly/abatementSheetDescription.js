// Extensão explícita: este módulo é importado direto pela suíte de testes em
// Node, que (ao contrário do Vite) não resolve import sem extensão.
import { formatMonthAbbrev, formatMonthsSpan } from "../../utils/date.js";

export { formatMonthsSpan };

/**
 * Descrição de cada linha da planilha de abatimento, no formato que o sistema
 * de destino espera.
 *
 * Sem auxiliares no grupo:  "Doações NFP - Abr/2026"
 * Com auxiliares no grupo:  "Doações NFP - MARIA SILVA - Abr/2026"
 * Vários meses pendentes:   "Doações NFP - Jan/2026 e Fev/2026"
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
  groupHasAuxiliaries = false,
} = {}) {
  // Vários meses vêm da planilha de pendentes; um só, da planilha do mês.
  const monthLabel =
    referenceMonths.length > 0
      ? formatMonthsSpan(referenceMonths)
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
