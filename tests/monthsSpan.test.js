import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMonthsSpan } from "../src/utils/date.js";
import { buildAbatementDescription } from "../src/services/monthly/abatementSheetDescription.js";

/**
 * O rótulo de meses da planilha de pendentes.
 *
 * Os meses viram trechos seguidos: um mês sai sozinho, dois são ligados por
 * "e", três ou mais viram "até". Trechos separados por um mês que não entra
 * são ligados por ponto e vírgula.
 *
 * Vai para a descrição que o sistema de baixa registra, então o erro que
 * importa não é de estética: um "até" atravessando um mês abatido diria que
 * aquele mês está no total, e ninguém o abateu.
 */

test("um mês sai sozinho", () => {
  assert.equal(formatMonthsSpan(["2026-03-01"]), "Mar/2026");
});

test("dois meses seguidos são ligados por 'e'", () => {
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

test("um mês abatido no meio separa os trechos com ponto e vírgula", () => {
  // O exemplo do pedido: janeiro a março pendentes, abril abatido, maio e
  // junho pendentes.
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
});

test("cada trecho segue a própria regra, inclusive o de um mês só", () => {
  assert.equal(
    formatMonthsSpan([
      "2026-01-01",
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
      "2026-07-01",
    ]),
    "Jan/2026; Mar/2026 até Mai/2026; Jul/2026",
  );

  // Dois meses soltos não formam um trecho de dois: entre eles há meses que
  // não entram no total.
  assert.equal(formatMonthsSpan(["2026-01-01", "2026-05-01"]), "Jan/2026; Mai/2026");
});

test("a virada de ano conta como mês seguido", () => {
  assert.equal(
    formatMonthsSpan(["2025-11-01", "2025-12-01", "2026-01-01"]),
    "Nov/2025 até Jan/2026",
  );
  assert.equal(formatMonthsSpan(["2025-12-01", "2026-01-01"]), "Dez/2025 e Jan/2026");
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

test("a descrição dos pendentes usa o conjunto de meses", () => {
  assert.equal(
    buildAbatementDescription({
      referenceMonths: ["2026-01-01", "2026-02-01"],
    }),
    "Doações NFP - Jan/2026 e Fev/2026",
  );

  // O nome continua entrando só quando o grupo tem auxiliar.
  assert.equal(
    buildAbatementDescription({
      donorName: "JOAO AUXILIAR",
      referenceMonths: ["2026-01-01", "2026-02-01", "2026-03-01"],
      groupHasAuxiliaries: true,
    }),
    "Doações NFP - JOAO AUXILIAR - Jan/2026 até Mar/2026",
  );

  assert.equal(
    buildAbatementDescription({
      referenceMonths: [
        "2026-01-01",
        "2026-02-01",
        "2026-03-01",
        "2026-05-01",
        "2026-06-01",
      ],
    }),
    "Doações NFP - Jan/2026 até Mar/2026; Mai/2026 e Jun/2026",
  );

  // Com a lista presente, o mês avulso é ignorado.
  assert.equal(
    buildAbatementDescription({
      referenceMonth: "2026-06-01",
      referenceMonths: ["2026-01-01"],
    }),
    "Doações NFP - Jan/2026",
  );
});
