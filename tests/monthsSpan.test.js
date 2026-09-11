import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMonthsSpan } from "../src/utils/date.js";
import { buildAbatementDescription } from "../src/services/monthly/abatementSheetDescription.js";

/**
 * O rótulo de meses da planilha de pendentes.
 *
 * Vai para a descrição que o sistema de baixa registra, então o erro que
 * importa não é de estética: "Jan/2026 até Abr/2026" para janeiro, março e
 * abril diria que fevereiro foi abatido, e ninguém o abateu.
 */

test("um mês sai sozinho", () => {
  assert.equal(formatMonthsSpan(["2026-03-01"]), "Mar/2026");
});

test("dois meses são ligados por 'e', seguidos ou não", () => {
  assert.equal(formatMonthsSpan(["2026-01-01", "2026-02-01"]), "Jan/2026 e Fev/2026");
  assert.equal(formatMonthsSpan(["2026-01-01", "2026-05-01"]), "Jan/2026 e Mai/2026");
});

test("três ou mais seguidos viram intervalo", () => {
  assert.equal(
    formatMonthsSpan(["2026-01-01", "2026-02-01", "2026-03-01"]),
    "Jan/2026 até Mar/2026",
  );
});

test("com um buraco no meio, nunca sai 'até'", () => {
  assert.equal(
    formatMonthsSpan(["2026-01-01", "2026-03-01", "2026-04-01"]),
    "Jan/2026, Mar/2026 e Abr/2026",
  );
});

test("a virada de ano conta como mês seguido", () => {
  assert.equal(
    formatMonthsSpan(["2025-11-01", "2025-12-01", "2026-01-01"]),
    "Nov/2025 até Jan/2026",
  );
});

test("o mesmo mês em anos diferentes não é seguido", () => {
  // Comparar só o número do mês acharia janeiro/2025 "colado" em fevereiro/2026.
  assert.equal(
    formatMonthsSpan(["2025-01-01", "2026-01-01", "2026-02-01"]),
    "Jan/2025, Jan/2026 e Fev/2026",
  );
});

test("ordem, repetição e formato da entrada não mudam o rótulo", () => {
  // A consulta devolve os meses agregados sem ordem garantida.
  assert.equal(
    formatMonthsSpan(["2026-03-01", "2026-01", "2026-02-01", "2026-01-01"]),
    "Jan/2026 até Mar/2026",
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

  // Com a lista presente, o mês avulso é ignorado.
  assert.equal(
    buildAbatementDescription({
      referenceMonth: "2026-06-01",
      referenceMonths: ["2026-01-01"],
    }),
    "Doações NFP - Jan/2026",
  );
});
