import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestConnection } from "./helpers/duckdbHelper.js";
import { runMigrations } from "../src/services/db/migrations.js";
import {
  ASSIGNMENT_OPEN_END,
  ASSIGNMENT_OPEN_START,
  DEFAULT_PROJECT_ID,
} from "../src/services/project/projectAssignmentSql.js";
import {
  buildMonthBlockPendingListSql,
  buildMonthBlockSummarySql,
} from "../src/services/dashboard/monthBlockSql.js";
import { buildMonthlyTrendSql } from "../src/services/dashboard/monthlyTrendSql.js";
import { buildTopDonorsQuery } from "../src/services/dashboard/topDonorsSql.js";
import {
  buildAbatementSheetSql,
  buildMonthsAbatementSheetSql,
  buildPendingAbatementSheetSql,
} from "../src/services/monthly/abatementSheetSql.js";
import { RECONCILE_MATCHED_DONORS_SQL } from "../src/services/import/reconcileSql.js";

/**
 * Doador inativo não entra na apuração — e volta inteiro ao ser reativado.
 *
 * A lista da Gestão Mensal sempre escondeu o doador inativo. As outras telas
 * não: ele sumia da lista e continuava no painel, na evolução mensal, no
 * ranking e na planilha que vai para o sistema de baixa. Cada teste abaixo é
 * uma dessas saídas, conferida nos dois estados.
 *
 * "Reativar" aqui é só virar `is_active`: nada é apagado quando o doador é
 * desativado, então não há o que reconstruir — é isso que os testes provam.
 */

const MORADIA = DEFAULT_PROJECT_ID;
const MAY = "2026-05-01";
const APRIL = "2026-04-01";

const ATIVO = { id: "d-ativo", cpf: "11111111111" };
const INATIVO = { id: "d-inativo", cpf: "22222222222" };

async function seed(conn) {
  await conn.query(`
    INSERT INTO imports (id, reference_month, file_name, value_per_note, status)
    VALUES
      ('imp-may', DATE '${MAY}', 'maio.csv', 1, 'processed'),
      ('imp-apr', DATE '${APRIL}', 'abril.csv', 1, 'processed')
  `);

  for (const [donor, active] of [
    [ATIVO, true],
    [INATIVO, false],
  ]) {
    await conn.query(`
      INSERT INTO donors (id, name, cpf, demand, donor_type, donation_start_date, is_active)
      VALUES ('${donor.id}', 'DOADOR ${donor.id}', '${donor.cpf}', 'A', 'holder',
              DATE '2025-01-01', ${active ? "TRUE" : "FALSE"})
    `);
    await conn.query(`
      INSERT INTO donor_cpf_links (id, donor_id, name, cpf, link_type, is_active)
      VALUES ('lnk-${donor.id}', '${donor.id}', 'DOADOR ${donor.id}', '${donor.cpf}', 'holder', TRUE)
    `);
    await conn.query(`
      INSERT INTO donor_project_assignments (id, donor_id, project_id, valid_from, valid_to, reason)
      VALUES ('dpa-${donor.id}', '${donor.id}', '${MORADIA}',
              DATE '${ASSIGNMENT_OPEN_START}', DATE '${ASSIGNMENT_OPEN_END}', 'inicial')
    `);
  }

  // Maio: o ativo com 3 notas, o inativo com 9 — as duas linhas pendentes.
  // Abril: só o inativo, 2 notas, JÁ ABATIDO.
  const summaries = [
    ["mds-a-may", "imp-may", ATIVO, MAY, 3, "pending"],
    ["mds-i-may", "imp-may", INATIVO, MAY, 9, "pending"],
    ["mds-i-apr", "imp-apr", INATIVO, APRIL, 2, "applied"],
  ];
  for (const [id, importId, donor, month, notes, status] of summaries) {
    await conn.query(`
      INSERT INTO monthly_donor_summary (
        id, import_id, donor_id, reference_month, cpf, donor_name, demand,
        notes_count, value_per_note, abatement_amount, abatement_status
      )
      VALUES ('${id}', '${importId}', '${donor.id}', DATE '${month}', '${donor.cpf}',
              'DOADOR ${donor.id}', 'A', ${notes}, 1, ${notes}, '${status}')
    `);
    await conn.query(`
      INSERT INTO import_cpf_summary (
        id, import_id, reference_month, cpf, notes_count,
        matched_donor_id, matched_source_id, is_registered_donor
      )
      VALUES ('ics-${id}', '${importId}', DATE '${month}', '${donor.cpf}', ${notes},
              '${donor.id}', 'lnk-${donor.id}', TRUE)
    `);
  }
}

async function run(conn, sql, params = []) {
  const statement = await conn.prepare(sql);
  try {
    const result = await statement.query(...params);
    return result.toArray().map((row) => row.toJSON());
  } finally {
    await statement.close();
  }
}

const reactivate = (conn) =>
  conn.query(`UPDATE donors SET is_active = TRUE WHERE id = '${INATIVO.id}'`);

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

