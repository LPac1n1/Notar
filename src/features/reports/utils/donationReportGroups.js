import {
  DEFAULT_DEMAND_COLOR,
  normalizeDemandColor,
} from "../../../utils/demandColor.js";

function normalizeDemandKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

function toMonthKey(value) {
  return value ? String(value).slice(0, 7) : "";
}

/** A linha carrega um acumulado que consolida o próprio mês dela. */
function isAccumulatedRow(summary) {
  return Boolean(
    summary.hasAdjustment &&
      summary.adjustment &&
      summary.adjustmentSubsumesMonth,
  );
}

/**
 * Os intervalos consolidados por acumulado, por doador.
 *
 * Um acumulado "que absorve o mês" traz, numa linha só, todas as notas do
 * intervalo dele. As outras linhas do mesmo doador DENTRO desse intervalo já
 * estão contidas ali; as de FORA não têm nada a ver com ele.
 *
 * É montado antes de somar qualquer coisa, para o resultado não depender da
 * ordem em que os resumos chegam.
 */
function collectAccumulatedRanges(summaries) {
  const rangesByDonor = new Map();

  for (const summary of summaries) {
    if (!isAccumulatedRow(summary)) continue;

    const ranges = rangesByDonor.get(summary.donorId) ?? [];
    ranges.push({
      start: toMonthKey(summary.adjustment.rangeStartMonth),
      end: toMonthKey(summary.adjustment.rangeEndMonth),
    });
    rangesByDonor.set(summary.donorId, ranges);
  }

  return rangesByDonor;
}

/**
 * Esta linha já está contida num acumulado?
 *
 *  • A listagem marca `isSubsumed` quando o mês é coberto por um acumulado
 *    lançado em OUTRO mês — esteja esse outro mês no relatório ou não. Na
 *    tela é o "Via acumulado": o valor pertence ao mês do acumulado.
 *
 *  • Sem a marca, vale o intervalo dos acumulados presentes no relatório.
 *    Uma linha sem mês não tem como provar que está fora de intervalo
 *    nenhum, então é tratada como coberta — é o caso de duas importações do
 *    mesmo mês, em que só uma das linhas carrega o acumulado.
 */
function isCoveredByAccumulated(summary, ranges) {
  if (summary.isSubsumed) return true;
  if (!ranges || ranges.length === 0) return false;

  const month = toMonthKey(summary.referenceMonth);
  if (!month) return true;

  return ranges.some(
    (range) =>
      range.start && range.end && range.start <= month && month <= range.end,
  );
}

/** Guarda de qual acumulado a pessoa fala — o primeiro que aparecer. */
function rememberAdjustment(person, summary) {
  if (!person.adjustmentDescription) {
    person.adjustmentDescription = summary.adjustment.description ?? "";
  }
  if (!person.adjustmentRangeStartMonth) {
    person.adjustmentRangeStartMonth = summary.adjustment.rangeStartMonth ?? "";
  }
  if (!person.adjustmentRangeEndMonth) {
    person.adjustmentRangeEndMonth = summary.adjustment.rangeEndMonth ?? "";
  }
  if (!person.adjustmentReferenceMonth) {
    person.adjustmentReferenceMonth = toMonthKey(summary.referenceMonth);
  }
}

