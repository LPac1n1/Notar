import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestConnection } from "./helpers/duckdbHelper.js";
import { runMigrations } from "../src/services/db/migrations.js";
import {
  CREDIT_RECONCILE_STATEMENTS,
  CREDIT_RECONCILE_STEPS,
} from "../src/services/reconciliation/creditReconcileSql.js";

/**
 * Conciliação doações × créditos, nota a nota.
 *
 * Os testes de `migrations.test.js` conferem CONTAGENS por status. Aqui o
 * resultado é conferido NOTA A NOTA — qual nota caiu em qual status e com
 * quem foi pareada —, porque é isso que precisa continuar igual quando o SQL
 * for reescrito para ficar mais rápido: duas versões podem dar as mesmas
 * contagens pareando notas diferentes.
 */

// (id, cnpj, número, valor, válida?)
const DONATIONS = [
  ["d-match", "11111111000111", "1", 10.0, true],
  ["d-div", "22222222000122", "2", 20.0, true],
  // Mesma chave, valores diferentes.
  ["d-dup1", "33333333000133", "3", 30.0, true],
  ["d-dup2", "33333333000133", "3", 35.0, true],
  // Uma doação só; a repetição está do lado do crédito.
  ["d-single", "44444444000144", "4", 40.0, true],
  // Repetida dos dois lados, linhas idênticas.
  ["d-both1", "55555555000155", "5", 50.0, true],
  ["d-both2", "55555555000155", "5", 50.0, true],
  ["d-orphan", "66666666000166", "6", 60.0, true],
  // Inválida com a MESMA chave de uma nota conciliada: não pode contar
  // como repetição nem aparecer em lugar nenhum.
  ["d-invalid", "11111111000111", "1", 10.0, false],
  // Chave incompleta: sem CNPJ (duas com a mesma chave) e sem número.
  ["d-nocnpj1", "", "8", 80.0, true],
  ["d-nocnpj2", "", "8", 80.0, true],
  ["d-nonum", "99999999000199", "", 90.0, true],
];

const CREDITS = [
  ["c-match", "11111111000111", "1", 10.0, true],
  ["c-div", "22222222000122", "2", 25.0, true],
  // Mesmo valor da doação, mas inválido: não pode virar o par dela.
  ["c-invalid", "22222222000122", "2", 20.0, false],
  ["c-dup-single", "33333333000133", "3", 30.0, true],
  ["c-dc1", "44444444000144", "4", 40.0, true],
  ["c-dc2", "44444444000144", "4", 45.0, true],
  ["c-both1", "55555555000155", "5", 50.0, true],
  ["c-both2", "55555555000155", "5", 50.0, true],
  ["c-orphan", "77777777000177", "7", 70.0, true],
  // Mesma chave incompleta e mesmo valor das doações sem CNPJ.
  ["c-nocnpj", "", "8", 80.0, true],
];

const sqlText = (value) => `'${value}'`;
const cents = (value) => Math.round(value * 100);

async function seed(conn) {
  await conn.query(`
    INSERT INTO donation_notes (
      id, import_id, cpf, numero_nota, valor_nota, cnpj_estabelecimento,
      is_valid, match_key, valor_cents
    )
    VALUES ${DONATIONS.map(
      ([id, cnpj, numero, valor, valid]) =>
        `(${sqlText(id)}, 'imp-1', '11111111111', ${sqlText(numero)}, ${valor},
          ${sqlText(cnpj)}, ${valid ? "TRUE" : "FALSE"},
          ${sqlText(`${cnpj}|${numero}`)}, ${cents(valor)})`,
    ).join(",\n")}
  `);
  await conn.query(`
    INSERT INTO credit_notes (
      id, credit_import_id, cnpj_estabelecimento, numero_nota, valor_nf,
      credito, situacao, is_valid, match_key, valor_cents
    )
    VALUES ${CREDITS.map(
      ([id, cnpj, numero, valor, valid]) =>
        `(${sqlText(id)}, 'ci-1', ${sqlText(cnpj)}, ${sqlText(numero)}, ${valor},
          0.30, 'Calculado', ${valid ? "TRUE" : "FALSE"},
          ${sqlText(`${cnpj}|${numero}`)}, ${cents(valor)})`,
    ).join(",\n")}
  `);
}

