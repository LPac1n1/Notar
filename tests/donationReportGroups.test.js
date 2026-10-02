import test from "node:test";
import assert from "node:assert/strict";
import { mapDemandGroups } from "../src/features/reports/utils/donationReportGroups.js";

const DEMANDS = [{ name: "Demanda A", color: "#39C6F4" }];

function buildSummary(overrides = {}) {
  return {
    donorId: "donor-1",
    donorName: "Maria Silva",
    cpf: "11111111111",
    demand: "Demanda A",
    donorType: "holder",
    holderName: "",
    donationStartDate: "2025-01-01",
    notesCount: 0,
    monthNotesCount: 0,
    hasAdjustment: false,
    adjustment: null,
    adjustmentSubsumesMonth: false,
    ...overrides,
  };
}

test("demand report groups do not double-count monthly rows covered by a subsuming accumulated adjustment", () => {
  const plainMonthlyRow = buildSummary({
    notesCount: 232,
    monthNotesCount: 232,
  });
  const accumulatedRow = buildSummary({
    notesCount: 259,
    monthNotesCount: 0,
    hasAdjustment: true,
    adjustmentSubsumesMonth: true,
    adjustment: {
      id: "adj-1",
      notesCount: 259,
      description: "Acumulado de Janeiro de 2026 a Fevereiro de 2026",
      rangeStartMonth: "2026-01-01",
      rangeEndMonth: "2026-02-01",
    },
  });

  for (const summaries of [
    [plainMonthlyRow, accumulatedRow],
    [accumulatedRow, plainMonthlyRow],
  ]) {
    const [group] = mapDemandGroups({ demands: DEMANDS, summaries });
    const [holder] = group.holders;

    assert.equal(holder.notesCount, 259);
    assert.equal(holder.monthNotesCount, 0);
    assert.equal(holder.adjustmentNotesCount, 259);
    assert.equal(holder.adjustmentSubsumesMonth, true);
  }
});

test("demand report groups keep additive accumulated adjustments on top of monthly rows", () => {
  const extraMonthlyRow = buildSummary({
    notesCount: 7,
    monthNotesCount: 7,
  });
  const additiveAccumulatedRow = buildSummary({
    notesCount: 35,
    monthNotesCount: 10,
    hasAdjustment: true,
    adjustmentSubsumesMonth: false,
    adjustment: {
      id: "adj-2",
      notesCount: 25,
      description: "Acumulado de Janeiro de 2026",
      rangeStartMonth: "2026-01-01",
      rangeEndMonth: "2026-01-01",
    },
  });

  const [group] = mapDemandGroups({
    demands: DEMANDS,
    summaries: [extraMonthlyRow, additiveAccumulatedRow],
  });
  const [holder] = group.holders;

  assert.equal(holder.notesCount, 42);
  assert.equal(holder.monthNotesCount, 17);
  assert.equal(holder.adjustmentNotesCount, 25);
  assert.equal(holder.adjustmentSubsumesMonth, false);
});

test("o valor abatido acompanha a contagem de notas linha a linha", () => {
  // A coluna de dinheiro e a de doações descrevem a MESMA linha do relatório.
  // Se uma somasse e a outra não, o leitor veria "42 doações — R$ 35,00" com
  // um valor por nota que não existe em lugar nenhum.
  const primeiraLinha = buildSummary({
    notesCount: 7,
    monthNotesCount: 7,
    abatementAmount: 3.5,
  });
  const segundaLinha = buildSummary({
    notesCount: 35,
    monthNotesCount: 35,
    abatementAmount: 17.5,
  });

  const [group] = mapDemandGroups({
    demands: DEMANDS,
    summaries: [primeiraLinha, segundaLinha],
  });
  const [holder] = group.holders;

  assert.equal(holder.notesCount, 42);
  assert.equal(holder.abatementAmount, 21);
});

test("acumulado que absorve o mês substitui o valor, não soma duas vezes", () => {
  // Mesmo cuidado da contagem: quando o acumulado cobre o mês, a linha do mês
  // já está contida nele. Somar os dois valores cobraria o período duas vezes.
  const linhaDoMes = buildSummary({
    notesCount: 232,
    monthNotesCount: 232,
    abatementAmount: 116,
  });
  const linhaAcumulada = buildSummary({
    notesCount: 259,
    monthNotesCount: 0,
    abatementAmount: 129.5,
    hasAdjustment: true,
    adjustmentSubsumesMonth: true,
    adjustment: {
      id: "adj-1",
      notesCount: 259,
      description: "Acumulado",
      rangeStartMonth: "2026-01-01",
      rangeEndMonth: "2026-02-01",
    },
  });

  for (const summaries of [
    [linhaDoMes, linhaAcumulada],
    [linhaAcumulada, linhaDoMes],
  ]) {
    const [group] = mapDemandGroups({ demands: DEMANDS, summaries });
    const [holder] = group.holders;
    assert.equal(holder.notesCount, 259);
    assert.equal(holder.abatementAmount, 129.5);
  }
});

