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
 * quem foi pareada —, porque duas versões do SQL podem dar as mesmas
 * contagens pareando notas diferentes.
 *
 * A regra que estes casos fixam: CNPJ + número não identifica uma nota (o
 * mesmo número se repete em séries diferentes), então a REPETIÇÃO só existe
 * quando o valor também é igual. Notas de mesma chave e valores diferentes
 * são notas distintas, e cada uma procura o próprio par.
 */

// (id, cnpj, número, valor, válida?)
const DONATIONS = [
  ["d-match", "11111111000111", "1", 10.0, true],
  ["d-div", "22222222000122", "2", 20.0, true],
  // Mesma chave, valores diferentes: são duas notas. A de 30 tem crédito
  // correspondente; a de 35, não.
  ["d-dup1", "33333333000133", "3", 30.0, true],
  ["d-dup2", "33333333000133", "3", 35.0, true],
  // Uma doação só; do lado do crédito há duas notas com a chave dela.
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
  // Duas linhas iguais em chave E valor (repetidas de verdade) convivendo
  // com uma terceira nota da mesma chave, de outro valor, que tem par.
  ["d-tri1", "10101010000110", "9", 90.0, true],
  ["d-tri2", "10101010000110", "9", 90.0, true],
  ["d-tri3", "10101010000110", "9", 95.0, true],
  // Duas de cada lado sob a mesma chave, nenhum valor coincide: NÃO pode
  // virar "valor diferente" — seriam quatro pares para quatro notas.
  ["d-k1", "12121212000112", "10", 100.0, true],
  ["d-k2", "12121212000112", "10", 110.0, true],
  // Duas de cada lado, valores coincidem dois a dois: dois pares.
  ["d-l1", "13131313000113", "11", 100.0, true],
  ["d-l2", "13131313000113", "11", 200.0, true],
  // Uma doação contra dois créditos de outros valores: sem par.
  ["d-n", "14141414000114", "12", 10.0, true],
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
  ["c-tri", "10101010000110", "9", 90.0, true],
  ["c-tri3", "10101010000110", "9", 95.0, true],
  ["c-k1", "12121212000112", "10", 120.0, true],
  ["c-k2", "12121212000112", "10", 130.0, true],
  ["c-l1", "13131313000113", "11", 100.0, true],
  ["c-l2", "13131313000113", "11", 200.0, true],
  ["c-n1", "14141414000114", "12", 20.0, true],
  ["c-n2", "14141414000114", "12", 30.0, true],
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
  // Uma nota de cada lado, mesmo valor.
  "matched d-match c-match",
  // Uma nota de cada lado, valor diferente.
  "divergent d-div c-div",
  // Mesma chave, valores diferentes: cada nota procura o próprio par.
  "matched d-dup1 c-dup-single",
  "donation_only d-dup2 -",
  "matched d-single c-dc1",
  "credit_only - c-dc2",
  // Iguais em chave e valor, dos dois lados: ambíguas, ninguém pareia.
  "duplicate_donation d-both1 -",
  "duplicate_donation d-both2 -",
  "duplicate_credit - c-both1",
  "duplicate_credit - c-both2",
  // Repetidas só na doação: o crédito de mesmo valor fica sem par, mas a
  // nota de outro valor sob a mesma chave pareia normalmente.
  "duplicate_donation d-tri1 -",
  "duplicate_donation d-tri2 -",
  "credit_only - c-tri",
  "matched d-tri3 c-tri3",
  // Várias notas por lado e nenhum valor coincide: todas sem par, e
  // nenhuma linha de "valor diferente".
  "donation_only d-k1 -",
  "donation_only d-k2 -",
  "credit_only - c-k1",
  "credit_only - c-k2",
  "matched d-l1 c-l1",
  "matched d-l2 c-l2",
  "donation_only d-n -",
  "credit_only - c-n1",
  "credit_only - c-n2",
  // Sem contraparte nenhuma.
  "donation_only d-orphan -",
  "credit_only - c-orphan",
  // Chave incompleta nunca pareia, mesmo coincidindo em tudo.
  "donation_only d-nocnpj1 -",
  "donation_only d-nocnpj2 -",
  "donation_only d-nonum -",
  "credit_only - c-nocnpj",
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