async function reconcile(conn) {
  for (const statement of CREDIT_RECONCILE_STATEMENTS) {
    await conn.query(statement);
  }
}

/** Uma linha de texto por registro, ordenada: `status doação crédito`. */
async function readOutcome(conn) {
  const rows = (
    await conn.query(`
      SELECT
        match_status,
        coalesce(donation_note_id, '-') AS donation_id,
        coalesce(credit_note_id, '-') AS credit_id
      FROM credit_reconciliation
    `)
  ).toArray();

  return rows
    .map((row) => `${row.match_status} ${row.donation_id} ${row.credit_id}`)
    .sort();
}

const EXPECTED_OUTCOME = [
  "credit_only - c-dup-single",
  "credit_only - c-nocnpj",
  "credit_only - c-orphan",
  "divergent d-div c-div",
  "donation_only d-nocnpj1 -",
  "donation_only d-nocnpj2 -",
  "donation_only d-nonum -",
  "donation_only d-orphan -",
  "donation_only d-single -",
  "duplicate_credit - c-both1",
  "duplicate_credit - c-both2",
  "duplicate_credit - c-dc1",
  "duplicate_credit - c-dc2",
  "duplicate_donation d-both1 -",
  "duplicate_donation d-both2 -",
  "duplicate_donation d-dup1 -",
  "duplicate_donation d-dup2 -",
  "matched d-match c-match",
].sort();

test("conciliação: cada nota cai no status esperado, com o par esperado", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seed(conn);
    await reconcile(conn);

    assert.deepEqual(await readOutcome(conn), EXPECTED_OUTCOME);
  } finally {
    conn.close();
  }
});

test("conciliação: toda nota válida aparece exatamente uma vez; inválida, nenhuma", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seed(conn);
    await reconcile(conn);

    const appearances = (
      await conn.query(`
        SELECT 'doacao' AS lado, donation_notes.id, donation_notes.is_valid,
          (SELECT count(*) FROM credit_reconciliation
            WHERE credit_reconciliation.donation_note_id = donation_notes.id) AS vezes
        FROM donation_notes
        UNION ALL
        SELECT 'credito', credit_notes.id, credit_notes.is_valid,
          (SELECT count(*) FROM credit_reconciliation
            WHERE credit_reconciliation.credit_note_id = credit_notes.id)
        FROM credit_notes
      `)
    ).toArray();

    assert.equal(appearances.length, DONATIONS.length + CREDITS.length);
    for (const row of appearances) {
      assert.equal(
        Number(row.vezes),
        row.is_valid ? 1 : 0,
        `${row.lado} ${row.id} apareceu ${row.vezes} vez(es)`,
      );
    }
  } finally {
    conn.close();
  }
});

test("conciliação: rodar de novo produz o mesmo resultado", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seed(conn);
    await reconcile(conn);
    const first = await readOutcome(conn);
    await reconcile(conn);

    assert.deepEqual(await readOutcome(conn), first);
  } finally {
    conn.close();
  }
});

test("conciliação: os passos saem na ordem que define a regra", () => {
  assert.deepEqual(
    CREDIT_RECONCILE_STEPS.map((step) => step.status),
    [
      "duplicate_donation",
      "duplicate_credit",
      "matched",
      "divergent",
      "credit_only",
      "donation_only",
    ],
  );
  // A primeira instrução limpa a tabela; as demais são os passos.
  assert.match(CREDIT_RECONCILE_STATEMENTS[0], /DELETE FROM credit_reconciliation/);
  assert.equal(
    CREDIT_RECONCILE_STATEMENTS.length,
    CREDIT_RECONCILE_STEPS.length + 1,
  );
});