/**
 * Detalhe por mês.
 *
 * Com vários meses escolhidos na Gestão Mensal, as colunas do relatório
 * mostram o TOTAL do período; `months` é o que diz de onde veio cada parte.
 * O que estes testes travam é a relação entre os dois: o detalhe sempre soma
 * exatamente o total das colunas.
 */
function holderFor(summaries) {
  const [group] = mapDemandGroups({ demands: DEMANDS, summaries });
  return group.holders[0];
}

test("dois meses do mesmo doador somam no total e aparecem separados no detalhe", () => {
  const holder = holderFor([
    buildSummary({
      referenceMonth: "2026-02-01",
      notesCount: 12,
      monthNotesCount: 12,
      abatementAmount: 24,
    }),
    buildSummary({
      referenceMonth: "2026-03-01",
      notesCount: 18,
      monthNotesCount: 18,
      abatementAmount: 36,
    }),
  ]);

  assert.equal(holder.notesCount, 30);
  assert.equal(holder.abatementAmount, 60);
  assert.deepEqual(holder.months, [
    { referenceMonth: "2026-02", notesCount: 12, abatementAmount: 24 },
    { referenceMonth: "2026-03", notesCount: 18, abatementAmount: 36 },
  ]);

  const somaDoDetalhe = holder.months.reduce(
    (total, month) => total + month.abatementAmount,
    0,
  );
  assert.equal(somaDoDetalhe, holder.abatementAmount);
});

test("o detalhe sai em ordem de mês, mesmo com os resumos fora de ordem", () => {
  // A consulta devolve do mês mais recente para o mais antigo.
  const holder = holderFor([
    buildSummary({
      referenceMonth: "2026-03-01",
      notesCount: 18,
      abatementAmount: 36,
    }),
    buildSummary({
      referenceMonth: "2026-01-01",
      notesCount: 8,
      abatementAmount: 16,
    }),
    buildSummary({
      referenceMonth: "2026-02-01",
      notesCount: 12,
      abatementAmount: 24,
    }),
  ]);

  assert.deepEqual(
    holder.months.map((month) => month.referenceMonth),
    ["2026-01", "2026-02", "2026-03"],
  );
});

test("mês repetido (duas importações) vira uma entrada só no detalhe", () => {
  const holder = holderFor([
    buildSummary({
      referenceMonth: "2026-02-01",
      notesCount: 5,
      abatementAmount: 10,
    }),
    buildSummary({
      referenceMonth: "2026-02-01",
      notesCount: 7,
      abatementAmount: 14,
    }),
  ]);

  assert.equal(holder.notesCount, 12);
  assert.deepEqual(holder.months, [
    { referenceMonth: "2026-02", notesCount: 12, abatementAmount: 24 },
  ]);
});

test("acumulado que consolida o mês substitui também o detalhe", () => {
  // O acumulado de março já embute janeiro. Se o detalhe guardasse o mês
  // anterior junto, a linha fina contradiria o total das colunas.
  const holder = holderFor([
    buildSummary({
      referenceMonth: "2026-01-01",
      notesCount: 8,
      monthNotesCount: 8,
      abatementAmount: 16,
    }),
    buildSummary({
      referenceMonth: "2026-03-01",
      notesCount: 0,
      monthNotesCount: 0,
      abatementAmount: 60,
      hasAdjustment: true,
      adjustmentSubsumesMonth: true,
      adjustment: {
        id: "adj-3",
        notesCount: 30,
        description: "Acumulado",
        rangeStartMonth: "2026-01-01",
        rangeEndMonth: "2026-03-01",
      },
    }),
  ]);

  assert.equal(holder.notesCount, 30);
  assert.equal(holder.abatementAmount, 60);
  assert.deepEqual(holder.months, [
    { referenceMonth: "2026-03", notesCount: 30, abatementAmount: 60 },
  ]);
});

/**
 * Acumulado + meses que ele NÃO cobre.
 *
 * O acumulado consolida os meses do intervalo dele, e só eles. Antes, bastava
 * a pessoa ter um acumulado para todos os outros meses dela sumirem do
 * relatório — inclusive os posteriores ao intervalo. Quem lançava o acumulado
 * em maio e importava junho via o relatório de maio+junho sem junho.
 */
