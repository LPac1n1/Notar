import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestConnection } from "./helpers/duckdbHelper.js";
import { runMigrations } from "../src/services/db/migrations.js";
import { INSERT_MISSING_MONTHLY_SUMMARIES_SQL } from "../src/services/import/reconcileSql.js";

/**
 * O resumo mensal que falta é recriado — e só ele.
 *
 * Uma versão antiga da reconciliação apagava o resumo de quem estava
 * inativo. A normalização devolve essas linhas. O risco dela é o contrário
 * do defeito: mexer no que já existe. Uma linha que volta como pendente
 * depois de abatida faz a mesma doação ser abatida duas vezes; por isso
 * metade dos testes é sobre o que NÃO pode mudar.
 */

const APRIL = "2026-04-01";
const MAY = "2026-05-01";

async function seed(conn) {
  await conn.query(`
    INSERT INTO imports (id, reference_month, file_name, value_per_note, status)
    VALUES
      ('imp-apr', DATE '${APRIL}', 'abril.csv', 2, 'processed'),
      ('imp-may', DATE '${MAY}', 'maio.csv', 3, 'processed'),
      ('imp-erro', DATE '${MAY}', 'quebrada.csv', 3, 'error')
  `);
  await conn.query(`
    INSERT INTO donors (id, name, cpf, demand, donor_type, is_active)
    VALUES
      ('d-ana', 'ANA', '11111111111', 'A', 'holder', TRUE),
      ('d-bia', 'BIA', '22222222222', NULL, 'holder', FALSE)
  `);
  await conn.query(`
    INSERT INTO donor_cpf_links (id, donor_id, name, cpf, link_type, is_active)
    VALUES
      ('lnk-ana', 'd-ana', 'ANA', '11111111111', 'holder', TRUE),
      ('lnk-bia', 'd-bia', 'BIA', '22222222222', 'holder', TRUE),
      -- Segundo CPF da Bia (um auxiliar antigo): soma na linha dela.
      ('lnk-bia-2', 'd-bia', 'BIA 2', '33333333333', 'auxiliary', TRUE),
      -- CPF desvinculado: não é mais do doador.
      ('lnk-ana-velho', 'd-ana', 'ANA', '44444444444', 'holder', FALSE)
  `);

  const cpfRows = [
    ["ics-1", "imp-apr", APRIL, "11111111111", 5, 0, "d-ana", "lnk-ana"],
    ["ics-2", "imp-apr", APRIL, "22222222222", 4, 1, "d-bia", "lnk-bia"],
    ["ics-3", "imp-apr", APRIL, "33333333333", 6, 0, "d-bia", "lnk-bia-2"],
    ["ics-4", "imp-may", MAY, "22222222222", 7, 0, "d-bia", "lnk-bia"],
    ["ics-5", "imp-may", MAY, "44444444444", 9, 0, "d-ana", "lnk-ana-velho"],
    ["ics-6", "imp-erro", MAY, "11111111111", 8, 0, "d-ana", "lnk-ana"],
  ];
  for (const [id, importId, month, cpf, notes, invalid, donorId, linkId] of cpfRows) {
    await conn.query(`
      INSERT INTO import_cpf_summary (
        id, import_id, reference_month, cpf, notes_count, invalid_notes_count,
        matched_donor_id, matched_source_id, is_registered_donor
      )
      VALUES ('${id}', '${importId}', DATE '${month}', '${cpf}', ${notes}, ${invalid},
              '${donorId}', '${linkId}', TRUE)
    `);
  }

  // A Ana já tem o resumo de abril, ABATIDO, e com uma contagem que não bate
  // com a planilha (4, não 5): nada disso pode ser "corrigido" aqui.
  await conn.query(`
    INSERT INTO monthly_donor_summary (
      id, import_id, donor_id, reference_month, cpf, donor_name, demand,
      notes_count, value_per_note, abatement_amount, abatement_status,
      abatement_marked_at
    )
    VALUES ('mds-ana-apr', 'imp-apr', 'd-ana', DATE '${APRIL}', '11111111111', 'ANA', 'A',
            4, 2, 8, 'applied', TIMESTAMP '2026-05-10 09:00:00')
  `);
}

