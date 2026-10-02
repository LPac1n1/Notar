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
  buildMonthBlockComparisonSql,
  buildMonthBlockDemandsSql,
  buildMonthBlockPendingListSql,
  buildMonthBlockSummarySql,
} from "../src/services/dashboard/monthBlockSql.js";

/**
 * Bloco mensal do Dashboard de um projeto.
 *
 * A regra: o painel diz o mesmo que a Gestão Mensal do projeto. Cada doador
 * abaixo existe para um jeito diferente de o painel já ter discordado dela.
 */

const MORADIA = DEFAULT_PROJECT_ID;
const NAVE = "prj-nave";
const MAY = "2026-05-01";
const APRIL = "2026-04-01";

// id, demanda, notas em maio, status em maio, e por onde o doador passou.
const DONORS = [
  // Pendente de verdade.
  { id: "m-pend", demand: "A", notes: 3, status: "pending", stays: MORADIA },
  { id: "m-applied", demand: "A", notes: 2, status: "applied", stays: MORADIA, start: MAY },
  // Maio coberto por um acumulado lançado em junho: "Via acumulado".
  { id: "m-covered", demand: "B", notes: 4, status: "pending", stays: MORADIA },
  // Sem nota em maio.
  { id: "m-zero", demand: "B", notes: 0, status: "pending", stays: MORADIA },
  // De outro projeto, que nem tem apuração mensal.
  { id: "n-pend", demand: "", notes: 5, status: "pending", stays: NAVE },
  // Em maio era do NAVE; veio para Moradia em junho.
  { id: "moved-in", demand: "A", notes: 6, status: "pending", from: NAVE, to: MORADIA },
  // Em maio era de Moradia; foi para o NAVE em junho.
  { id: "moved-out", demand: "", notes: 7, status: "pending", from: MORADIA, to: NAVE },
];

async function seed(conn) {
  await conn.query(`
    INSERT INTO projects (id, name, slug, modules, is_active)
    VALUES ('${NAVE}', 'NAVE', 'nave', '{"monthly":false}', TRUE)
  `);
  await conn.query(`
    INSERT INTO imports (id, reference_month, file_name, value_per_note, status)
    VALUES
      ('imp-may', DATE '${MAY}', 'maio.csv', 1, 'processed'),
      ('imp-apr', DATE '${APRIL}', 'abril.csv', 1, 'processed')
  `);

  for (const [index, donor] of DONORS.entries()) {
    const cpf = String(10000000000 + index);
    await conn.query(`
      INSERT INTO donors (id, name, cpf, demand, donor_type, donation_start_date, is_active)
      VALUES ('${donor.id}', 'DOADOR ${donor.id}', '${cpf}', '${donor.demand}', 'holder',
              ${donor.start ? `DATE '${donor.start}'` : "DATE '2025-01-01'"}, TRUE)
    `);
    await conn.query(`
      INSERT INTO donor_cpf_links (id, donor_id, name, cpf, link_type, is_active)
      VALUES ('lnk-${donor.id}', '${donor.id}', 'DOADOR ${donor.id}', '${cpf}', 'holder', TRUE)
    `);

    if (donor.stays) {
      await conn.query(`
        INSERT INTO donor_project_assignments (id, donor_id, project_id, valid_from, valid_to, reason)
        VALUES ('dpa-${donor.id}', '${donor.id}', '${donor.stays}',
                DATE '${ASSIGNMENT_OPEN_START}', DATE '${ASSIGNMENT_OPEN_END}', 'inicial')
      `);
    } else {
      // Vigência fechada até maio, e a nova a partir de junho.
      await conn.query(`
        INSERT INTO donor_project_assignments (id, donor_id, project_id, valid_from, valid_to, reason)
        VALUES
          ('dpa-${donor.id}-1', '${donor.id}', '${donor.from}',
           DATE '${ASSIGNMENT_OPEN_START}', DATE '${MAY}', 'inicial'),
          ('dpa-${donor.id}-2', '${donor.id}', '${donor.to}',
           DATE '2026-06-01', DATE '${ASSIGNMENT_OPEN_END}', 'transferencia')
      `);
    }

    await conn.query(`
      INSERT INTO monthly_donor_summary (
        id, import_id, donor_id, reference_month, cpf, donor_name, demand,
        notes_count, value_per_note, abatement_amount, abatement_status
      )
      VALUES ('mds-${donor.id}', 'imp-may', '${donor.id}', DATE '${MAY}', '${cpf}',
              'DOADOR ${donor.id}', '${donor.demand}', ${donor.notes}, 1,
              ${donor.notes}, '${donor.status}')
    `);

    if (donor.notes > 0) {
      await conn.query(`
        INSERT INTO import_cpf_summary (
          id, import_id, reference_month, cpf, notes_count,
          matched_donor_id, matched_source_id, is_registered_donor
        )
        VALUES ('ics-${donor.id}', 'imp-may', DATE '${MAY}', '${cpf}', ${donor.notes},
                '${donor.id}', 'lnk-${donor.id}', TRUE)
      `);
    }
  }

  // Um CPF da planilha sem cadastro nenhum.
  await conn.query(`
    INSERT INTO import_cpf_summary (
      id, import_id, reference_month, cpf, notes_count, is_registered_donor
    )
    VALUES ('ics-avulso', 'imp-may', DATE '${MAY}', '99999999999', 9, FALSE)
  `);

  // O acumulado que cobre maio de "m-covered", lançado em junho.
  await conn.query(`
    INSERT INTO abatement_adjustments (
      id, donor_id, reference_month, range_start_month, range_end_month,
      notes_count, abatement_amount, abatement_status
    )
    VALUES ('adj-1', 'm-covered', DATE '2026-06-01', DATE '${APRIL}', DATE '${MAY}',
            8, 8, 'pending')
  `);

  // Abril, para a comparação com o mês anterior.
  await conn.query(`
    INSERT INTO monthly_donor_summary (
      id, import_id, donor_id, reference_month, cpf, donor_name, demand,
      notes_count, value_per_note, abatement_amount, abatement_status
    )
    VALUES ('mds-apr', 'imp-apr', 'm-pend', DATE '${APRIL}', '10000000000',
            'DOADOR m-pend', 'A', 1, 1, 1, 'applied')
  `);
  await conn.query(`
    INSERT INTO import_cpf_summary (
      id, import_id, reference_month, cpf, notes_count,
      matched_donor_id, matched_source_id, is_registered_donor
    )
    VALUES ('ics-apr', 'imp-apr', DATE '${APRIL}', '10000000000', 1,
            'm-pend', 'lnk-m-pend', TRUE)
  `);
}