function accumulatedRow(overrides = {}) {
  return buildSummary({
    referenceMonth: "2026-05-01",
    notesCount: 56,
    monthNotesCount: 0,
    abatementAmount: 56,
    hasAdjustment: true,
    adjustmentSubsumesMonth: true,
    adjustment: {
      id: "adj-may",
      notesCount: 56,
      description: "Acumulado",
      rangeStartMonth: "2026-04-01",
      rangeEndMonth: "2026-05-01",
    },
    ...overrides,
  });
}

test("mês posterior ao acumulado soma ao total e aparece no detalhe", () => {
  const june = buildSummary({
    referenceMonth: "2026-06-01",
    notesCount: 30,
    monthNotesCount: 30,
    abatementAmount: 30,
  });

  // A ordem em que os resumos chegam não pode mudar o resultado.
  for (const summaries of [
    [accumulatedRow(), june],
    [june, accumulatedRow()],
  ]) {
    const holder = holderFor(summaries);

    assert.equal(holder.notesCount, 56 + 30);
    assert.equal(holder.abatementAmount, 56 + 30);
    assert.equal(holder.adjustmentNotesCount, 56);
    assert.equal(holder.monthNotesCount, 30);
    assert.deepEqual(holder.months, [
      { referenceMonth: "2026-05", notesCount: 56, abatementAmount: 56 },
      { referenceMonth: "2026-06", notesCount: 30, abatementAmount: 30 },
    ]);
  }
});

test("mês anterior ao intervalo do acumulado também soma", () => {
  const march = buildSummary({
    referenceMonth: "2026-03-01",
    notesCount: 4,
    monthNotesCount: 4,
    abatementAmount: 4,
  });
  const holder = holderFor([march, accumulatedRow()]);

  assert.equal(holder.notesCount, 4 + 56);
  assert.deepEqual(
    holder.months.map((month) => month.referenceMonth),
    ["2026-03", "2026-05"],
  );
});

test("mês coberto pelo acumulado não soma de novo, venha marcado ou não", () => {
  const april = {
    referenceMonth: "2026-04-01",
    notesCount: 28,
    monthNotesCount: 28,
    abatementAmount: 28,
  };

  // Como a listagem entrega: a linha de abril chega marcada "Via acumulado".
  const flagged = holderFor([
    buildSummary({ ...april, isSubsumed: true }),
    accumulatedRow(),
  ]);
  // E sem a marca, só pelo intervalo.
  const byRange = holderFor([buildSummary(april), accumulatedRow()]);

  for (const holder of [flagged, byRange]) {
    assert.equal(holder.notesCount, 56);
    assert.equal(holder.abatementAmount, 56);
    assert.deepEqual(holder.months, [
      { referenceMonth: "2026-05", notesCount: 56, abatementAmount: 56 },
    ]);
  }
});

test("linha coberta por acumulado de um mês FORA do relatório não entra", () => {
  // Relatório só de abril, com o acumulado lançado em maio: abril aparece na
  // tela como "Via acumulado" e o valor dele pertence ao relatório de maio.
  const [group] = mapDemandGroups({
    demands: DEMANDS,
    summaries: [
      buildSummary({
        referenceMonth: "2026-04-01",
        notesCount: 28,
        monthNotesCount: 28,
        abatementAmount: 28,
        isSubsumed: true,
      }),
      buildSummary({
        donorId: "donor-2",
        donorName: "Outro Doador",
        referenceMonth: "2026-04-01",
        notesCount: 3,
        monthNotesCount: 3,
        abatementAmount: 3,
      }),
    ],
  });

  const covered = group.holders.find((person) => person.id === "donor-1");
  assert.equal(covered.notesCount, 0);
  assert.equal(covered.abatementAmount, 0);
  assert.deepEqual(covered.months, []);
});

test("dois acumulados de intervalos diferentes somam, cada um no seu mês", () => {
  const february = accumulatedRow({
    referenceMonth: "2026-02-01",
    notesCount: 20,
    abatementAmount: 20,
    adjustment: {
      id: "adj-feb",
      notesCount: 20,
      description: "Acumulado",
      rangeStartMonth: "2026-01-01",
      rangeEndMonth: "2026-02-01",
    },
  });
  const holder = holderFor([february, accumulatedRow()]);

  assert.equal(holder.notesCount, 20 + 56);
  assert.equal(holder.adjustmentNotesCount, 20 + 56);
  assert.deepEqual(holder.months, [
    { referenceMonth: "2026-02", notesCount: 20, abatementAmount: 20 },
    { referenceMonth: "2026-05", notesCount: 56, abatementAmount: 56 },
  ]);
});