test("painel: o mês não conta o doador inativo, e conta de novo ao reativar", async () => {
  await withSeededDatabase(async (conn) => {
    const [before] = await run(conn, buildMonthBlockSummarySql(MORADIA), ["imp-may"]);
    assert.equal(Number(before.pending_count), 1);
    assert.equal(Number(before.donor_count), 1);
    assert.equal(Number(before.total_notes), 3);
    assert.equal(Number(before.total_abatement), 3);

    const pendingBefore = await run(conn, buildMonthBlockPendingListSql(MORADIA), ["imp-may"]);
    assert.deepEqual(pendingBefore.map((row) => row.donor_id), [ATIVO.id]);

    await reactivate(conn);

    const [after] = await run(conn, buildMonthBlockSummarySql(MORADIA), ["imp-may"]);
    assert.equal(Number(after.pending_count), 2);
    assert.equal(Number(after.donor_count), 2);
    assert.equal(Number(after.total_notes), 3 + 9);
    assert.equal(Number(after.total_abatement), 3 + 9);
  });
});

test("evolução mensal: mês em que só o inativo doou some, e volta ao reativar", async () => {
  await withSeededDatabase(async (conn) => {
    const notesByMonth = async () =>
      Object.fromEntries(
        (await run(conn, buildMonthlyTrendSql(MORADIA))).map((row) => [
          row.reference_month,
          Number(row.total_notes),
        ]),
      );

    assert.deepEqual(await notesByMonth(), { [MAY]: 3 });

    await reactivate(conn);

    assert.deepEqual(await notesByMonth(), { [MAY]: 12, [APRIL]: 2 });
  });
});

test("ranking: doador inativo não aparece entre os maiores", async () => {
  await withSeededDatabase(async (conn) => {
    const ranking = async () => {
      const { sql, params } = buildTopDonorsQuery({ projectId: MORADIA, limit: 10 });
      return (await run(conn, sql, params)).map((row) => row.donor_id);
    };

    assert.deepEqual(await ranking(), [ATIVO.id]);

    await reactivate(conn);

    // O reativado tem 11 notas somadas; passa à frente.
    assert.deepEqual(await ranking(), [INATIVO.id, ATIVO.id]);
  });
});

test("planilha de abatimento: nenhuma das três leva CPF de doador inativo", async () => {
  await withSeededDatabase(async (conn) => {
    const cpfs = (rows) => rows.map((row) => String(row.cpf)).sort();
    const sheets = async () => ({
      doMes: cpfs(await run(conn, buildAbatementSheetSql(MORADIA), [MAY])),
      dosMeses: cpfs(
        await run(conn, buildMonthsAbatementSheetSql(MORADIA, 2), [APRIL, MAY]),
      ),
      pendentes: cpfs(await run(conn, buildPendingAbatementSheetSql(MORADIA))),
    });

    assert.deepEqual(await sheets(), {
      doMes: [ATIVO.cpf],
      dosMeses: [ATIVO.cpf],
      pendentes: [ATIVO.cpf],
    });

    await reactivate(conn);

    assert.deepEqual(await sheets(), {
      doMes: [ATIVO.cpf, INATIVO.cpf],
      dosMeses: [ATIVO.cpf, INATIVO.cpf],
      pendentes: [ATIVO.cpf, INATIVO.cpf],
    });
  });
});

test("reativar não devolve como pendente o mês que já tinha sido abatido", async () => {
  await withSeededDatabase(async (conn) => {
    await reactivate(conn);

    // Abril estava abatido antes da desativação. A planilha de pendentes do
    // reativado traz só maio (9 notas) — abril não volta para ser abatido de
    // novo.
    const rows = await run(conn, buildPendingAbatementSheetSql(MORADIA));
    const reativado = rows.find((row) => String(row.cpf) === INATIVO.cpf);

    assert.equal(Number(reativado.notes_count), 9);
    assert.equal(String(reativado.reference_months), MAY);
  });
});

test("reconciliar uma importação mantém a linha do doador inativo", async () => {
  await withSeededDatabase(async (conn) => {
    // É o que preserva o status de abatimento dele: se a consulta deixasse o
    // inativo de fora, a reconciliação apagaria a linha, e a reativação a
    // recriaria como pendente.
    const rows = await run(conn, RECONCILE_MATCHED_DONORS_SQL, ["imp-may"]);

    assert.deepEqual(
      rows.map((row) => [row.donor_id, Number(row.notes_count)]).sort(),
      [
        [ATIVO.id, 3],
        [INATIVO.id, 9],
      ],
    );
  });
});

test("CPF desvinculado continua fora do resumo, com o doador ativo ou não", async () => {
  await withSeededDatabase(async (conn) => {
    await conn.query(
      `UPDATE donor_cpf_links SET is_active = FALSE WHERE donor_id = '${ATIVO.id}'`,
    );

    const rows = await run(conn, RECONCILE_MATCHED_DONORS_SQL, ["imp-may"]);
    assert.deepEqual(rows.map((row) => row.donor_id), [INATIVO.id]);
  });
});
