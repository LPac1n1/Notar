export function formatSyncTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

export function startOfMonth(value) {
  if (!value) {
    return "";
  }

  if (/^\d{4}-\d{2}$/.test(value)) {
    return `${value}-01`;
  }

  if (/^\d{2}\/\d{4}$/.test(value)) {
    const [month, year] = value.split("/");
    const monthNumber = Number(month);

    if (monthNumber < 1 || monthNumber > 12) {
      return "";
    }

    return `${year}-${month}-01`;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value.slice(0, 7)}-01`;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

export function formatMonthYear(value) {
  if (!value) {
    return "";
  }

  const [year, month] = String(value).split("-");

  if (!year || !month) {
    return value;
  }

  const date = new Date(`${year}-${month}-01T00:00:00`);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const formattedValue = new Intl.DateTimeFormat("pt-BR", {
    month: "long",
    year: "numeric",
  }).format(date);

  return formattedValue.charAt(0).toUpperCase() + formattedValue.slice(1);
}

// Abreviações fixas em vez de Intl: `month: "short"` no pt-BR devolve "abr."
// (com ponto, minúsculo) e a forma varia entre runtimes. A descrição do
// abatimento vai para outro sistema, então precisa ser estável e previsível.
const MONTH_ABBREVIATIONS = [
  "Jan",
  "Fev",
  "Mar",
  "Abr",
  "Mai",
  "Jun",
  "Jul",
  "Ago",
  "Set",
  "Out",
  "Nov",
  "Dez",
];

/**
 * "2026-04-01" → "Abr/2026". Usado na descrição da planilha de abatimento.
 */
export function formatMonthAbbrev(value) {
  if (!value) {
    return "";
  }

  const [year, month] = String(value).split("-");
  const monthIndex = Number(month) - 1;

  if (!year || !MONTH_ABBREVIATIONS[monthIndex]) {
    return String(value);
  }

  return `${MONTH_ABBREVIATIONS[monthIndex]}/${year}`;
}

function toAbsoluteMonthIndex(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : null;
}

function formatContiguousMonths(months) {
  const first = formatMonthAbbrev(months[0]);

  if (months.length === 1) {
    return first;
  }

  const last = formatMonthAbbrev(months[months.length - 1]);

  return months.length === 2 ? `${first} e ${last}` : `${first} até ${last}`;
}

/**
 * Rótulo de um conjunto de meses.
 *
 * Os meses são quebrados em trechos seguidos, e cada trecho vira:
 *
 *   um mês        "Mar/2026"
 *   dois meses    "Jan/2026 e Fev/2026"
 *   três ou mais  "Jan/2026 até Mar/2026"
 *
 * Trechos separados por um mês que não entra no conjunto (um mês já abatido,
 * por exemplo) são ligados por ponto e vírgula:
 *
 *   jan, fev, mar, mai, jun  →  "Jan/2026 até Mar/2026; Mai/2026 e Jun/2026"
 *
 * O "até" nunca atravessa um buraco: "Jan/2026 até Jun/2026" nesse exemplo
 * diria que abril está no total, e o sistema de baixa registraria um mês que
 * ninguém abateu. A virada de ano conta como seguida (dez → jan), por isso a
 * comparação é por índice absoluto de mês e não pelo número do mês sozinho.
 *
 * Aceita `AAAA-MM` ou data completa, em qualquer ordem e com repetição.
 */
export function formatMonthsSpan(months = []) {
  const unicos = [
    ...new Set(
      months
        .map((month) => String(month ?? "").slice(0, 7))
        .filter((month) => /^\d{4}-\d{2}$/.test(month)),
    ),
  ].sort();

  const trechos = [];

  for (const month of unicos) {
    const indice = toAbsoluteMonthIndex(month);
    const trechoAtual = trechos[trechos.length - 1];

    if (trechoAtual && indice === trechoAtual.ultimoIndice + 1) {
      trechoAtual.meses.push(month);
      trechoAtual.ultimoIndice = indice;
    } else {
      trechos.push({ meses: [month], ultimoIndice: indice });
    }
  }

  return trechos.map((trecho) => formatContiguousMonths(trecho.meses)).join("; ");
}

/**
 * "2026-03-01" → "01/03/2026".
 *
 * A data sem hora é formatada a partir do TEXTO, sem passar por `Date`.
 * `new Date("2026-03-01")` é interpretado como meia-noite em UTC pela
 * especificação; formatado em UTC-3, volta um dia e vira "28/02/2026" — a data
 * da nota aparecia no mês anterior ao da própria competência.
 *
 * O defeito ficou latente por muito tempo porque todos os usos anteriores
 * passavam data COM hora ("2026-03-01 10:00:00"), que o mesmo construtor lê
 * como horário local e por isso não desloca. A primeira tela a exibir uma data
 * pura — o histórico de compras do doador — foi a que revelou.
 *
 * Valor com hora continua pelo caminho antigo de propósito: ali a conversão
 * para o fuso local é o comportamento certo.
 */
export function formatDatePtBR(value) {
  if (!value) {
    return "";
  }

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());

  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    return `${day}/${month}/${year}`;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

export function formatDateTimePtBR(value) {
  if (!value) {
    return "";
  }

  const normalizedValue = String(value).includes("T")
    ? value
    : String(value).replace(" ", "T");
  const date = new Date(normalizedValue);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatDonationDuration(startMonth, now = new Date()) {
  const normalizedStartMonth = startOfMonth(startMonth);

  if (!normalizedStartMonth) {
    return "";
  }

  const [startYear, startMonthNumber] = normalizedStartMonth
    .split("-")
    .map(Number);
  const currentYear = now.getFullYear();
  const currentMonthNumber = now.getMonth() + 1;
  const totalMonths =
    (currentYear - startYear) * 12 + (currentMonthNumber - startMonthNumber) + 1;

  if (!Number.isFinite(totalMonths) || totalMonths <= 0) {
    return "Ainda não iniciado";
  }

  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;

  if (years === 0) {
    return `${totalMonths} ${totalMonths === 1 ? "mês" : "meses"}`;
  }

  if (months === 0) {
    return `${years} ${years === 1 ? "ano" : "anos"}`;
  }

  return `${years} ${years === 1 ? "ano" : "anos"} e ${months} ${
    months === 1 ? "mês" : "meses"
  }`;
}

export function subtractOneMonth(value) {
  if (!value) {
    return "";
  }

  const [year, month] = String(value).split("-");

  if (!year || !month) {
    return "";
  }

  const date = new Date(Number(year), Number(month) - 1, 1);
  date.setMonth(date.getMonth() - 1);

  const nextYear = date.getFullYear();
  const nextMonth = String(date.getMonth() + 1).padStart(2, "0");
  return `${nextYear}-${nextMonth}-01`;
}

export function hasDonationStartConflict(donationStartDate, referenceMonth) {
  const normalizedDonationStartDate = startOfMonth(donationStartDate);
  const normalizedReferenceMonth = startOfMonth(referenceMonth);

  if (!normalizedDonationStartDate || !normalizedReferenceMonth) {
    return false;
  }

  return normalizedDonationStartDate > normalizedReferenceMonth;
}