function rows(result) {
  return result.toArray().map((row) => row.toJSON());
}

async function summaries(conn) {
  return rows(
    await conn.query(`
      SELECT
        id, import_id, donor_id,
        strftime(reference_month, '%Y-%m-%d') AS reference_month,
        cpf, donor_name, demand,
        CAST(notes_count AS INTEGER) AS notes_count,
        CAST(coalesce(invalid_notes_count, 0) AS INTEGER) AS invalid_notes_count,
        value_per_note, abatement_amount, abatement_status,
        abatement_marked_at IS NOT NULL AS has_marked_at
      FROM monthly_donor_summary
      ORDER BY import_id, donor_id
    `),
  );
}

async function withSeededDatabase(callback) {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seed(conn);
    await callback(conn);
  } finally {
    conn.close();
  }
}

test("o resumo que falta é criado pendente, com as notas e o valor da planilha", async () => {
  await withSeededDatabase(async (conn) => {
    await conn.query(INSERT_MISSING_MONTHLY_SUMMARIES_SQL);

    const created = (await summaries(conn)).filter((row) => row.donor_id === "d-bia");

    assert.deepEqual(created, [
      {
        id: "imp-apr-d-bia",
        import_id: "imp-apr",
        donor_id: "d-bia",
        reference_month: APRIL,
        cpf: "22222222222",
        donor_name: "BIA",
        demand: "",
        // Os dois CPFs dela somam numa linha só: 4 + 6.
        notes_count: 10,
        invalid_notes_count: 1,
        value_per_note: 2,
        abatement_amount: 20,
        abatement_status: "pending",
        has_marked_at: false,
      },
      {
        id: "imp-may-d-bia",
        import_id: "imp-may",
        donor_id: "d-bia",
        reference_month: MAY,
        cpf: "22222222222",
        donor_name: "BIA",
        demand: "",
        notes_count: 7,
        invalid_notes_count: 0,
        value_per_note: 3,
        abatement_amount: 21,
        abatement_status: "pending",
        has_marked_at: false,
      },
    ]);
  });
});

test("o resumo que já existe não é tocado: nem o status, nem a contagem", async () => {
  await withSeededDatabase(async (conn) => {
    const [before] = await summaries(conn);
    await conn.query(INSERT_MISSING_MONTHLY_SUMMARIES_SQL);
    const after = (await summaries(conn)).filter((row) => row.donor_id === "d-ana");

    // Uma linha só da Ana, a mesma de antes — abatida, com as 4 notas dela.
    assert.deepEqual(after, [before]);
    assert.equal(before.abatement_status, "applied");
    assert.equal(before.notes_count, 4);
  });
});

test("CPF desvinculado e importação que não foi processada não geram resumo", async () => {
  await withSeededDatabase(async (conn) => {
    await conn.query(INSERT_MISSING_MONTHLY_SUMMARIES_SQL);

    const keys = (await summaries(conn)).map((row) => `${row.import_id}/${row.donor_id}`);

    // Ana em maio só aparece pelo CPF desvinculado; a importação com erro
    // não entra para ninguém.
    assert.deepEqual(keys, ["imp-apr/d-ana", "imp-apr/d-bia", "imp-may/d-bia"]);
  });
});

test("rodar de novo não cria nada, nem depois de o usuário abater a linha recriada", async () => {
  await withSeededDatabase(async (conn) => {
    await conn.query(INSERT_MISSING_MONTHLY_SUMMARIES_SQL);
    await conn.query(`
      UPDATE monthly_donor_summary
      SET abatement_status = 'applied', abatement_marked_at = CURRENT_TIMESTAMP
      WHERE id = 'imp-apr-d-bia'
    `);
    const before = await summaries(conn);

    await conn.query(INSERT_MISSING_MONTHLY_SUMMARIES_SQL);
    await conn.query(INSERT_MISSING_MONTHLY_SUMMARIES_SQL);

    assert.deepEqual(await summaries(conn), before);
    assert.equal(
      before.find((row) => row.id === "imp-apr-d-bia").abatement_status,
      "applied",
    );
  });
});