async function run(conn, sql, params) {
  const statement = await conn.prepare(sql);
  try {
    const result = await statement.query(...params);
    return result.toArray().map((row) => row.toJSON());
  } finally {
    await statement.close();
  }
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

test("painel de Moradia: só conta o que a Gestão Mensal de Moradia mostraria", async () => {
  await withSeededDatabase(async (conn) => {
    const [row] = await run(conn, buildMonthBlockSummarySql(MORADIA), ["imp-may"]);

    // m-pend e moved-out. Ficam de fora: coberto por acumulado, sem nota,
    // doador do NAVE e quem só chegou a Moradia depois de maio.
    assert.equal(Number(row.pending_count), 2);
    assert.equal(Number(row.applied_count), 1);
    // m-pend, m-applied, m-covered, m-zero e moved-out.
    assert.equal(Number(row.donor_count), 5);
    assert.equal(Number(row.total_notes), 3 + 2 + 4 + 7);
    assert.equal(Number(row.total_abatement), 3 + 2 + 4 + 0 + 7);
    // CPF sem cadastro é da planilha, não de um projeto.
    assert.equal(Number(row.unregistered_cpf_count), 1);
  });
});

test("painel do outro projeto: fica com os próprios doadores, e só eles", async () => {
  await withSeededDatabase(async (conn) => {
    const [row] = await run(conn, buildMonthBlockSummarySql(NAVE), ["imp-may"]);

    // n-pend e moved-in (que em maio ainda era do NAVE).
    assert.equal(Number(row.pending_count), 2);
    assert.equal(Number(row.donor_count), 2);
    assert.equal(Number(row.total_notes), 5 + 6);
  });
});

test("a lista de pendentes traz as mesmas pessoas que o contador conta", async () => {
  await withSeededDatabase(async (conn) => {
    const moradia = await run(conn, buildMonthBlockPendingListSql(MORADIA), ["imp-may"]);
    const nave = await run(conn, buildMonthBlockPendingListSql(NAVE), ["imp-may"]);

    // Maior valor primeiro.
    assert.deepEqual(moradia.map((item) => item.donor_id), ["moved-out", "m-pend"]);
    assert.deepEqual(nave.map((item) => item.donor_id), ["moved-in", "n-pend"]);
    assert.equal(moradia[0].demand, "Sem demanda");
  });
});

test("a quebra por demanda usa o mesmo recorte e a mesma definição de pendente", async () => {
  await withSeededDatabase(async (conn) => {
    const rows = await run(conn, buildMonthBlockDemandsSql(MORADIA), ["imp-may"]);
    const byDemand = Object.fromEntries(
      rows.map((row) => [
        row.demand,
        {
          donors: Number(row.donor_count),
          pending: Number(row.pending_count),
          applied: Number(row.applied_count),
        },
      ]),
    );

    assert.deepEqual(byDemand, {
      // m-pend e m-applied; "moved-in" é da demanda A mas não era de Moradia.
      A: { donors: 2, pending: 1, applied: 1 },
      // m-covered e m-zero: nenhum dos dois é trabalho a fazer.
      B: { donors: 2, pending: 0, applied: 0 },
      "Sem demanda": { donors: 1, pending: 1, applied: 0 },
    });

    // A soma das demandas fecha com o total do bloco.
    const [summary] = await run(conn, buildMonthBlockSummarySql(MORADIA), ["imp-may"]);
    const pendingByDemand = rows.reduce((sum, row) => sum + Number(row.pending_count), 0);
    assert.equal(pendingByDemand, Number(summary.pending_count));
  });
});

test("a comparação com o mês anterior respeita o projeto", async () => {
  await withSeededDatabase(async (conn) => {
    const [moradia] = await run(conn, buildMonthBlockComparisonSql(MORADIA), [
      "imp-apr",
      "imp-apr",
      "imp-apr",
      MAY,
    ]);
    const [nave] = await run(conn, buildMonthBlockComparisonSql(NAVE), [
      "imp-apr",
      "imp-apr",
      "imp-apr",
      MAY,
    ]);

    assert.equal(Number(moradia.previous_notes), 1);
    assert.equal(Number(moradia.previous_abatement), 1);
    assert.equal(Number(moradia.previous_donors), 1);
    // m-applied começou em maio.
    assert.equal(Number(moradia.new_donors), 1);

    assert.equal(Number(nave.previous_notes), 0);
    assert.equal(Number(nave.previous_donors), 0);
  });
});
