import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMonthsSpan } from "../src/utils/date.js";
import {
  buildAbatementDescription,
  parseMonthList,
} from "../src/services/monthly/abatementSheetDescription.js";

/**
 * O rótulo de meses.
 *
 * Um mês sai sozinho, dois vizinhos são ligados por "e", e primeiro e último
 * com mês entre eles viram "até". Trechos separados são ligados por ponto e
 * vírgula.
 *
 * Na planilha dos pendentes, o que separa trechos é SÓ um mês que teve doação
 * e ficou de fora (abatido antes). Mês sem doação no meio é atravessado pelo
 * "até" — partir ali faria o doador perguntar por que aquele mês não foi
 * abatido, quando não havia nada a abater.
 */

test("um mês sai sozinho", () => {
  assert.equal(formatMonthsSpan(["2026-03-01"]), "Mar/2026");
});

test("dois meses vizinhos são ligados por 'e'", () => {
  assert.equal(formatMonthsSpan(["2026-01-01", "2026-02-01"]), "Jan/2026 e Fev/2026");
});

test("três ou mais meses seguidos viram 'até'", () => {
  assert.equal(
    formatMonthsSpan(["2026-01-01", "2026-02-01", "2026-03-01"]),
    "Jan/2026 até Mar/2026",
  );
  assert.equal(
    formatMonthsSpan([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
    ]),
    "Jan/2026 até Mai/2026",
  );
});

test("sem meses que partem, qualquer mês que falte separa os trechos", () => {
  // Modo literal, usado onde a lista descreve exatamente os meses recebidos.
  assert.equal(
    formatMonthsSpan([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
      "2026-05-01",
      "2026-06-01",
    ]),
    "Jan/2026 até Mar/2026; Mai/2026 e Jun/2026",
  );
  assert.equal(formatMonthsSpan(["2026-01-01", "2026-05-01"]), "Jan/2026; Mai/2026");
});

test("mês sem doação no meio é atravessado pelo 'até'", () => {
  // Pendentes em janeiro e março; fevereiro não teve doação.
  assert.equal(
    formatMonthsSpan(["2026-01-01", "2026-03-01"], { breakMonths: [] }),
    "Jan/2026 até Mar/2026",
  );
  // Vários meses sem doação no meio continuam um trecho só.
  assert.equal(
    formatMonthsSpan(["2026-01-01", "2026-02-01", "2026-06-01"], { breakMonths: [] }),
    "Jan/2026 até Jun/2026",
  );
});

test("só um mês com doação que ficou de fora parte o 'até'", () => {
  // O exemplo do pedido: janeiro a março pendentes, abril abatido, maio e
  // junho pendentes.
  assert.equal(
    formatMonthsSpan(
      ["2026-01-01", "2026-02-01", "2026-03-01", "2026-05-01", "2026-06-01"],
      { breakMonths: ["2026-04-01"] },
    ),
    "Jan/2026 até Mar/2026; Mai/2026 e Jun/2026",
  );

  // Fevereiro abatido parte; abril e maio, sem doação, são atravessados.
  assert.equal(
    formatMonthsSpan(["2026-01-01", "2026-03-01", "2026-06-01"], {
      breakMonths: ["2026-02-01"],
    }),
    "Jan/2026; Mar/2026 até Jun/2026",
  );
});

test("mês que parte fora do intervalo não muda nada", () => {
  // Um mês abatido antes do primeiro ou depois do último pendente não está
  // entre dois pendentes, então não separa ninguém.
  assert.equal(
    formatMonthsSpan(["2026-03-01", "2026-04-01"], {
      breakMonths: ["2026-01-01", "2026-06-01"],
    }),
    "Mar/2026 e Abr/2026",
  );
});

test("a virada de ano conta como mês seguido", () => {
  assert.equal(
    formatMonthsSpan(["2025-11-01", "2025-12-01", "2026-01-01"]),
    "Nov/2025 até Jan/2026",
  );
  assert.equal(formatMonthsSpan(["2025-12-01", "2026-01-01"]), "Dez/2025 e Jan/2026");
  // Atravessando janeiro sem doação.
  assert.equal(
    formatMonthsSpan(["2025-12-01", "2026-02-01"], { breakMonths: [] }),
    "Dez/2025 até Fev/2026",
  );
});

test("meses seguidos em número mas de anos diferentes não são seguidos", () => {
  // Comparar só o número do mês acharia fevereiro/2025 colado em março/2026.
  assert.equal(formatMonthsSpan(["2025-02-01", "2026-03-01"]), "Fev/2025; Mar/2026");
  assert.equal(formatMonthsSpan(["2025-12-01", "2027-01-01"]), "Dez/2025; Jan/2027");
});

test("ordem, repetição e formato da entrada não mudam o rótulo", () => {
  // A consulta devolve os meses agregados sem ordem garantida.
  assert.equal(
    formatMonthsSpan(["2026-06-01", "2026-03-01", "2026-01", "2026-02-01", "2026-05-01", "2026-01-01"]),
    "Jan/2026 até Mar/2026; Mai/2026 e Jun/2026",
  );
});

test("sem mês válido, rótulo vazio", () => {
  assert.equal(formatMonthsSpan([]), "");
  assert.equal(formatMonthsSpan(["", null, "qualquer coisa"]), "");
});

test("a lista agregada pela consulta vira meses ordenados", () => {
  assert.deepEqual(parseMonthList("2026-03-01,2026-01-01, 2026-02-01"), [
    "2026-01-01",
    "2026-02-01",
    "2026-03-01",
  ]);
  assert.deepEqual(parseMonthList(null), []);
  assert.deepEqual(parseMonthList(""), []);
});

test("a descrição dos pendentes parte só nos meses com doação que ficaram de fora", () => {
  assert.equal(
    buildAbatementDescription({
      referenceMonths: ["2026-01-01", "2026-02-01"],
      donationMonths: ["2026-01-01", "2026-02-01"],
    }),
    "Doações NFP - Jan/2026 e Fev/2026",
  );

  // Fevereiro sem doação: janeiro e março pendentes viram um intervalo só.
  assert.equal(
    buildAbatementDescription({
      referenceMonths: ["2026-01-01", "2026-03-01"],
      donationMonths: ["2026-01-01", "2026-03-01"],
    }),
    "Doações NFP - Jan/2026 até Mar/2026",
  );

  // Abril teve doação e foi abatido antes: parte. O nome entra porque o grupo
  // tem auxiliar.
  assert.equal(
    buildAbatementDescription({
      donorName: "JOAO AUXILIAR",
      referenceMonths: ["2026-01-01", "2026-02-01", "2026-03-01", "2026-05-01", "2026-06-01"],
      donationMonths: [
        "2026-01-01",
        "2026-02-01",
        "2026-03-01",
        "2026-04-01",
        "2026-05-01",
        "2026-06-01",
      ],
      groupHasAuxiliaries: true,
    }),
    "Doações NFP - JOAO AUXILIAR - Jan/2026 até Mar/2026; Mai/2026 e Jun/2026",
  );

  // Com a lista presente, o mês avulso é ignorado.
  assert.equal(
    buildAbatementDescription({
      referenceMonth: "2026-06-01",
      referenceMonths: ["2026-01-01"],
      donationMonths: ["2026-01-01"],
    }),
    "Doações NFP - Jan/2026",
  );
});