function addPersonToDemandGroup(group, summary, accumulatedRanges) {
  const target =
    summary.donorType === "auxiliary" ? group.auxiliaries : group.holders;
  const currentPerson = target.get(summary.donorId) ?? {
    id: summary.donorId,
    name: summary.donorName,
    cpf: summary.cpf,
    holderName: summary.holderName ?? "",
    donationStartDate: summary.donationStartDate ?? "",
    notesCount: 0,
    monthNotesCount: 0,
    // Acompanha `notesCount` passo a passo: o valor abatido é a contagem de
    // notas vezes o valor por nota do mês, então somar um sem somar o outro
    // faria a coluna de dinheiro contradizer a de doações na mesma linha.
    abatementAmount: 0,
    adjustmentNotesCount: 0,
    adjustmentDescription: "",
    adjustmentRangeStartMonth: "",
    adjustmentRangeEndMonth: "",
    adjustmentSubsumesMonth: false,
    // Mês em que o acumulado foi lançado. Num relatório de vários meses,
    // "consolidado neste mês" não diz qual.
    adjustmentReferenceMonth: "",
    // Preenchido quando as doações da pessoa neste relatório foram abatidas
    // junto de um acumulado lançado em outro mês.
    coveredByAccumulatedMonth: "",
    // Quanto veio de cada mês. As colunas mostram o total do período; sem
    // esta quebra, um relatório de vários meses não diria de onde veio o
    // número que o doador vai ler.
    monthsByRef: new Map(),
  };

  // Quanto ESTE resumo acrescenta à pessoa. O detalhe por mês usa o mesmo
  // número das colunas, então os dois nunca se contradizem.
  let addedNotes = 0;
  let addedAmount = 0;

  if (isAccumulatedRow(summary)) {
    // A linha do acumulado vale pelo intervalo inteiro dele — o mês em que
    // foi lançado incluído. SOMA à pessoa; não substitui o que ela tem.
    //
    // Antes substituía, e marcava a pessoa de um jeito que fazia todo outro
    // mês dela ser ignorado. Servia ao relatório de um mês só; com vários
    // meses, quem tinha um acumulado em maio perdia junho.
    const adjustmentNotes = Number(summary.adjustment.notesCount ?? 0);

    addedNotes = adjustmentNotes;
    addedAmount = Number(summary.abatementAmount ?? 0);
    currentPerson.notesCount += addedNotes;
    currentPerson.abatementAmount += addedAmount;
    currentPerson.adjustmentNotesCount += adjustmentNotes;
    currentPerson.adjustmentSubsumesMonth = true;
    rememberAdjustment(currentPerson, summary);
  } else if (isCoveredByAccumulated(summary, accumulatedRanges)) {
    // Já contida num acumulado: somar de novo cobraria o período duas vezes.
    if (summary.subsumedByReferenceMonth) {
      currentPerson.coveredByAccumulatedMonth = toMonthKey(
        summary.subsumedByReferenceMonth,
      );
    }
  } else if (summary.hasAdjustment && summary.adjustment) {
    // Acumulado só de meses ANTERIORES, somado por cima do mês: a linha já
    // traz "notas do mês + acumuladas".
    addedNotes = Number(summary.notesCount ?? 0);
    addedAmount = Number(summary.abatementAmount ?? 0);
    currentPerson.notesCount += addedNotes;
    currentPerson.monthNotesCount += Number(summary.monthNotesCount ?? 0);
    currentPerson.abatementAmount += addedAmount;
    currentPerson.adjustmentNotesCount += Number(
      summary.adjustment.notesCount ?? 0,
    );
    rememberAdjustment(currentPerson, summary);
  } else {
    addedNotes = Number(summary.notesCount ?? 0);
    addedAmount = Number(summary.abatementAmount ?? 0);
    currentPerson.notesCount += addedNotes;
    currentPerson.monthNotesCount += addedNotes;
    currentPerson.abatementAmount += addedAmount;
  }

  if (summary.referenceMonth && (addedNotes !== 0 || addedAmount !== 0)) {
    const monthKey = toMonthKey(summary.referenceMonth);
    const month = currentPerson.monthsByRef.get(monthKey) ?? {
      referenceMonth: monthKey,
      notesCount: 0,
      abatementAmount: 0,
    };

    month.notesCount += addedNotes;
    month.abatementAmount += addedAmount;
    currentPerson.monthsByRef.set(monthKey, month);
  }

  target.set(summary.donorId, currentPerson);
}

function finalizePerson(person) {
  const { monthsByRef, ...rest } = person;

  return {
    ...rest,
    months: Array.from(monthsByRef.values()).sort((left, right) =>
      left.referenceMonth.localeCompare(right.referenceMonth),
    ),
  };
}

export function mapDemandGroups({ demands, summaries }) {
  const demandByName = new Map(
    demands.map((demand) => [
      normalizeDemandKey(demand.name),
      {
        name: demand.name,
        color: normalizeDemandColor(demand.color),
      },
    ]),
  );
  const groupsByDemand = new Map();
  const accumulatedRangesByDonor = collectAccumulatedRanges(summaries);

  for (const summary of summaries) {
    const demandName = summary.demand || "Sem demanda";
    const demandKey = normalizeDemandKey(demandName);
    const demand = demandByName.get(demandKey) ?? {
      name: demandName,
      color: DEFAULT_DEMAND_COLOR,
    };

    if (!groupsByDemand.has(demandKey)) {
      groupsByDemand.set(demandKey, {
        name: demand.name,
        color: demand.color,
        holders: new Map(),
        auxiliaries: new Map(),
      });
    }

    addPersonToDemandGroup(
      groupsByDemand.get(demandKey),
      summary,
      accumulatedRangesByDonor.get(summary.donorId),
    );
  }

  return Array.from(groupsByDemand.values())
    .map((group) => ({
      ...group,
      holders: Array.from(group.holders.values())
        .map(finalizePerson)
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
      auxiliaries: Array.from(group.auxiliaries.values())
        .map(finalizePerson)
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}
