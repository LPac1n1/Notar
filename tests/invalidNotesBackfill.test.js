import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestConnection } from "./helpers/duckdbHelper.js";
import { runMigrations } from "../src/services/db/migrations.js";
import {
  BACKFILL_CPF_INVALID_NOTES_SQL,
  BACKFILL_SUMMARY_INVALID_NOTES_SQL,
} from "../src/services/import/reconcileSql.js";

/**
 * A contagem de notas inválidas é refeita a partir das notas.
 *
 * Ela não viajava no arquivo da nuvem e voltava zerada a cada abertura. As
 * notas, com `is_valid`, sempre viajaram — é delas que o número sai de volta.
 *
 * Cenário: importação de abril com as notas gravadas, e uma de janeiro
 * anterior às notas por linha (só o resumo por CPF existe).
 */

async function seed(conn) {
  await conn.query(`
    INSERT INTO imports (id, reference_month, file_name, value_per_note, status)
    VALUES
      ('imp-abr', DATE '2026-04-01', 'abril.csv', 1, 'processed'),
      ('imp-jan', DATE '2026-01-01', 'janeiro.csv', 1, 'processed')
  `);
  await conn.query(`
    INSERT INTO donors (id, name, cpf, donor_type, is_active)
    VALUES ('d-ana', 'ANA', '11111111111', 'holder', TRUE)
  `);
  await conn.query(`
    INSERT INTO donor_cpf_links (id, donor_id, name, cpf, link_type, is_active)
    VALUES
      ('lnk-ana', 'd-ana', 'ANA', '11111111111', 'holder', TRUE),
      ('lnk-ana-2', 'd-ana', 'ANA 2', '22222222222', 'auxiliary', TRUE)
  `);

  // Como o banco fica depois de abrir pela nuvem: contagem de inválidas zerada.
  await conn.query(`
    INSERT INTO import_cpf_summary (
      id, import_id, reference_month, cpf, notes_count, invalid_notes_count,
      matched_donor_id, matched_source_id, is_registered_donor
    )
    VALUES
      ('ics-1', 'imp-abr', DATE '2026-04-01', '11111111111', 3, 0, 'd-ana', 'lnk-ana', TRUE),
      ('ics-2', 'imp-abr', DATE '2026-04-01', '22222222222', 1, NULL, 'd-ana', 'lnk-ana-2', TRUE),
      ('ics-3', 'imp-abr', DATE '2026-04-01', '33333333333', 5, 0, NULL, NULL, FALSE),
      ('ics-4', 'imp-jan', DATE '2026-01-01', '11111111111', 2, 7, 'd-ana', 'lnk-ana', TRUE)
  `);
  await conn.query(`
    INSERT INTO monthly_donor_summary (
      id, import_id, donor_id, reference_month, cpf, donor_name,
      notes_count, invalid_notes_count, value_per_note, abatement_amount, abatement_status
    )
    VALUES
      ('mds-abr', 'imp-abr', 'd-ana', DATE '2026-04-01', '11111111111', 'ANA', 4, 0, 1, 4, 'applied'),
      ('mds-jan', 'imp-jan', 'd-ana', DATE '2026-01-01', '11111111111', 'ANA', 2, 7, 1, 2, 'applied')
  `);

  // Abril: CPF 111 com 3 válidas e 2 inválidas; CPF 222 com 1 válida e 1
  // inválida; CPF 333 só com válidas.
  const notes = [
    ["11111111111", true],
    ["11111111111", true],
    ["11111111111", true],
    ["11111111111", false],
    ["11111111111", false],
    ["22222222222", true],
    ["22222222222", false],
    ["33333333333", true],
  ];
  let index = 0;
  for (const [cpf, valid] of notes) {
    index += 1;
    await conn.query(`
      INSERT INTO donation_notes (id, import_id, cpf, reference_month, numero_nota, is_valid)
      VALUES ('n-${index}', 'imp-abr', '${cpf}', DATE '2026-04-01', '${index}', ${valid ? "TRUE" : "FALSE"})
    `);
  }
}

async function counts(conn) {
  const read = async (sql) =>
    Object.fromEntries(
      (await conn.query(sql))
        .toArray()
        .map((row) => row.toJSON())
        .map((row) => [row.id, row.n === null ? null : Number(row.n)]),
    );

  return {
    cpf: await read("SELECT id, invalid_notes_count AS n FROM import_cpf_summary"),
    summary: await read("SELECT id, invalid_notes_count AS n FROM monthly_donor_summary"),
  };
}

async function backfill(conn) {
  await conn.query(BACKFILL_CPF_INVALID_NOTES_SQL);
  await conn.query(BACKFILL_SUMMARY_INVALID_NOTES_SQL);
}

test("a contagem de inválidas volta, por CPF e por doador, a partir das notas", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seed(conn);
    await backfill(conn);

    assert.deepEqual(await counts(conn), {
      cpf: {
        "ics-1": 2,
        "ics-2": 1,
        // Sem nota inválida: fica como estava.
        "ics-3": 0,
        // Importação sem nota gravada: não há de onde tirar o número, então
        // o que estava gravado é preservado.
        "ics-4": 7,
      },
      // O resumo do doador soma os dois CPFs dele: 2 + 1.
      summary: { "mds-abr": 3, "mds-jan": 7 },
    });
  } finally {
    conn.close();
  }
});

test("rodar de novo não altera nada, e o status de abatimento não é tocado", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seed(conn);
    await backfill(conn);
    const before = await counts(conn);

    await backfill(conn);
    await backfill(conn);

    assert.deepEqual(await counts(conn), before);
    const statuses = (
      await conn.query("SELECT abatement_status AS s FROM monthly_donor_summary")
    )
      .toArray()
      .map((row) => row.toJSON().s);
    assert.deepEqual(statuses, ["applied", "applied"]);
  } finally {
    conn.close();
  }
});
