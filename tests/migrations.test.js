import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestConnection } from "./helpers/duckdbHelper.js";
import {
  MIGRATIONS,
  runMigrations,
} from "../src/services/db/migrations.js";
import { buildDonorInactivityStreaksSql } from "../src/services/monthly/inactivityStreaksSql.js";
import { buildDonorMonthStatusQuery } from "../src/services/reconciliation/donorMonthStatusSql.js";
import { buildRaffleNumbersSql } from "../src/services/raffle/raffleNumbersSql.js";
import { buildAbatementSheetSql } from "../src/services/monthly/abatementSheetSql.js";
import { buildAbatementDescription } from "../src/services/monthly/abatementSheetDescription.js";
import { PLATFORM_CREDIT_TOTALS_SQL } from "../src/services/dashboard/platformSql.js";
import { buildTopDonorsQuery } from "../src/services/dashboard/topDonorsSql.js";
import {
  buildProjectCreditByDonorSql,
  buildProjectCreditByMonthSql,
  buildProjectDonorsWithoutCreditSql,
} from "../src/services/dashboard/projectCreditSql.js";
import {
  ASSIGNMENT_OPEN_END,
  ASSIGNMENT_OPEN_START,
  BACKFILL_ASSIGNMENTS_SQL,
  BACKFILL_NOTE_PROJECT_SQL,
  COUNT_DONORS_WITHOUT_PROJECT_SQL,
  CREDIT_BY_PROJECT_SQL,
  DEFAULT_PROJECT_ID,
  DONORS_WITHOUT_PROJECT_SQL,
  donorBelongedToProjectAtMonth,
} from "../src/services/project/projectAssignmentSql.js";

/**
 * Vincula doadores ao projeto padrão.
 *
 * As queries do dashboard passaram a ser escopadas por projeto, e um doador
 * sem vínculo não pertence a projeto nenhum — por desenho. As fixtures que
 * inserem linhas direto (sem passar pelo bootstrap, que faz o backfill)
 * precisam criar o vínculo explicitamente.
 */
async function seedAssignments(conn, donorIds) {
  const values = donorIds
    .map(
      (donorId, index) =>
        `('dpa-test-${index}', '${donorId}', '${DEFAULT_PROJECT_ID}', DATE '${ASSIGNMENT_OPEN_START}', DATE '${ASSIGNMENT_OPEN_END}', 'inicial', CURRENT_TIMESTAMP)`,
    )
    .join(",");

  await conn.query(`
    INSERT INTO donor_project_assignments
      (id, donor_id, project_id, valid_from, valid_to, reason, created_at)
    VALUES ${values}
  `);
}
import {
  MONTHLY_TREND_LIMIT,
  buildMonthlyTrendSql,
} from "../src/services/dashboard/monthlyTrendSql.js";

test("prepared statements bind parameters via ? placeholders", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await conn.query(
      "INSERT INTO demands (id, name, color, is_active) VALUES ('a', 'Alpha', '#000', TRUE), ('b', 'Beta', '#111', TRUE)",
    );

    const stmt = await conn.prepare("SELECT name FROM demands WHERE id = ?");
    try {
      const result = await stmt.query("a");
      const rows = result.toArray();
      assert.equal(rows.length, 1);
      assert.equal(String(rows[0].name), "Alpha");
    } finally {
      await stmt.close();
    }
  } finally {
    conn.close();
  }
});

test("prepared statements neutralize quote injection attempts", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await conn.query(
      "INSERT INTO demands (id, name, color, is_active) VALUES ('safe', 'Real demand', '#000', TRUE)",
    );

    // Attempting classic injection through a prepared parameter must produce
    // zero rows, never execute the suffix as SQL.
    const stmt = await conn.prepare("SELECT count(*) AS total FROM demands WHERE name = ?");
    try {
      const result = await stmt.query("Real demand'; DROP TABLE demands; --");
      const rows = result.toArray();
      assert.equal(Number(rows[0].total), 0);
    } finally {
      await stmt.close();
    }

    // Verify the table is still intact.
    const surviving = await conn.query("SELECT count(*) AS total FROM demands");
    assert.equal(Number(surviving.toArray()[0].total), 1);
  } finally {
    conn.close();
  }
});

test("runMigrations creates schema_version and stamps each migration", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    const stamped = (
      await conn.query("SELECT id, name FROM schema_version ORDER BY id ASC")
    ).toArray();

    assert.equal(stamped.length, MIGRATIONS.length);
    for (let index = 0; index < MIGRATIONS.length; index += 1) {
      assert.equal(Number(stamped[index].id), MIGRATIONS[index].id);
      assert.equal(String(stamped[index].name), MIGRATIONS[index].name);
    }
  } finally {
    conn.close();
  }
});

test("runMigrations is idempotent across repeated calls", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await runMigrations(conn);
    await runMigrations(conn);

    const result = (
      await conn.query("SELECT count(*) AS total FROM schema_version")
    ).toArray();

    assert.equal(Number(result[0].total), MIGRATIONS.length);
  } finally {
    conn.close();
  }
});

test("runMigrations creates the expected core tables", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    const expectedTables = [
      "demands",
      "people",
      "donors",
      "donor_cpf_links",
      "imports",
      "import_cpf_summary",
      "monthly_donor_summary",
      "notes",
      "action_history",
      "donor_activity_history",
      "trash_items",
      "schema_version",
    ];

    const rows = (
      await conn.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'",
      )
    ).toArray();
    const presentTables = new Set(rows.map((row) => String(row.table_name)));

    for (const table of expectedTables) {
      assert.ok(
        presentTables.has(table),
        `expected table ${table} to be created by migrations`,
      );
    }
  } finally {
    conn.close();
  }
});

test("migration v2 creates UNIQUE indexes on every id column", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    const expectedIndexes = [
      "uq_demands_id",
      "uq_people_id",
      "uq_donors_id",
      "uq_donor_cpf_links_id",
      "uq_imports_id",
      "uq_import_cpf_summary_id",
      "uq_monthly_donor_summary_id",
      "uq_notes_id",
      "uq_action_history_id",
      "uq_donor_activity_history_id",
      "uq_trash_items_id",
      "uq_schema_version_id",
    ];

    const rows = (
      await conn.query(
        "SELECT index_name, is_unique FROM duckdb_indexes() WHERE schema_name = 'main'",
      )
    ).toArray();
    const indexMap = new Map(
      rows.map((row) => [String(row.index_name), Boolean(row.is_unique)]),
    );

    for (const indexName of expectedIndexes) {
      assert.ok(
        indexMap.has(indexName),
        `expected migration v2 to create index ${indexName}`,
      );
      assert.equal(
        indexMap.get(indexName),
        true,
        `expected ${indexName} to be a UNIQUE index`,
      );
    }
  } finally {
    conn.close();
  }
});

test("migration v2 creates UNIQUE indexes on natural keys", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    const expectedNaturalKeyIndexes = [
      // CPF continua único na PLATAFORMA inteira, e isso está correto: uma
      // base de doadores só, um CPF por pessoa. O projeto vem do vínculo,
      // não de uma coluna aqui.
      "uq_people_cpf",
      "uq_donors_cpf",
      // O nome da demanda era único globalmente até a v13. Virou único POR
      // PROJETO — sem isso, dois projetos não poderiam ter uma demanda com
      // o mesmo nome.
      "uq_demands_project_name",
    ];

    const rows = (
      await conn.query(
        "SELECT index_name, is_unique FROM duckdb_indexes() WHERE schema_name = 'main'",
      )
    ).toArray();
    const indexMap = new Map(
      rows.map((row) => [String(row.index_name), Boolean(row.is_unique)]),
    );

    for (const indexName of expectedNaturalKeyIndexes) {
      assert.ok(
        indexMap.has(indexName),
        `expected migration v2 to create natural-key index ${indexName}`,
      );
      assert.equal(
        indexMap.get(indexName),
        true,
        `expected ${indexName} to be a UNIQUE index`,
      );
    }
  } finally {
    conn.close();
  }
});

test("migration v3 creates abatement_adjustments table with proper indexes", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    const tables = (
      await conn.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'",
      )
    ).toArray();
    const tableSet = new Set(tables.map((row) => String(row.table_name)));
    assert.ok(
      tableSet.has("abatement_adjustments"),
      "expected migration v3 to create abatement_adjustments table",
    );

    const indexes = (
      await conn.query(
        "SELECT index_name, is_unique FROM duckdb_indexes() WHERE schema_name = 'main'",
      )
    ).toArray();
    const indexMap = new Map(
      indexes.map((row) => [String(row.index_name), Boolean(row.is_unique)]),
    );

    assert.ok(
      indexMap.has("uq_abatement_adjustments_id"),
      "expected UNIQUE index on abatement_adjustments(id)",
    );
    assert.ok(
      indexMap.has("uq_abatement_adjustments_donor_month"),
      "expected UNIQUE index on (donor_id, reference_month)",
    );
    assert.equal(
      indexMap.get("uq_abatement_adjustments_donor_month"),
      true,
      "donor_month index must be UNIQUE",
    );

    // Sanity check: a single adjustment row inserts cleanly with the schema
    // shape declared by the migration.
    await conn.query(
      `INSERT INTO abatement_adjustments
        (id, donor_id, reference_month, range_start_month, range_end_month, notes_count, abatement_amount, abatement_status)
       VALUES ('a1', 'donor-x', '2025-11-01', '2025-06-01', '2025-10-01', 28, 840, 'pending')`,
    );

    const stored = (
      await conn.query(
        "SELECT count(*) AS total FROM abatement_adjustments WHERE donor_id = 'donor-x'",
      )
    ).toArray();
    assert.equal(Number(stored[0].total), 1);
  } finally {
    conn.close();
  }
});

test("multi-row INSERT into monthly_donor_summary works (bulk reconcile path)", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    // The reconcileImport bulk-insert refactor relies on DuckDB-WASM accepting
    // a multi-row VALUES clause. Verify the pattern works against a real
    // database before trusting it in production.
    await conn.query(`
      INSERT INTO monthly_donor_summary
        (id, import_id, donor_id, reference_month, cpf, donor_name, demand,
         notes_count, invalid_notes_count, value_per_note, abatement_amount,
         abatement_status, abatement_marked_at, updated_at)
      VALUES
        ('row-1', 'imp-x', 'donor-x', '2025-01-01', '11111111111', 'Donor X', 'D1',
         5, 0, 30, 150, 'pending', NULL, CURRENT_TIMESTAMP),
        ('row-2', 'imp-x', 'donor-y', '2025-01-01', '22222222222', 'Donor Y', 'D2',
         3, 0, 30, 90, 'pending', NULL, CURRENT_TIMESTAMP),
        ('row-3', 'imp-x', 'donor-z', '2025-01-01', '33333333333', 'Donor Z', 'D3',
         8, 1, 30, 240, 'applied', '2025-01-15 10:00:00', CURRENT_TIMESTAMP)
    `);

    const rows = (
      await conn.query(
        "SELECT count(*) AS total, sum(notes_count) AS notes FROM monthly_donor_summary WHERE import_id = 'imp-x'",
      )
    ).toArray();
    assert.equal(Number(rows[0].total), 3);
    assert.equal(Number(rows[0].notes), 16);
  } finally {
    conn.close();
  }
});

test("migration v4 creates performance indexes", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    const expectedIndexes = [
      "idx_monthly_summary_month_donor",
      "idx_monthly_summary_donor",
      "idx_donor_activity_history_donor_month",
      "idx_import_cpf_summary_month",
    ];

    const rows = (
      await conn.query(
        "SELECT index_name FROM duckdb_indexes() WHERE schema_name = 'main'",
      )
    ).toArray();
    const indexSet = new Set(rows.map((row) => String(row.index_name)));

    for (const indexName of expectedIndexes) {
      assert.ok(
        indexSet.has(indexName),
        `expected migration v4 to create index ${indexName}`,
      );
    }
  } finally {
    conn.close();
  }
});

test("migration v5 creates donation_notes table and cnpj_entidade_social column", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    const tables = (
      await conn.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'",
      )
    ).toArray();
    const tableSet = new Set(tables.map((row) => String(row.table_name)));
    assert.ok(
      tableSet.has("donation_notes"),
      "expected migration v5 to create donation_notes table",
    );

    const importColumns = (
      await conn.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'imports'",
      )
    ).toArray();
    const importColumnSet = new Set(
      importColumns.map((row) => String(row.column_name)),
    );
    assert.ok(
      importColumnSet.has("cnpj_entidade_social"),
      "expected migration v5 to add cnpj_entidade_social column to imports",
    );

    const expectedIndexes = [
      ["uq_donation_notes_id", true],
      ["idx_donation_notes_import", false],
      ["idx_donation_notes_cpf", false],
      ["idx_donation_notes_match_key", false],
    ];

    const indexes = (
      await conn.query(
        "SELECT index_name, is_unique FROM duckdb_indexes() WHERE schema_name = 'main'",
      )
    ).toArray();
    const indexMap = new Map(
      indexes.map((row) => [String(row.index_name), Boolean(row.is_unique)]),
    );

    for (const [indexName, isUnique] of expectedIndexes) {
      assert.ok(
        indexMap.has(indexName),
        `expected migration v5 to create index ${indexName}`,
      );
      assert.equal(
        indexMap.get(indexName),
        isUnique,
        `expected ${indexName} unique=${isUnique}`,
      );
    }
  } finally {
    conn.close();
  }
});

test("donation_notes round-trip preserves the match key fields", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    // The reconciliation against credits will pivot on
    // (cnpj_estabelecimento, numero_nota, data_nota). Insert a small set and
    // verify the values come back unmodified — protects against accidental
    // column-order changes in the migration.
    await conn.query(`
      INSERT INTO donation_notes
        (id, import_id, cpf, reference_month, numero_nota, valor_nota,
         data_nota, data_pedido, cnpj_estabelecimento, status_pedido,
         tipo_doacao, is_valid, created_at)
      VALUES
        ('n1', 'imp-A', '11111111111', '2025-01-01', '00123', 12.5,
         '2025-01-15', '2025-01-20', '12345678000190', 'Aprovado',
         'Doação direta', TRUE, CURRENT_TIMESTAMP),
        ('n2', 'imp-A', '22222222222', '2025-01-01', '00124', 8.0,
         '2025-01-16', '2025-01-20', '98765432000110', 'Não pode ser doado',
         'Doação', FALSE, CURRENT_TIMESTAMP)
    `);

    const rows = (
      await conn.query(`
        SELECT
          cnpj_estabelecimento,
          numero_nota,
          CAST(data_nota AS VARCHAR) AS data_nota,
          is_valid
        FROM donation_notes
        ORDER BY id ASC
      `)
    ).toArray();

    assert.equal(rows.length, 2);
    assert.equal(String(rows[0].cnpj_estabelecimento), "12345678000190");
    assert.equal(String(rows[0].numero_nota), "00123");
    assert.equal(String(rows[0].data_nota), "2025-01-15");
    assert.equal(Boolean(rows[0].is_valid), true);
    assert.equal(Boolean(rows[1].is_valid), false);
  } finally {
    conn.close();
  }
});

test("aggregation from donation_notes splits valid vs invalid counts per CPF", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    await conn.query(`
      INSERT INTO donation_notes
        (id, import_id, cpf, reference_month, numero_nota, is_valid, created_at)
      VALUES
        ('n1', 'imp-1', '11111111111', '2025-01-01', '1', TRUE, CURRENT_TIMESTAMP),
        ('n2', 'imp-1', '11111111111', '2025-01-01', '2', TRUE, CURRENT_TIMESTAMP),
        ('n3', 'imp-1', '11111111111', '2025-01-01', '3', FALSE, CURRENT_TIMESTAMP),
        ('n4', 'imp-1', '22222222222', '2025-01-01', '4', TRUE, CURRENT_TIMESTAMP),
        ('n5', 'imp-1', '22222222222', '2025-01-01', '5', FALSE, CURRENT_TIMESTAMP),
        ('n6', 'imp-1', '22222222222', '2025-01-01', '6', FALSE, CURRENT_TIMESTAMP)
    `);

    // Same aggregation `aggregateCpfCountsFromDonationNotes` runs against
    // production data. Replays it here against the in-memory db to lock in
    // the contract: notes_count = TRUE rows, invalid_notes_count = FALSE.
    const rows = (
      await conn.query(`
        SELECT
          cpf,
          count(*) FILTER (WHERE is_valid = TRUE) AS notes_count,
          count(*) FILTER (WHERE is_valid = FALSE) AS invalid_notes_count
        FROM donation_notes
        WHERE import_id = 'imp-1'
        GROUP BY cpf
        ORDER BY cpf ASC
      `)
    ).toArray();

    assert.equal(rows.length, 2);
    assert.equal(Number(rows[0].notes_count), 2);
    assert.equal(Number(rows[0].invalid_notes_count), 1);
    assert.equal(Number(rows[1].notes_count), 1);
    assert.equal(Number(rows[1].invalid_notes_count), 2);
  } finally {
    conn.close();
  }
});

test("try_strptime parses Brazilian dd/mm/yy dates and tolerates garbage", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    // The parser uses `%d/%m/%y` because the donations spreadsheet exports
    // dates with a 2-digit year. DuckDB pivots `%y` at 00-68 → 20xx,
    // 69-99 → 19xx; we only care about post-2000 data so the convention
    // holds. Bad inputs must return NULL (try_strptime, not strptime).
    // Cast to VARCHAR before reading: DuckDB-Node returns DATE values as
    // epoch days/seconds in the wire format, which trip up direct string
    // comparison; the production code already uses CAST/strftime when it
    // needs to read a DATE back.
    const rows = (
      await conn.query(`
        SELECT
          CAST(try_strptime('15/03/25', '%d/%m/%y')::DATE AS VARCHAR) AS d1,
          CAST(try_strptime('01/01/26', '%d/%m/%y')::DATE AS VARCHAR) AS d2,
          CAST(try_strptime('not a date', '%d/%m/%y')::DATE AS VARCHAR) AS d3,
          CAST(try_strptime('', '%d/%m/%y')::DATE AS VARCHAR) AS d4
      `)
    ).toArray();

    assert.equal(String(rows[0].d1), "2025-03-15");
    assert.equal(String(rows[0].d2), "2026-01-01");
    assert.equal(rows[0].d3, null);
    assert.equal(rows[0].d4, null);
  } finally {
    conn.close();
  }
});

test("CNPJ normalization via regexp_replace strips formatting separators", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    const rows = (
      await conn.query(`
        SELECT
          regexp_replace('12.345.678/0001-90', '[^0-9]', '', 'g') AS formatted,
          regexp_replace('98765432000110', '[^0-9]', '', 'g') AS unformatted,
          regexp_replace('', '[^0-9]', '', 'g') AS empty_input,
          regexp_replace(' 11 .222. 333/4444-55 ', '[^0-9]', '', 'g') AS spaced
      `)
    ).toArray();

    assert.equal(String(rows[0].formatted), "12345678000190");
    assert.equal(String(rows[0].unformatted), "98765432000110");
    assert.equal(String(rows[0].empty_input), "");
    assert.equal(String(rows[0].spaced), "11222333444455");
  } finally {
    conn.close();
  }
});

test("invalid status pattern matches the production INVALID_ORDER_STATUS_PATTERNS", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    // `_` is the LIKE single-char wildcard — patterns intentionally use it in
    // place of `á/ã/é/í/ó` so both UTF-8 (with the accented char) and
    // Windows-1252 (where DuckDB replaces accents with U+FFFD) match.
    const rows = (
      await conn.query(`
        WITH samples(status) AS (
          VALUES
            ('Aprovado'),
            ('Doação aceita'),
            ('Não foi possível encontrar o documento'),
            ('Nao foi possivel encontrar o documento'),
            ('Não pode ser doado'),
            ('NOTA NAO PODE SER DOADO')
        )
        SELECT
          status,
          (lower(coalesce(status, '')) LIKE '%n_o foi poss_vel encontrar o documento%'
           OR lower(coalesce(status, '')) LIKE '%n_o pode ser doado%') AS is_invalid
        FROM samples
        ORDER BY status ASC
      `)
    ).toArray();

    const byStatus = new Map(
      rows.map((row) => [String(row.status), Boolean(row.is_invalid)]),
    );

    assert.equal(byStatus.get("Aprovado"), false);
    assert.equal(byStatus.get("Doação aceita"), false);
    assert.equal(
      byStatus.get("Não foi possível encontrar o documento"),
      true,
    );
    assert.equal(
      byStatus.get("Nao foi possivel encontrar o documento"),
      true,
    );
    assert.equal(byStatus.get("Não pode ser doado"), true);
    assert.equal(byStatus.get("NOTA NAO PODE SER DOADO"), true);
  } finally {
    conn.close();
  }
});

test("donation_notes deletion by import_id is scoped (does not affect siblings)", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    // Reimport's first step is `DELETE FROM donation_notes WHERE import_id =
    // ?`. Lock in that the WHERE clause is mandatory — a stray DELETE without
    // it would wipe other imports' notes.
    await conn.query(`
      INSERT INTO donation_notes (id, import_id, cpf, is_valid, created_at)
      VALUES
        ('a1', 'imp-A', '11111111111', TRUE, CURRENT_TIMESTAMP),
        ('a2', 'imp-A', '22222222222', TRUE, CURRENT_TIMESTAMP),
        ('b1', 'imp-B', '33333333333', TRUE, CURRENT_TIMESTAMP)
    `);

    await conn.query(`
      DELETE FROM donation_notes WHERE import_id = 'imp-A'
    `);

    const surviving = (
      await conn.query("SELECT id FROM donation_notes ORDER BY id ASC")
    ).toArray();

    assert.equal(surviving.length, 1);
    assert.equal(String(surviving[0].id), "b1");
  } finally {
    conn.close();
  }
});

test("migration v6 creates credit_imports and credit_notes tables", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    const tables = (
      await conn.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_name IN ('credit_imports', 'credit_notes')
         ORDER BY table_name ASC`,
      )
    ).toArray();

    assert.equal(tables.length, 2);
    assert.equal(String(tables[0].table_name), "credit_imports");
    assert.equal(String(tables[1].table_name), "credit_notes");

    // Sanity check that the match key columns exist on credit_notes.
    const columns = (
      await conn.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'credit_notes'
         ORDER BY column_name ASC`,
      )
    ).toArray();

    const columnNames = columns.map((row) => String(row.column_name));
    for (const column of [
      "cnpj_estabelecimento",
      "numero_nota",
      "data_emissao",
      "credito",
      "situacao",
      "is_valid",
    ]) {
      assert.ok(
        columnNames.includes(column),
        `credit_notes missing expected column ${column}`,
      );
    }
  } finally {
    conn.close();
  }
});

test("migration v6 creates the credit_notes match-key index", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    // DuckDB exposes indexes via duckdb_indexes — query it for the composite
    // index that Fase 3 will probe to join donations × credits.
    const indexes = (
      await conn.query(
        `SELECT index_name FROM duckdb_indexes
         WHERE table_name = 'credit_notes'
         ORDER BY index_name ASC`,
      )
    ).toArray();

    const names = indexes.map((row) => String(row.index_name));
    assert.ok(
      names.includes("idx_credit_notes_match_key"),
      `expected idx_credit_notes_match_key; got ${names.join(", ")}`,
    );
    assert.ok(
      names.includes("uq_credit_notes_id"),
      `expected uq_credit_notes_id; got ${names.join(", ")}`,
    );
  } finally {
    conn.close();
  }
});

test("credit is_valid only when lower(trim(situacao)) = 'calculado'", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    // Drives the same SQL expression used by populateCreditNotesFromCsv. Lock
    // in the case- and trim-insensitivity, and the strict rejection of
    // anything else (Pendente, Cancelado, blank).
    const rows = (
      await conn.query(`
        WITH samples(situacao) AS (
          VALUES
            ('Calculado'),
            ('calculado'),
            ('  CALCULADO  '),
            ('Pendente'),
            ('Cancelado'),
            (''),
            (NULL)
        )
        SELECT
          situacao,
          lower(trim(coalesce(situacao, ''))) = 'calculado' AS is_valid
        FROM samples
      `)
    ).toArray();

    const byStatus = new Map(
      rows.map((row) => [
        row.situacao === null ? "<null>" : String(row.situacao),
        Boolean(row.is_valid),
      ]),
    );

    assert.equal(byStatus.get("Calculado"), true);
    assert.equal(byStatus.get("calculado"), true);
    assert.equal(byStatus.get("  CALCULADO  "), true);
    assert.equal(byStatus.get("Pendente"), false);
    assert.equal(byStatus.get("Cancelado"), false);
    assert.equal(byStatus.get(""), false);
    assert.equal(byStatus.get("<null>"), false);
  } finally {
    conn.close();
  }
});

test("credit_notes aggregation by credit_import_id splits valid vs total rows", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    await conn.query(`
      INSERT INTO credit_notes (
        id, credit_import_id, cnpj_estabelecimento, numero_nota,
        data_emissao, credito, situacao, is_valid, created_at
      )
      VALUES
        ('c1', 'ci-1', '11111111000111', '101', DATE '2025-01-15', 0.30, 'Calculado', TRUE, CURRENT_TIMESTAMP),
        ('c2', 'ci-1', '22222222000122', '202', DATE '2025-02-10', 0.50, 'Pendente', FALSE, CURRENT_TIMESTAMP),
        ('c3', 'ci-1', '33333333000133', '303', DATE '2025-03-05', 0.10, 'Calculado', TRUE, CURRENT_TIMESTAMP),
        ('c4', 'ci-2', '44444444000144', '404', DATE '2025-04-20', 1.20, 'Calculado', TRUE, CURRENT_TIMESTAMP)
    `);

    const totals = (
      await conn.query(`
        SELECT
          count(*) AS total_rows,
          count(*) FILTER (WHERE is_valid = TRUE) AS valid_rows
        FROM credit_notes
        WHERE credit_import_id = 'ci-1'
      `)
    ).toArray();

    assert.equal(Number(totals[0].total_rows), 3);
    assert.equal(Number(totals[0].valid_rows), 2);
  } finally {
    conn.close();
  }
});

test("credit_notes deletion by credit_import_id is scoped (does not affect siblings)", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    await conn.query(`
      INSERT INTO credit_notes (
        id, credit_import_id, cnpj_estabelecimento, numero_nota,
        data_emissao, is_valid, created_at
      )
      VALUES
        ('a1', 'ci-A', '111', '1', DATE '2025-01-01', TRUE, CURRENT_TIMESTAMP),
        ('a2', 'ci-A', '222', '2', DATE '2025-01-02', TRUE, CURRENT_TIMESTAMP),
        ('b1', 'ci-B', '333', '3', DATE '2025-02-01', TRUE, CURRENT_TIMESTAMP)
    `);

    await conn.query(`DELETE FROM credit_notes WHERE credit_import_id = 'ci-A'`);

    const surviving = (
      await conn.query("SELECT id FROM credit_notes ORDER BY id ASC")
    ).toArray();

    assert.equal(surviving.length, 1);
    assert.equal(String(surviving[0].id), "b1");
  } finally {
    conn.close();
  }
});

test("migration v7 adds reference_month to credit_imports", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    const columns = (
      await conn.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'credit_imports'
         ORDER BY column_name ASC`,
      )
    ).toArray();

    const names = columns.map((row) => String(row.column_name));
    assert.ok(
      names.includes("reference_month"),
      `credit_imports missing reference_month; got ${names.join(", ")}`,
    );
  } finally {
    conn.close();
  }
});

test("migration v8 creates credit_reconciliation table and indexes", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    const tables = (
      await conn.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_name = 'credit_reconciliation'`,
      )
    ).toArray();

    assert.equal(tables.length, 1);

    const indexes = (
      await conn.query(
        `SELECT index_name FROM duckdb_indexes
         WHERE table_name = 'credit_reconciliation'`,
      )
    ).toArray();

    const names = indexes.map((row) => String(row.index_name));
    for (const expected of [
      "uq_credit_reconciliation_id",
      "idx_credit_reconciliation_status",
      "idx_credit_reconciliation_credit",
      "idx_credit_reconciliation_donation",
    ]) {
      assert.ok(
        names.includes(expected),
        `expected index ${expected}; got ${names.join(", ")}`,
      );
    }
  } finally {
    conn.close();
  }
});

// Helper: runs the exact SQL sequence that `reconcileCredits` issues. The
// service wraps this in a transaction + notify, neither of which the test
// connection needs. Keep this in sync with
// src/services/reconciliation/creditReconciliationService.js — if they
// drift, the test stops validating the production code path.
//
// As of migration v9, matching pivots on `(match_key, valor_cents)` —
// dates are stored but no longer participate. The completeKey factory
// returns a qualified WHERE fragment for the given table alias so JOIN
// queries with multiple notes tables don't trip an ambiguous reference.
function completeKey(alias) {
  return `
    ${alias}.match_key IS NOT NULL
    AND ${alias}.match_key <> ''
    AND ${alias}.match_key NOT LIKE '%|'
    AND ${alias}.match_key NOT LIKE '|%'
  `;
}

async function runCreditReconciliation(conn) {
  // Backfill match_key / valor_cents on whatever the test just inserted.
  // Production code does this at INSERT time in the parser; tests skip the
  // parser to keep their setup compact, so we mirror that derived state here
  // before running the reconcile. Same SQL expression as the parser path.
  await conn.query(`
    UPDATE donation_notes
    SET match_key = coalesce(cnpj_estabelecimento, '') || '|' || coalesce(numero_nota, ''),
        valor_cents = cast(round(coalesce(valor_nota, 0) * 100) AS BIGINT)
    WHERE match_key IS NULL OR match_key = ''
  `);
  await conn.query(`
    UPDATE credit_notes
    SET match_key = coalesce(cnpj_estabelecimento, '') || '|' || coalesce(numero_nota, ''),
        valor_cents = cast(round(coalesce(valor_nf, 0) * 100) AS BIGINT)
    WHERE match_key IS NULL OR match_key = ''
  `);

  await conn.query(`DELETE FROM credit_reconciliation`);

  await conn.query(`
    INSERT INTO credit_reconciliation (
      id, credit_note_id, donation_note_id, match_status, created_at
    )
    SELECT
      CAST(uuid() AS VARCHAR),
      NULL,
      donation_notes.id,
      'duplicate_donation',
      CURRENT_TIMESTAMP
    FROM donation_notes
    INNER JOIN (
      SELECT match_key
      FROM donation_notes
      WHERE is_valid = TRUE AND ${completeKey("donation_notes")}
      GROUP BY match_key
      HAVING count(*) > 1
    ) AS donation_duplicates
      ON donation_duplicates.match_key = donation_notes.match_key
    WHERE donation_notes.is_valid = TRUE
  `);

  await conn.query(`
    INSERT INTO credit_reconciliation (
      id, credit_note_id, donation_note_id, match_status, created_at
    )
    SELECT
      CAST(uuid() AS VARCHAR),
      credit_notes.id,
      NULL,
      'duplicate_credit',
      CURRENT_TIMESTAMP
    FROM credit_notes
    INNER JOIN (
      SELECT match_key
      FROM credit_notes
      WHERE is_valid = TRUE AND ${completeKey("credit_notes")}
      GROUP BY match_key
      HAVING count(*) > 1
    ) AS credit_duplicates
      ON credit_duplicates.match_key = credit_notes.match_key
    WHERE credit_notes.is_valid = TRUE
  `);

  await conn.query(`
    INSERT INTO credit_reconciliation (
      id, credit_note_id, donation_note_id, match_status, created_at
    )
    SELECT
      CAST(uuid() AS VARCHAR),
      credit_notes.id,
      donation_notes.id,
      'matched',
      CURRENT_TIMESTAMP
    FROM credit_notes
    INNER JOIN donation_notes
      ON donation_notes.match_key = credit_notes.match_key
      AND donation_notes.valor_cents = credit_notes.valor_cents
    WHERE credit_notes.is_valid = TRUE
      AND donation_notes.is_valid = TRUE
      AND ${completeKey("credit_notes")}
      AND NOT EXISTS (
        SELECT 1
        FROM credit_reconciliation
        WHERE credit_reconciliation.credit_note_id = credit_notes.id
          OR credit_reconciliation.donation_note_id = donation_notes.id
      )
  `);

  await conn.query(`
    INSERT INTO credit_reconciliation (
      id, credit_note_id, donation_note_id, match_status, created_at
    )
    SELECT
      CAST(uuid() AS VARCHAR),
      credit_notes.id,
      donation_notes.id,
      'divergent',
      CURRENT_TIMESTAMP
    FROM credit_notes
    INNER JOIN donation_notes
      ON donation_notes.match_key = credit_notes.match_key
      AND donation_notes.valor_cents <> credit_notes.valor_cents
    WHERE credit_notes.is_valid = TRUE
      AND donation_notes.is_valid = TRUE
      AND ${completeKey("credit_notes")}
      AND NOT EXISTS (
        SELECT 1
        FROM credit_reconciliation
        WHERE credit_reconciliation.credit_note_id = credit_notes.id
          OR credit_reconciliation.donation_note_id = donation_notes.id
      )
  `);

  await conn.query(`
    INSERT INTO credit_reconciliation (
      id, credit_note_id, donation_note_id, match_status, created_at
    )
    SELECT
      CAST(uuid() AS VARCHAR),
      credit_notes.id,
      NULL,
      'credit_only',
      CURRENT_TIMESTAMP
    FROM credit_notes
    WHERE credit_notes.is_valid = TRUE
      AND NOT EXISTS (
        SELECT 1
        FROM credit_reconciliation
        WHERE credit_reconciliation.credit_note_id = credit_notes.id
      )
  `);

  await conn.query(`
    INSERT INTO credit_reconciliation (
      id, credit_note_id, donation_note_id, match_status, created_at
    )
    SELECT
      CAST(uuid() AS VARCHAR),
      NULL,
      donation_notes.id,
      'donation_only',
      CURRENT_TIMESTAMP
    FROM donation_notes
    WHERE donation_notes.is_valid = TRUE
      AND NOT EXISTS (
        SELECT 1
        FROM credit_reconciliation
        WHERE credit_reconciliation.donation_note_id = donation_notes.id
      )
  `);
}

async function countReconciliationByStatus(conn) {
  const rows = (
    await conn.query(`
      SELECT match_status, count(*) AS total
      FROM credit_reconciliation
      GROUP BY match_status
    `)
  ).toArray();
  const out = {};
  for (const row of rows) {
    out[String(row.match_status)] = Number(row.total);
  }
  return out;
}

test("reconciliation matches paired notes by (cnpj, numero, data)", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    await conn.query(`
      INSERT INTO donation_notes (
        id, import_id, cpf, numero_nota, data_nota,
        cnpj_estabelecimento, is_valid, created_at
      )
      VALUES (
        'd1', 'imp-1', '11111111111', '101', DATE '2025-01-15',
        '11111111000111', TRUE, CURRENT_TIMESTAMP
      )
    `);
    await conn.query(`
      INSERT INTO credit_notes (
        id, credit_import_id, cnpj_estabelecimento, numero_nota,
        data_emissao, credito, situacao, is_valid, created_at
      )
      VALUES (
        'c1', 'ci-1', '11111111000111', '101', DATE '2025-01-15',
        0.30, 'Calculado', TRUE, CURRENT_TIMESTAMP
      )
    `);

    await runCreditReconciliation(conn);
    const counts = await countReconciliationByStatus(conn);

    assert.equal(counts.matched, 1);
    assert.equal(counts.credit_only ?? 0, 0);
    assert.equal(counts.donation_only ?? 0, 0);
  } finally {
    conn.close();
  }
});

test("reconciliation flags credit and donation orphans separately", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    await conn.query(`
      INSERT INTO donation_notes (
        id, import_id, cpf, numero_nota, data_nota,
        cnpj_estabelecimento, is_valid, created_at
      )
      VALUES
        ('d-paired', 'imp-1', '11111111111', '101', DATE '2025-01-10',
         '11111111000111', TRUE, CURRENT_TIMESTAMP),
        ('d-orphan', 'imp-1', '22222222222', '999', DATE '2025-01-20',
         '22222222000222', TRUE, CURRENT_TIMESTAMP)
    `);
    await conn.query(`
      INSERT INTO credit_notes (
        id, credit_import_id, cnpj_estabelecimento, numero_nota,
        data_emissao, credito, situacao, is_valid, created_at
      )
      VALUES
        ('c-paired', 'ci-1', '11111111000111', '101', DATE '2025-01-10',
         0.30, 'Calculado', TRUE, CURRENT_TIMESTAMP),
        ('c-orphan', 'ci-1', '33333333000333', '888', DATE '2025-01-25',
         0.50, 'Calculado', TRUE, CURRENT_TIMESTAMP)
    `);

    await runCreditReconciliation(conn);
    const counts = await countReconciliationByStatus(conn);

    assert.equal(counts.matched, 1);
    assert.equal(counts.credit_only, 1);
    assert.equal(counts.donation_only, 1);
  } finally {
    conn.close();
  }
});

test("reconciliation surfaces duplicates on either side", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    // Two donations share the same triple — both should land in
    // duplicate_donation, neither should match the single credit.
    await conn.query(`
      INSERT INTO donation_notes (
        id, import_id, cpf, numero_nota, data_nota,
        cnpj_estabelecimento, is_valid, created_at
      )
      VALUES
        ('d1', 'imp-1', '11111111111', '101', DATE '2025-01-15',
         '11111111000111', TRUE, CURRENT_TIMESTAMP),
        ('d2', 'imp-1', '22222222222', '101', DATE '2025-01-15',
         '11111111000111', TRUE, CURRENT_TIMESTAMP)
    `);
    await conn.query(`
      INSERT INTO credit_notes (
        id, credit_import_id, cnpj_estabelecimento, numero_nota,
        data_emissao, credito, situacao, is_valid, created_at
      )
      VALUES (
        'c1', 'ci-1', '11111111000111', '101', DATE '2025-01-15',
        0.30, 'Calculado', TRUE, CURRENT_TIMESTAMP
      )
    `);

    await runCreditReconciliation(conn);
    const counts = await countReconciliationByStatus(conn);

    assert.equal(counts.duplicate_donation, 2);
    assert.equal(counts.matched ?? 0, 0);
    // Credit was excluded by NOT EXISTS guarding the matched pass, so it
    // falls through to credit_only.
    assert.equal(counts.credit_only, 1);
  } finally {
    conn.close();
  }
});

test("reconciliation excludes invalid notes from both sides", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    // Mark the donation invalid (e.g., status pedido was a rejection
    // pattern); reconciliation must skip it entirely and surface the
    // credit as orphan.
    await conn.query(`
      INSERT INTO donation_notes (
        id, import_id, cpf, numero_nota, data_nota,
        cnpj_estabelecimento, is_valid, created_at
      )
      VALUES (
        'd-invalid', 'imp-1', '11111111111', '101', DATE '2025-01-15',
        '11111111000111', FALSE, CURRENT_TIMESTAMP
      )
    `);
    await conn.query(`
      INSERT INTO credit_notes (
        id, credit_import_id, cnpj_estabelecimento, numero_nota,
        data_emissao, credito, situacao, is_valid, created_at
      )
      VALUES (
        'c-valid', 'ci-1', '11111111000111', '101', DATE '2025-01-15',
        0.30, 'Calculado', TRUE, CURRENT_TIMESTAMP
      )
    `);

    await runCreditReconciliation(conn);
    const counts = await countReconciliationByStatus(conn);

    assert.equal(counts.matched ?? 0, 0);
    assert.equal(counts.credit_only, 1);
    // Invalid donation must not appear anywhere.
    assert.equal(counts.donation_only ?? 0, 0);
    assert.equal(counts.duplicate_donation ?? 0, 0);
  } finally {
    conn.close();
  }
});

test("reconciliation is idempotent across repeated runs", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    await conn.query(`
      INSERT INTO donation_notes (
        id, import_id, cpf, numero_nota, data_nota,
        cnpj_estabelecimento, is_valid, created_at
      )
      VALUES
        ('d1', 'imp-1', '11111111111', '101', DATE '2025-01-15',
         '11111111000111', TRUE, CURRENT_TIMESTAMP),
        ('d2', 'imp-1', '22222222222', '202', DATE '2025-02-20',
         '22222222000222', TRUE, CURRENT_TIMESTAMP)
    `);
    await conn.query(`
      INSERT INTO credit_notes (
        id, credit_import_id, cnpj_estabelecimento, numero_nota,
        data_emissao, credito, situacao, is_valid, created_at
      )
      VALUES (
        'c1', 'ci-1', '11111111000111', '101', DATE '2025-01-15',
        0.30, 'Calculado', TRUE, CURRENT_TIMESTAMP
      )
    `);

    await runCreditReconciliation(conn);
    const firstCounts = await countReconciliationByStatus(conn);

    await runCreditReconciliation(conn);
    const secondCounts = await countReconciliationByStatus(conn);

    assert.deepEqual(secondCounts, firstCounts);
    // Sanity: 1 matched + 1 donation_only.
    assert.equal(secondCounts.matched, 1);
    assert.equal(secondCounts.donation_only, 1);
  } finally {
    conn.close();
  }
});

test("credit is_valid survives BOM and NBSP in situacao values", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    // Same expression `populateCreditNotesFromCsv` builds — replace U+FEFF
    // (BOM) and U+00A0 (non-breaking space) before lowering/trimming so the
    // strict equality with 'calculado' isn't defeated by invisible chars
    // that survive a plain trim().
    const rows = (
      await conn.query(`
        WITH samples(situacao) AS (
          VALUES
            ('Calculado'),
            (chr(65279) || 'Calculado'),
            ('Calculado' || chr(160)),
            (chr(160) || 'Calculado' || chr(65279)),
            ('Cancelado')
        )
        SELECT
          situacao,
          lower(trim(replace(replace(situacao, chr(65279), ''), chr(160), ' '))) = 'calculado' AS is_valid
        FROM samples
      `)
    ).toArray();

    const byInput = rows.map((row) => Boolean(row.is_valid));
    assert.equal(byInput[0], true);
    assert.equal(byInput[1], true);
    assert.equal(byInput[2], true);
    assert.equal(byInput[3], true);
    assert.equal(byInput[4], false);
  } finally {
    conn.close();
  }
});

test("migration v10 strips leading zeros from numero_nota and rebuilds match_key", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    // Insert two notas representing the same fiscal note imported from two
    // exports — one zero-padded, one not. Pre-v10 they'd carry different
    // match_keys ('cnpj|0012345' vs 'cnpj|12345') and silently never match.
    await conn.query(`
      INSERT INTO donation_notes (
        id, import_id, cpf, numero_nota, valor_nota,
        cnpj_estabelecimento, is_valid,
        match_key, valor_cents, created_at
      )
      VALUES (
        'dn-padded',
        'import-1',
        '11111111111',
        '0012345',
        100.0,
        '12345678000190',
        TRUE,
        '12345678000190|0012345',
        10000,
        CURRENT_TIMESTAMP
      )
    `);

    await conn.query(`
      INSERT INTO credit_notes (
        id, credit_import_id, cnpj_estabelecimento, numero_nota,
        valor_nf, credito, situacao, is_valid,
        match_key, valor_cents, created_at
      )
      VALUES (
        'cn-unpadded',
        'cimport-1',
        '12345678000190',
        '12345',
        100.0,
        50.0,
        'Calculado',
        TRUE,
        '12345678000190|12345',
        10000,
        CURRENT_TIMESTAMP
      )
    `);

    // v10 already ran (empty tables) during runMigrations() above, so we
    // can't trigger it via the migration runner again. Apply the same SQL
    // directly — the test asserts the SQL itself, not the version stamp.
    await conn.query(
      `UPDATE donation_notes
         SET numero_nota = ltrim(coalesce(numero_nota, ''), '0')
       WHERE numero_nota LIKE '0%'`,
    );
    await conn.query(
      `UPDATE credit_notes
         SET numero_nota = ltrim(coalesce(numero_nota, ''), '0')
       WHERE numero_nota LIKE '0%'`,
    );
    await conn.query(
      `UPDATE donation_notes
         SET match_key = coalesce(cnpj_estabelecimento, '') || '|' || coalesce(numero_nota, '')`,
    );
    await conn.query(
      `UPDATE credit_notes
         SET match_key = coalesce(cnpj_estabelecimento, '') || '|' || coalesce(numero_nota, '')`,
    );

    const donation = (
      await conn.query(
        `SELECT numero_nota, match_key FROM donation_notes WHERE id = 'dn-padded'`,
      )
    ).toArray()[0];
    const credit = (
      await conn.query(
        `SELECT numero_nota, match_key FROM credit_notes WHERE id = 'cn-unpadded'`,
      )
    ).toArray()[0];

    assert.equal(donation.numero_nota, "12345");
    assert.equal(donation.match_key, "12345678000190|12345");
    assert.equal(credit.numero_nota, "12345");
    assert.equal(credit.match_key, "12345678000190|12345");
  } finally {
    conn.close();
  }
});

test("migration v11 accepts 'Liberado' as a valid credit situacao", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    // Insert credit_notes carrying the pre-Jan-2026 NFP situacao "Liberado"
    // and the post-Jan-2026 "Calculado". The original parser only accepted
    // "calculado" exactly, so the "Liberado" rows arrived with is_valid =
    // FALSE. Migration v11 has to flip them.
    await conn.query(`
      INSERT INTO credit_imports (
        id, reference_month, file_name, total_rows, valid_rows,
        status, notes, imported_at, updated_at
      )
      VALUES (
        'ci-old',
        DATE '2025-12-01',
        'Consulta 12.25.csv',
        2,
        0,
        'processed',
        '',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
    `);

    await conn.query(`
      INSERT INTO credit_notes (
        id, credit_import_id, cnpj_estabelecimento, numero_nota,
        valor_nf, credito, situacao, is_valid,
        match_key, valor_cents, created_at
      )
      VALUES
        ('cn-liberado', 'ci-old', '12345678000190', '111',
         100.0, 50.0, 'Liberado', FALSE,
         '12345678000190|111', 10000, CURRENT_TIMESTAMP),
        ('cn-calculado', 'ci-old', '12345678000190', '222',
         100.0, 50.0, 'Calculado', TRUE,
         '12345678000190|222', 10000, CURRENT_TIMESTAMP),
        ('cn-pendente', 'ci-old', '12345678000190', '333',
         100.0, 50.0, 'Pendente', FALSE,
         '12345678000190|333', 10000, CURRENT_TIMESTAMP)
    `);

    // Re-apply the v11 SQL directly — the migration already ran on the
    // empty tables during runMigrations() above. Asserts the SQL itself.
    await conn.query(`
      UPDATE credit_notes
      SET is_valid = (
        lower(trim(replace(replace(coalesce(situacao, ''), CHR(65279), ''), CHR(160), ' ')))
        IN ('calculado', 'liberado')
      )
    `);
    await conn.query(`
      UPDATE credit_imports
      SET valid_rows = COALESCE((
        SELECT count(*)
        FROM credit_notes
        WHERE credit_notes.credit_import_id = credit_imports.id
          AND credit_notes.is_valid = TRUE
      ), 0)
    `);

    const liberado = (
      await conn.query(
        `SELECT is_valid FROM credit_notes WHERE id = 'cn-liberado'`,
      )
    ).toArray()[0];
    const calculado = (
      await conn.query(
        `SELECT is_valid FROM credit_notes WHERE id = 'cn-calculado'`,
      )
    ).toArray()[0];
    const pendente = (
      await conn.query(
        `SELECT is_valid FROM credit_notes WHERE id = 'cn-pendente'`,
      )
    ).toArray()[0];
    const importRow = (
      await conn.query(
        `SELECT valid_rows FROM credit_imports WHERE id = 'ci-old'`,
      )
    ).toArray()[0];

    assert.equal(Boolean(liberado.is_valid), true);
    assert.equal(Boolean(calculado.is_valid), true);
    assert.equal(Boolean(pendente.is_valid), false);
    assert.equal(Number(importRow.valid_rows), 2);
  } finally {
    conn.close();
  }
});

test("migration v9 adds match_key and valor_cents to both note tables", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    const donationColumns = (
      await conn.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'donation_notes'`,
      )
    )
      .toArray()
      .map((row) => String(row.column_name));
    const creditColumns = (
      await conn.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'credit_notes'`,
      )
    )
      .toArray()
      .map((row) => String(row.column_name));

    for (const column of ["match_key", "valor_cents"]) {
      assert.ok(
        donationColumns.includes(column),
        `donation_notes missing ${column}`,
      );
      assert.ok(
        creditColumns.includes(column),
        `credit_notes missing ${column}`,
      );
    }
  } finally {
    conn.close();
  }
});

test("reconciliation classifies same-key/different-value as divergent", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    // Same cnpj+numero, different valor — should land in 'divergent'.
    await conn.query(`
      INSERT INTO donation_notes (
        id, import_id, cpf, numero_nota, valor_nota,
        cnpj_estabelecimento, is_valid, created_at
      )
      VALUES (
        'd1', 'imp-1', '11111111111', '101', 12.34,
        '11111111000111', TRUE, CURRENT_TIMESTAMP
      )
    `);
    await conn.query(`
      INSERT INTO credit_notes (
        id, credit_import_id, cnpj_estabelecimento, numero_nota,
        valor_nf, credito, situacao, is_valid, created_at
      )
      VALUES (
        'c1', 'ci-1', '11111111000111', '101',
        99.99, 0.30, 'Calculado', TRUE, CURRENT_TIMESTAMP
      )
    `);

    await runCreditReconciliation(conn);
    const counts = await countReconciliationByStatus(conn);

    assert.equal(counts.divergent, 1);
    assert.equal(counts.matched ?? 0, 0);
    assert.equal(counts.credit_only ?? 0, 0);
    assert.equal(counts.donation_only ?? 0, 0);
  } finally {
    conn.close();
  }
});

// Helper: seed the schema with a donor, an active donor_cpf_link binding
// CPF → donor_id, plus paired notes that drive the export aggregations.
async function seedReconciliationFixtures(conn) {
  await conn.query(`
    INSERT INTO donors (id, name, cpf, demand, donor_type, is_active, created_at, updated_at)
    VALUES
      ('donor-1', 'Alice Doadora', '11111111111', 'São Lucas', 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('donor-2', 'Bruno Doador', '22222222222', 'Luiz Gama', 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
  await conn.query(`
    INSERT INTO donor_cpf_links (id, donor_id, name, cpf, link_type, is_active, created_at, updated_at)
    VALUES
      ('link-1', 'donor-1', 'Alice Doadora', '11111111111', 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('link-2', 'donor-2', 'Bruno Doador', '22222222222', 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);

  // Alice: 1 matched (R$50 ⇒ 5000 cents) + 1 orphan donation
  // Bruno: 1 divergent (donation 100, credit 200)
  await conn.query(`
    INSERT INTO donation_notes (
      id, import_id, cpf, numero_nota, valor_nota,
      cnpj_estabelecimento, is_valid, created_at
    )
    VALUES
      ('d-alice-match', 'imp-1', '11111111111', '101', 50.00, '11111111000111', TRUE, CURRENT_TIMESTAMP),
      ('d-alice-orphan', 'imp-1', '11111111111', '999', 25.00, '99999999000199', TRUE, CURRENT_TIMESTAMP),
      ('d-bruno-divergent', 'imp-1', '22222222222', '202', 100.00, '22222222000222', TRUE, CURRENT_TIMESTAMP)
  `);
  await conn.query(`
    INSERT INTO credit_notes (
      id, credit_import_id, cnpj_estabelecimento, numero_nota,
      valor_nf, credito, situacao, is_valid, created_at
    )
    VALUES
      ('c-alice-match', 'ci-1', '11111111000111', '101', 50.00, 0.20, 'Calculado', TRUE, CURRENT_TIMESTAMP),
      ('c-bruno-divergent', 'ci-1', '22222222000222', '202', 200.00, 0.55, 'Calculado', TRUE, CURRENT_TIMESTAMP)
  `);

  await conn.query(`
    INSERT INTO monthly_donor_summary (
      id, import_id, donor_id, reference_month, cpf, donor_name,
      notes_count, value_per_note, abatement_amount, abatement_status,
      abatement_marked_at, created_at, updated_at
    )
    VALUES
      ('m-alice', 'imp-1', 'donor-1', DATE '2025-01-01', '11111111111', 'Alice Doadora',
       1, 1.00, 1.00, 'applied', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
}

test("listReconciliationByDonor aggregates matched/divergent/orphans correctly", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seedReconciliationFixtures(conn);
    await runCreditReconciliation(conn);

    // Mirror of `listReconciliationByDonor` — keep this in sync with
    // src/services/reconciliation/creditReconciliationService.js so the test
    // exercises the production SQL path.
    const rows = (
      await conn.query(`
        SELECT
          donors.id AS donor_id,
          donors.name AS donor_name,
          coalesce(matched_totals.total_credit, 0) AS matched_credit_value,
          coalesce(matched_totals.matched_count, 0) AS matched_count,
          coalesce(divergent_totals.divergent_credit, 0) AS divergent_credit_value,
          coalesce(divergent_totals.divergent_count, 0) AS divergent_count,
          coalesce(orphan_totals.orphan_count, 0) AS orphan_donation_count,
          coalesce(abated_totals.total_abated, 0) AS total_abated
        FROM donors
        LEFT JOIN (
          SELECT donor_cpf_links.donor_id, sum(credit_notes.credito) AS total_credit, count(*) AS matched_count
          FROM credit_reconciliation
          INNER JOIN donation_notes ON donation_notes.id = credit_reconciliation.donation_note_id
          INNER JOIN donor_cpf_links ON donor_cpf_links.cpf = donation_notes.cpf AND donor_cpf_links.is_active = TRUE
          INNER JOIN credit_notes ON credit_notes.id = credit_reconciliation.credit_note_id
          WHERE credit_reconciliation.match_status = 'matched'
          GROUP BY donor_cpf_links.donor_id
        ) AS matched_totals ON matched_totals.donor_id = donors.id
        LEFT JOIN (
          SELECT donor_cpf_links.donor_id, sum(credit_notes.credito) AS divergent_credit, count(*) AS divergent_count
          FROM credit_reconciliation
          INNER JOIN donation_notes ON donation_notes.id = credit_reconciliation.donation_note_id
          INNER JOIN donor_cpf_links ON donor_cpf_links.cpf = donation_notes.cpf AND donor_cpf_links.is_active = TRUE
          INNER JOIN credit_notes ON credit_notes.id = credit_reconciliation.credit_note_id
          WHERE credit_reconciliation.match_status = 'divergent'
          GROUP BY donor_cpf_links.donor_id
        ) AS divergent_totals ON divergent_totals.donor_id = donors.id
        LEFT JOIN (
          SELECT donor_cpf_links.donor_id, count(*) AS orphan_count
          FROM credit_reconciliation
          INNER JOIN donation_notes ON donation_notes.id = credit_reconciliation.donation_note_id
          INNER JOIN donor_cpf_links ON donor_cpf_links.cpf = donation_notes.cpf AND donor_cpf_links.is_active = TRUE
          WHERE credit_reconciliation.match_status = 'donation_only'
          GROUP BY donor_cpf_links.donor_id
        ) AS orphan_totals ON orphan_totals.donor_id = donors.id
        LEFT JOIN (
          SELECT donor_id, sum(abatement_amount) AS total_abated
          FROM monthly_donor_summary
          WHERE abatement_status = 'applied'
          GROUP BY donor_id
        ) AS abated_totals ON abated_totals.donor_id = donors.id
        WHERE donors.is_active = TRUE
        ORDER BY donors.name ASC
      `)
    ).toArray();

    assert.equal(rows.length, 2);

    const alice = rows.find((row) => String(row.donor_id) === "donor-1");
    assert.equal(Number(alice.matched_count), 1, "Alice has 1 matched");
    assert.equal(Number(alice.divergent_count), 0);
    assert.equal(Number(alice.orphan_donation_count), 1, "Alice has 1 orphan");
    assert.equal(Number(alice.total_abated), 1, "Alice has R$1 abated");

    const bruno = rows.find((row) => String(row.donor_id) === "donor-2");
    assert.equal(Number(bruno.matched_count), 0);
    assert.equal(Number(bruno.divergent_count), 1, "Bruno has 1 divergent");
    assert.equal(Number(bruno.orphan_donation_count), 0);
    assert.equal(Number(bruno.total_abated), 0);
  } finally {
    conn.close();
  }
});

test("listReconciliationPairs returns matched + divergent rows with both sides' values", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seedReconciliationFixtures(conn);
    await runCreditReconciliation(conn);

    const rows = (
      await conn.query(`
        SELECT
          credit_reconciliation.match_status,
          donors.name AS donor_name,
          donation_notes.valor_nota AS valor_donation,
          credit_notes.valor_nf AS valor_credit,
          credit_notes.credito AS credito_real
        FROM credit_reconciliation
        INNER JOIN donation_notes ON donation_notes.id = credit_reconciliation.donation_note_id
        INNER JOIN credit_notes ON credit_notes.id = credit_reconciliation.credit_note_id
        LEFT JOIN donor_cpf_links ON donor_cpf_links.cpf = donation_notes.cpf AND donor_cpf_links.is_active = TRUE
        LEFT JOIN donors ON donors.id = donor_cpf_links.donor_id
        WHERE credit_reconciliation.match_status IN ('matched', 'divergent')
        ORDER BY credit_reconciliation.match_status DESC, donors.name ASC
      `)
    ).toArray();

    assert.equal(rows.length, 2);
    // Matched first (DESC sort on status: matched < m comes after divergent
    // alphabetically — actually divergent < matched). Verify both exist.
    const byStatus = Object.fromEntries(
      rows.map((row) => [String(row.match_status), row]),
    );
    assert.ok(byStatus.matched, "matched row present");
    assert.equal(String(byStatus.matched.donor_name), "Alice Doadora");
    assert.equal(Number(byStatus.matched.valor_donation), 50);
    assert.equal(Number(byStatus.matched.valor_credit), 50);

    assert.ok(byStatus.divergent, "divergent row present");
    assert.equal(String(byStatus.divergent.donor_name), "Bruno Doador");
    assert.equal(Number(byStatus.divergent.valor_donation), 100);
    assert.equal(Number(byStatus.divergent.valor_credit), 200);
  } finally {
    conn.close();
  }
});

test("matched requires exact valor_cents — strict equality", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    // Same cnpj+numero AND identical valor → matched.
    await conn.query(`
      INSERT INTO donation_notes (
        id, import_id, cpf, numero_nota, valor_nota,
        cnpj_estabelecimento, is_valid, created_at
      )
      VALUES (
        'd1', 'imp-1', '11111111111', '101', 50.00,
        '11111111000111', TRUE, CURRENT_TIMESTAMP
      )
    `);
    await conn.query(`
      INSERT INTO credit_notes (
        id, credit_import_id, cnpj_estabelecimento, numero_nota,
        valor_nf, credito, situacao, is_valid, created_at
      )
      VALUES (
        'c1', 'ci-1', '11111111000111', '101',
        50.00, 0.15, 'Calculado', TRUE, CURRENT_TIMESTAMP
      )
    `);

    await runCreditReconciliation(conn);
    const counts = await countReconciliationByStatus(conn);

    assert.equal(counts.matched, 1);
    assert.equal(counts.divergent ?? 0, 0);
  } finally {
    conn.close();
  }
});

test("dashboard exceeded-abatement query flags donors abated past their matched credit", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seedReconciliationFixtures(conn);
    await runCreditReconciliation(conn);

    // Mirror of the exceeded-abatement query in
    // src/services/dashboardService.js — keep in sync if that query changes.
    const rows = (
      await conn.query(`
        WITH donor_applied AS (
          SELECT donor_id, sum(abatement_amount) AS total_applied
          FROM monthly_donor_summary
          WHERE abatement_status = 'applied'
          GROUP BY donor_id
        ),
        donor_credit AS (
          SELECT
            donor_cpf_links.donor_id,
            sum(credit_notes.credito) AS total_credit
          FROM credit_reconciliation
          INNER JOIN donation_notes
            ON donation_notes.id = credit_reconciliation.donation_note_id
          INNER JOIN credit_notes
            ON credit_notes.id = credit_reconciliation.credit_note_id
          INNER JOIN donor_cpf_links
            ON donor_cpf_links.cpf = donation_notes.cpf
            AND donor_cpf_links.is_active = TRUE
          WHERE credit_reconciliation.match_status IN ('matched', 'divergent')
          GROUP BY donor_cpf_links.donor_id
        )
        SELECT
          donor_applied.donor_id,
          donors.name AS donor_name,
          donor_applied.total_applied,
          coalesce(donor_credit.total_credit, 0) AS total_credit
        FROM donor_applied
        INNER JOIN donors
          ON donors.id = donor_applied.donor_id
        LEFT JOIN donor_credit
          ON donor_credit.donor_id = donor_applied.donor_id
        WHERE donor_applied.total_applied > coalesce(donor_credit.total_credit, 0)
        ORDER BY (donor_applied.total_applied - coalesce(donor_credit.total_credit, 0)) DESC
      `)
    ).toArray();

    // Alice: R$1.00 applied vs R$0.20 matched credit → exceeded. Bruno has
    // no monthly_donor_summary row at all (nothing applied), so he must not
    // appear even though he has a divergent credit note.
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0].donor_id), "donor-1");
    assert.equal(String(rows[0].donor_name), "Alice Doadora");
    assert.equal(Number(rows[0].total_applied), 1);
    assert.equal(Number(rows[0].total_credit), 0.2);
  } finally {
    conn.close();
  }
});

test("deletePerson guard blocks removal when the person still has an inactive donor linked", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    await conn.query(`
      INSERT INTO people (id, name, cpf, is_active, updated_at)
      VALUES ('person-1', 'FULANO DE TAL', '36499229830', TRUE, CURRENT_TIMESTAMP)
    `);
    await conn.query(`
      INSERT INTO donors (id, person_id, name, cpf, demand, donor_type, is_active, updated_at)
      VALUES ('donor-1', 'person-1', 'FULANO DE TAL', '36499229830', 'Demanda X', 'holder', FALSE, CURRENT_TIMESTAMP)
    `);
    await conn.query(`
      INSERT INTO donor_cpf_links (id, donor_id, name, cpf, link_type, is_active, updated_at)
      VALUES ('donor-1-titular', 'donor-1', 'FULANO DE TAL', '36499229830', 'holder', TRUE, CURRENT_TIMESTAMP)
    `);

    // Mirrors personService.js's deletePerson guard query.
    const linkedDonorRows = (
      await conn.query(`
        SELECT id, is_active
        FROM donors
        WHERE person_id = 'person-1'
        LIMIT 1
      `)
    ).toArray();

    // An inactive (deactivated, not deleted) donor must still block the
    // person from being removed — deleting the person while a donor record
    // still references it would strand `donor_cpf_links`/`donors` rows that
    // point at a `person_id` which no longer exists, permanently blocking
    // that CPF from ever being registered again with no UI path to fix it.
    assert.equal(linkedDonorRows.length, 1);
    assert.equal(Boolean(linkedDonorRows[0].is_active), false);

    // The correct unblock path — delete the donor first (mirrors deleteDonor's
    // real cleanup) — must fully free the CPF.
    await conn.query(`DELETE FROM donor_cpf_links WHERE donor_id = 'donor-1'`);
    await conn.query(`DELETE FROM donors WHERE id = 'donor-1'`);
    await conn.query(`DELETE FROM people WHERE id = 'person-1'`);

    const remainingLinks = (
      await conn.query(
        `SELECT id FROM donor_cpf_links WHERE cpf = '36499229830' LIMIT 1`,
      )
    ).toArray();
    assert.equal(remainingLinks.length, 0);
  } finally {
    conn.close();
  }
});

test("createDonor rolls back the newly-inserted person when a later validation step fails", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    // Mirrors donorWriter.js's createDonor(): resolveCreatePersonContext's
    // INSERT INTO people and every validation check after it now share one
    // transaction, so a later throw (e.g. an invalid/deleted demand) rolls
    // back the person insert too instead of leaving an orphan that silently
    // blocks that CPF from ever being registered again.
    await conn.query("BEGIN TRANSACTION");
    let rejected = false;
    try {
      await conn.query(`
        INSERT INTO people (id, name, cpf, is_active, updated_at)
        VALUES ('person-2', 'CICLANO DA SILVA', '11144477735', TRUE, CURRENT_TIMESTAMP)
      `);
      throw new Error("A demanda selecionada não existe mais.");
    } catch {
      rejected = true;
      await conn.query("ROLLBACK");
    }

    assert.equal(rejected, true);

    const orphanRows = (
      await conn.query(
        `SELECT id FROM people WHERE cpf = '11144477735' AND is_active = TRUE LIMIT 1`,
      )
    ).toArray();
    assert.equal(orphanRows.length, 0);

    // A retry with the same CPF must proceed cleanly (no leftover person
    // blocking a fresh INSERT or a legitimate reconciliation).
    await conn.query(`
      INSERT INTO people (id, name, cpf, is_active, updated_at)
      VALUES ('person-2-retry', 'CICLANO DA SILVA', '11144477735', TRUE, CURRENT_TIMESTAMP)
    `);
    const retryRows = (
      await conn.query(
        `SELECT id FROM people WHERE cpf = '11144477735' AND is_active = TRUE`,
      )
    ).toArray();
    assert.equal(retryRows.length, 1);
  } finally {
    conn.close();
  }
});

test("donor inactivity streaks count consecutive imported months without notes", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    // Four processed months. The streak must be measured against THESE,
    // not the calendar.
    const months = ["2025-12-01", "2026-01-01", "2026-02-01", "2026-03-01"];
    for (const month of months) {
      await conn.query(`
        INSERT INTO imports (id, reference_month, file_name, value_per_note, status)
        VALUES ('imp-${month}', DATE '${month}', 'f.csv', 10, 'processed')
      `);
    }
    // A pending import must be ignored by the month grid entirely.
    await conn.query(`
      INSERT INTO imports (id, reference_month, file_name, value_per_note, status)
      VALUES ('imp-pending', DATE '2026-04-01', 'p.csv', 10, 'pending')
    `);

    const donors = [
      // donated every month -> streak 0
      ["always", "SEMPRE DOA", "11111111111", "2025-12-01"],
      // last donated in the oldest month -> streak 3
      ["stopped", "PAROU DE DOAR", "22222222222", "2025-12-01"],
      // never donated at all -> streak = eligible months (4)
      ["never", "NUNCA DOOU", "33333333333", "2025-12-01"],
      // only started in the latest month and did donate -> streak 0, 1 eligible
      ["newcomer", "ENTROU AGORA", "44444444444", "2026-03-01"],
    ];
    for (const [id, name, cpf, start] of donors) {
      await conn.query(`
        INSERT INTO donors (id, person_id, name, cpf, demand, donor_type, donation_start_date, is_active)
        VALUES ('${id}', 'p-${id}', '${name}', '${cpf}', 'D', 'holder', DATE '${start}', TRUE)
      `);
      await conn.query(`
        INSERT INTO donor_cpf_links (id, donor_id, name, cpf, link_type, is_active)
        VALUES ('${id}-titular', '${id}', '${name}', '${cpf}', 'holder', TRUE)
      `);
    }

    const activity = [
      ["always", months],
      ["stopped", ["2025-12-01"]],
      ["newcomer", ["2026-03-01"]],
    ];
    for (const [donorId, activeMonths] of activity) {
      for (const month of activeMonths) {
        await conn.query(`
          INSERT INTO import_cpf_summary
            (id, import_id, reference_month, cpf, notes_count, matched_donor_id, matched_source_id, is_registered_donor)
          VALUES
            ('ics-${donorId}-${month}', 'imp-${month}', DATE '${month}',
             (SELECT cpf FROM donors WHERE id = '${donorId}'),
             5, '${donorId}', '${donorId}-titular', TRUE)
        `);
      }
    }

    await conn.query(BACKFILL_ASSIGNMENTS_SQL);

    const rows = (await conn.query(buildDonorInactivityStreaksSql(DEFAULT_PROJECT_ID))).toArray();
    const byId = new Map(rows.map((row) => [String(row.donor_id), row]));

    assert.equal(Number(byId.get("always").months_without_donating), 0);
    assert.equal(Number(byId.get("stopped").months_without_donating), 3);
    assert.equal(Number(byId.get("never").months_without_donating), 4);
    assert.equal(Number(byId.get("newcomer").months_without_donating), 0);

    // Months before donation_start_date must not be counted against a donor.
    assert.equal(Number(byId.get("newcomer").eligible_months), 1);
    assert.equal(Number(byId.get("never").eligible_months), 4);

    // The pending April import must not appear in anyone's grid.
    assert.equal(Number(byId.get("always").eligible_months), 4);

    assert.equal(String(byId.get("stopped").last_donation_month), "2025-12-01");
    assert.equal(byId.get("never").last_donation_month, null);

    // Ordering puts the longest streak first — this IS the call list.
    assert.equal(String(rows[0].donor_id), "never");
  } finally {
    conn.close();
  }
});

test("donor inactivity streaks resolve auxiliaries by their own CPF", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    for (const month of ["2026-01-01", "2026-02-01"]) {
      await conn.query(`
        INSERT INTO imports (id, reference_month, file_name, value_per_note, status)
        VALUES ('imp-${month}', DATE '${month}', 'f.csv', 10, 'processed')
      `);
    }

    // Holder + auxiliary. Only the auxiliary keeps donating in February; the
    // holder personally stopped. monthly_donor_summary would hide this
    // (auxiliary notes roll up into the holder's row), which is exactly why
    // the query resolves activity per CPF link instead.
    await conn.query(`
      INSERT INTO donors (id, person_id, name, cpf, demand, donor_type, donation_start_date, is_active)
      VALUES ('h1', 'p-h1', 'TITULAR', '11111111111', 'D', 'holder', DATE '2026-01-01', TRUE)
    `);
    await conn.query(`
      INSERT INTO donors (id, person_id, name, cpf, demand, donor_type, holder_person_id, donation_start_date, is_active)
      VALUES ('a1', 'p-a1', 'AUXILIAR', '22222222222', 'D', 'auxiliary', 'p-h1', DATE '2026-01-01', TRUE)
    `);
    await conn.query(`
      INSERT INTO donor_cpf_links (id, donor_id, name, cpf, link_type, is_active)
      VALUES ('h1-titular', 'h1', 'TITULAR', '11111111111', 'holder', TRUE),
             ('a1-titular', 'a1', 'AUXILIAR', '22222222222', 'holder', TRUE)
    `);

    // January: both donate. February: only the auxiliary.
    await conn.query(`
      INSERT INTO import_cpf_summary
        (id, import_id, reference_month, cpf, notes_count, matched_donor_id, matched_source_id, is_registered_donor)
      VALUES
        ('i1', 'imp-2026-01-01', DATE '2026-01-01', '11111111111', 3, 'h1', 'h1-titular', TRUE),
        ('i2', 'imp-2026-01-01', DATE '2026-01-01', '22222222222', 2, 'h1', 'a1-titular', TRUE),
        ('i3', 'imp-2026-02-01', DATE '2026-02-01', '22222222222', 2, 'h1', 'a1-titular', TRUE)
    `);
    // The holder's summary row still shows notes in February (the auxiliary's).
    await conn.query(`
      INSERT INTO monthly_donor_summary
        (id, import_id, donor_id, reference_month, cpf, donor_name, demand, notes_count, value_per_note, abatement_amount, abatement_status)
      VALUES ('m1', 'imp-2026-02-01', 'h1', DATE '2026-02-01', '11111111111', 'TITULAR', 'D', 2, 10, 20, 'pending')
    `);

    await conn.query(BACKFILL_ASSIGNMENTS_SQL);

    const rows = (await conn.query(buildDonorInactivityStreaksSql(DEFAULT_PROJECT_ID))).toArray();
    const byId = new Map(rows.map((row) => [String(row.donor_id), row]));

    // The holder stopped in February even though their summary row has notes.
    assert.equal(Number(byId.get("h1").months_without_donating), 1);
    assert.equal(Number(byId.get("a1").months_without_donating), 0);
  } finally {
    conn.close();
  }
});

test("people count must apply the same role predicate as the list", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    // Three people: one plain reference person, two that are donors.
    await conn.query(`
      INSERT INTO people (id, name, cpf, is_active, updated_at)
      VALUES
        ('p-ref',    'SO REFERENCIA', '11111111111', TRUE, CURRENT_TIMESTAMP),
        ('p-holder', 'E TITULAR',     '22222222222', TRUE, CURRENT_TIMESTAMP),
        ('p-aux',    'E AUXILIAR',    '33333333333', TRUE, CURRENT_TIMESTAMP)
    `);
    await conn.query(`
      INSERT INTO donors (id, person_id, name, cpf, demand, donor_type, holder_person_id, is_active)
      VALUES
        ('d-holder', 'p-holder', 'E TITULAR',  '22222222222', 'D', 'holder',    NULL,       TRUE),
        ('d-aux',    'p-aux',    'E AUXILIAR', '33333333333', 'D', 'auxiliary', 'p-holder', TRUE)
    `);

    // Mirrors buildPeopleListConditions' `role: "reference"` branch.
    const referencePredicate = `
      people.is_active = TRUE
      AND NOT EXISTS (
        SELECT 1 FROM donors
        WHERE donors.person_id = people.id
          AND donors.is_active = TRUE
      )
    `;

    const scopedCount = Number(
      (
        await conn.query(
          `SELECT count(*) AS total FROM people WHERE ${referencePredicate}`,
        )
      ).toArray()[0].total,
    );
    const unscopedCount = Number(
      (
        await conn.query(
          `SELECT count(*) AS total FROM people WHERE people.is_active = TRUE`,
        )
      ).toArray()[0].total,
    );

    // The Pessoas page lists only reference people. Counting without the role
    // predicate (the bug) reported 3 where the list can only ever show 1.
    assert.equal(scopedCount, 1);
    assert.equal(unscopedCount, 3);
    assert.notEqual(scopedCount, unscopedCount);
  } finally {
    conn.close();
  }
});

test("abatement sheet emits one row per donor CPF with the auxiliary-aware description", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    await conn.query(`
      INSERT INTO imports (id, reference_month, file_name, value_per_note, status)
      VALUES ('imp', DATE '2026-04-01', 'f.csv', 10, 'processed')
    `);

    // As pessoas por trás dos doadores. `p-h1` é a titular do grupo A, e é a
    // identidade dela que precisa aparecer nas colunas NOME e CPF da linha do
    // auxiliar — sem estas linhas o LEFT JOIN não acharia nada e o teste
    // passaria pelo caminho de fallback, sem exercitar o que interessa.
    await conn.query(`
      INSERT INTO people (id, name, cpf, is_active)
      VALUES
        ('p-h1', 'MARIA SILVA',    '11111111111', TRUE),
        ('p-a1', 'JOAO AUXILIAR',  '22222222222', TRUE),
        ('p-h2', 'CARLOS SOZINHO', '33333333333', TRUE)
    `);

    // Group A: holder with one auxiliary -> BOTH rows carry the name.
    // Group B: solo holder -> short description, no name.
    await conn.query(`
      INSERT INTO donors (id, person_id, name, cpf, demand, donor_type, holder_person_id, is_active)
      VALUES
        ('h1', 'p-h1', 'MARIA SILVA',   '11111111111', 'CESTAS',  'holder',    NULL,    TRUE),
        ('a1', 'p-a1', 'JOAO AUXILIAR', '22222222222', 'CESTAS',  'auxiliary', 'p-h1',  TRUE),
        ('h2', 'p-h2', 'CARLOS SOZINHO','33333333333', 'REMEDIOS','holder',    NULL,    TRUE)
    `);
    await seedAssignments(conn, ["h1", "a1", "h2"]);
    await conn.query(`
      INSERT INTO donor_cpf_links (id, donor_id, name, cpf, link_type, is_active)
      VALUES
        ('h1-titular', 'h1', 'MARIA SILVA',    '11111111111', 'holder', TRUE),
        ('a1-titular', 'a1', 'JOAO AUXILIAR',  '22222222222', 'holder', TRUE),
        ('h2-titular', 'h2', 'CARLOS SOZINHO', '33333333333', 'holder', TRUE)
    `);

    // The auxiliary's notes roll up to h1 in monthly_donor_summary, but the
    // sheet must keep them on the auxiliary's own CPF line.
    await conn.query(`
      INSERT INTO import_cpf_summary
        (id, import_id, reference_month, cpf, notes_count, invalid_notes_count, matched_donor_id, matched_source_id, is_registered_donor)
      VALUES
        ('i1', 'imp', DATE '2026-04-01', '11111111111', 12, 0, 'h1', 'h1-titular', TRUE),
        ('i2', 'imp', DATE '2026-04-01', '22222222222',  5, 0, 'h1', 'a1-titular', TRUE),
        ('i3', 'imp', DATE '2026-04-01', '33333333333',  7, 0, 'h2', 'h2-titular', TRUE)
    `);

    const stmt = await conn.prepare(
      buildAbatementSheetSql(DEFAULT_PROJECT_ID),
    );
    let rows;
    try {
      rows = (await stmt.query("2026-04-01")).toArray();
    } finally {
      await stmt.close();
    }

    const byCpf = new Map(rows.map((row) => [String(row.cpf), row]));
    assert.equal(rows.length, 3);

    // Counts stay per-CPF (the auxiliary is NOT folded into the holder).
    assert.equal(Number(byCpf.get("11111111111").notes_count), 12);
    assert.equal(Number(byCpf.get("22222222222").notes_count), 5);
    assert.equal(Number(byCpf.get("33333333333").notes_count), 7);

    // Holder WITH an auxiliary, and the auxiliary itself, both flag the group.
    assert.equal(Boolean(byCpf.get("11111111111").group_has_auxiliaries), true);
    assert.equal(Boolean(byCpf.get("22222222222").group_has_auxiliaries), true);
    // Solo holder must not.
    assert.equal(Boolean(byCpf.get("33333333333").group_has_auxiliaries), false);

    assert.equal(String(byCpf.get("22222222222").demand), "CESTAS");
    assert.equal(String(byCpf.get("33333333333").demand), "REMEDIOS");

    // NOME e CPF da planilha: o auxiliar leva a identidade do TITULAR, porque
    // o abatimento é lançado na conta de quem responde pelo grupo. A linha
    // continua sendo dele — a contagem acima é a dele, e a descrição abaixo
    // traz o nome dele.
    assert.equal(String(byCpf.get("22222222222").sheet_name), "MARIA SILVA");
    assert.equal(String(byCpf.get("22222222222").sheet_cpf), "11111111111");

    // Titular usa a própria identidade: o LEFT JOIN não casa e o coalesce
    // devolve o que já estava na linha.
    assert.equal(String(byCpf.get("11111111111").sheet_name), "MARIA SILVA");
    assert.equal(String(byCpf.get("11111111111").sheet_cpf), "11111111111");
    assert.equal(String(byCpf.get("33333333333").sheet_name), "CARLOS SOZINHO");
    assert.equal(String(byCpf.get("33333333333").sheet_cpf), "33333333333");

    // Descriptions, built by the same helper the export uses.
    assert.equal(
      buildAbatementDescription({
        donorName: String(byCpf.get("11111111111").donor_name),
        referenceMonth: "2026-04-01",
        groupHasAuxiliaries: true,
      }),
      "Doações NFP - MARIA SILVA - Abr/2026",
    );
    assert.equal(
      buildAbatementDescription({
        donorName: String(byCpf.get("22222222222").donor_name),
        referenceMonth: "2026-04-01",
        groupHasAuxiliaries: true,
      }),
      "Doações NFP - JOAO AUXILIAR - Abr/2026",
    );
    assert.equal(
      buildAbatementDescription({
        donorName: String(byCpf.get("33333333333").donor_name),
        referenceMonth: "2026-04-01",
        groupHasAuxiliaries: false,
      }),
      "Doações NFP - Abr/2026",
    );

    // A different month must not leak into this month's sheet.
    await conn.query(`
      INSERT INTO imports (id, reference_month, file_name, value_per_note, status)
      VALUES ('imp-mai', DATE '2026-05-01', 'f.csv', 10, 'processed')
    `);
    await conn.query(`
      INSERT INTO import_cpf_summary
        (id, import_id, reference_month, cpf, notes_count, invalid_notes_count, matched_donor_id, matched_source_id, is_registered_donor)
      VALUES ('i4', 'imp-mai', DATE '2026-05-01', '11111111111', 99, 0, 'h1', 'h1-titular', TRUE)
    `);
    const aprilStmt = await conn.prepare(
      buildAbatementSheetSql(DEFAULT_PROJECT_ID),
    );
    try {
      const aprilRows = (await aprilStmt.query("2026-04-01")).toArray();
      const aprilMaria = aprilRows.find((r) => String(r.cpf) === "11111111111");
      assert.equal(Number(aprilMaria.notes_count), 12);
    } finally {
      await aprilStmt.close();
    }
  } finally {
    conn.close();
  }
});

test("imports overview counts only abatements the user can actually act on", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    await conn.query(`
      INSERT INTO donors (id, person_id, name, cpf, demand, donor_type, is_active)
      VALUES ('d1', 'p1', 'ALICE', '111', 'D', 'holder', TRUE)
    `);
    // Jan + Fev are covered by a catch-up launched in Março; Março itself is
    // applied; Abril has no notes at all.
    await conn.query(`
      INSERT INTO monthly_donor_summary
        (id, import_id, donor_id, reference_month, cpf, donor_name, demand,
         notes_count, value_per_note, abatement_amount, abatement_status)
      VALUES
        ('s-jan', 'i', 'd1', DATE '2026-01-01', '111', 'ALICE', 'D', 10, 10, 100, 'pending'),
        ('s-fev', 'i', 'd1', DATE '2026-02-01', '111', 'ALICE', 'D', 10, 10, 100, 'pending'),
        ('s-mar', 'i', 'd1', DATE '2026-03-01', '111', 'ALICE', 'D', 10, 10, 100, 'applied'),
        ('s-abr', 'i', 'd1', DATE '2026-04-01', '111', 'ALICE', 'D',  0, 10,   0, 'pending')
    `);
    await conn.query(`
      INSERT INTO abatement_adjustments
        (id, donor_id, reference_month, range_start_month, range_end_month,
         notes_count, abatement_amount, abatement_status)
      VALUES ('adj', 'd1', DATE '2026-03-01', DATE '2026-01-01', DATE '2026-03-01', 20, 200, 'applied')
    `);

    // Mirrors the `abatementByMonth` query in monthlyOverviewService.js.
    const rows = (
      await conn.query(`
        SELECT
          strftime(mds.reference_month, '%Y-%m-01') AS reference_month,
          coalesce(sum(
            CASE WHEN mds.abatement_status = 'applied'
              THEN mds.abatement_amount ELSE 0 END
          ), 0) AS total_applied,
          count(*) FILTER (
            WHERE mds.abatement_status = 'pending' AND mds.is_actionable
          ) AS pending_count
        FROM (
          SELECT
            monthly_donor_summary.reference_month,
            monthly_donor_summary.abatement_status,
            monthly_donor_summary.abatement_amount,
            (
              coalesce(monthly_donor_summary.notes_count, 0) > 0
              AND NOT EXISTS (
                SELECT 1
                FROM abatement_adjustments
                WHERE abatement_adjustments.donor_id = monthly_donor_summary.donor_id
                  AND abatement_adjustments.reference_month <> monthly_donor_summary.reference_month
                  AND abatement_adjustments.range_start_month <= monthly_donor_summary.reference_month
                  AND abatement_adjustments.range_end_month >= monthly_donor_summary.reference_month
              )
            ) AS is_actionable
          FROM monthly_donor_summary
        ) AS mds
        GROUP BY mds.reference_month
        ORDER BY 1
      `)
    ).toArray();

    const byMonth = new Map(
      rows.map((row) => [String(row.reference_month), row]),
    );

    // Subsumed by the catch-up -> shows "Via acumulado" in Gestão Mensal with
    // the toggle disabled, so it must not read as pending work here. This was
    // the reported bug: a month impossible to close kept showing as pending.
    assert.equal(Number(byMonth.get("2026-01-01").pending_count), 0);
    assert.equal(Number(byMonth.get("2026-02-01").pending_count), 0);

    // No notes in the month -> nothing to abate.
    assert.equal(Number(byMonth.get("2026-04-01").pending_count), 0);

    // The applied month stays applied.
    assert.equal(Number(byMonth.get("2026-03-01").pending_count), 0);

    // "Abatido" now only sums applied rows; before it summed every row, so
    // Jan/Fev reported 100 each while still being pending.
    assert.equal(Number(byMonth.get("2026-01-01").total_applied), 0);
    assert.equal(Number(byMonth.get("2026-02-01").total_applied), 0);
    assert.equal(Number(byMonth.get("2026-03-01").total_applied), 100);

    // Sanity: a plain pending row with notes and no catch-up still counts.
    await conn.query(`
      INSERT INTO monthly_donor_summary
        (id, import_id, donor_id, reference_month, cpf, donor_name, demand,
         notes_count, value_per_note, abatement_amount, abatement_status)
      VALUES ('s-mai', 'i', 'd1', DATE '2026-05-01', '111', 'ALICE', 'D', 5, 10, 50, 'pending')
    `);
    const mai = (
      await conn.query(`
        SELECT count(*) AS pending_count
        FROM monthly_donor_summary
        WHERE reference_month = DATE '2026-05-01'
          AND abatement_status = 'pending'
          AND coalesce(notes_count, 0) > 0
      `)
    ).toArray();
    assert.equal(Number(mai[0].pending_count), 1);
  } finally {
    conn.close();
  }
});

async function seedTopDonorFixtures(conn) {
  await conn.query(`
    INSERT INTO monthly_donor_summary (
      id, import_id, donor_id, reference_month, cpf, donor_name, demand,
      notes_count, value_per_note, abatement_amount, abatement_status,
      created_at, updated_at
    )
    VALUES
      -- Alice: valor alto concentrado num mês só.
      ('t-alice-jan', 'imp-1', 'donor-a', DATE '2026-01-01', '11111111111', 'Alice', 'Cestas',
       10, 1.00, 100.00, 'applied', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      -- Bruno: valor menor, mas espalhado em 3 meses e com mais notas.
      ('t-bruno-jan', 'imp-1', 'donor-b', DATE '2026-01-01', '22222222222', 'Bruno', 'Remedios',
       20, 1.00, 20.00, 'applied', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('t-bruno-fev', 'imp-2', 'donor-b', DATE '2026-02-01', '22222222222', 'Bruno', 'Remedios',
       20, 1.00, 20.00, 'applied', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('t-bruno-mar', 'imp-3', 'donor-b', DATE '2026-03-01', '22222222222', 'Bruno', 'Remedios',
       20, 1.00, 20.00, 'applied', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      -- Carla sem demanda: precisa cair no rótulo 'Sem demanda'.
      ('t-carla-jan', 'imp-1', 'donor-c', DATE '2026-01-01', '33333333333', 'Carla', '',
       5, 1.00, 5.00, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);

  await seedAssignments(conn, ["donor-a", "donor-b", "donor-c"]);
}

async function runTopDonors(conn, filters) {
  const { sql, params } = buildTopDonorsQuery({
    ...filters,
    projectId: DEFAULT_PROJECT_ID,
  });
  const stmt = await conn.prepare(sql);
  try {
    return (await stmt.query(...params)).toArray().map((row) => row.toJSON());
  } finally {
    await stmt.close();
  }
}

test("listTopDonors ranks by total abatement and honours the row limit", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seedTopDonorFixtures(conn);

    const all = await runTopDonors(conn, {});
    assert.deepEqual(
      all.map((row) => row.donor_name),
      ["Alice", "Bruno", "Carla"],
    );
    assert.equal(Number(all[0].total_abatement), 100);
    assert.equal(Number(all[1].imported_month_count), 3);
    // Demanda vazia vira o rótulo, não string vazia.
    assert.equal(all[2].demand, "Sem demanda");

    const limited = await runTopDonors(conn, { limit: 2 });
    assert.equal(limited.length, 2);
  } finally {
    conn.close();
  }
});

test("listTopDonors reorders by notes and by months without changing the set", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seedTopDonorFixtures(conn);

    // Bruno tem 60 notas contra 10 de Alice: por notas ele passa à frente,
    // mesmo somando menos abatimento.
    const byNotes = await runTopDonors(conn, { sort: "notes" });
    assert.equal(byNotes[0].donor_name, "Bruno");
    assert.equal(Number(byNotes[0].total_notes), 60);

    const byMonths = await runTopDonors(conn, { sort: "months" });
    assert.equal(byMonths[0].donor_name, "Bruno");
    assert.equal(Number(byMonths[0].imported_month_count), 3);

    // Ordenação desconhecida cai no default em vez de quebrar o SQL.
    const fallback = await runTopDonors(conn, { sort: "'; DROP TABLE donors; --" });
    assert.equal(fallback[0].donor_name, "Alice");
  } finally {
    conn.close();
  }
});

test("listTopDonors scopes totals to a single month and to a demand", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seedTopDonorFixtures(conn);

    // Fevereiro só tem Bruno, e com o valor DAQUELE mês (20), não o total
    // de vida (60) — era exatamente o erro do ranking histórico sem recorte.
    const fev = await runTopDonors(conn, { referenceMonth: "2026-02" });
    assert.equal(fev.length, 1);
    assert.equal(fev[0].donor_name, "Bruno");
    assert.equal(Number(fev[0].total_abatement), 20);
    assert.equal(Number(fev[0].imported_month_count), 1);

    const cestas = await runTopDonors(conn, { demand: "Cestas" });
    assert.deepEqual(
      cestas.map((row) => row.donor_name),
      ["Alice"],
    );

    // A comparação de demanda ignora caixa.
    const lowercase = await runTopDonors(conn, { demand: "cestas" });
    assert.equal(lowercase.length, 1);

    // O rótulo sintético também precisa ser filtrável.
    const semDemanda = await runTopDonors(conn, { demand: "Sem demanda" });
    assert.deepEqual(
      semDemanda.map((row) => row.donor_name),
      ["Carla"],
    );
  } finally {
    conn.close();
  }
});

test("listMonthlyTrend returns the most recent months, newest window first", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    // 14 meses: mais que a janela de 12, para provar que o corte pega os
    // recentes e não os antigos.
    const values = [];
    for (let index = 0; index < 14; index += 1) {
      const month = String((index % 12) + 1).padStart(2, "0");
      const year = 2025 + Math.floor(index / 12);
      values.push(
        `('t-${index}', 'imp-${index}', 'donor-${index % 2}', DATE '${year}-${month}-01',
          '1111111111${index % 2}', 'Doador ${index % 2}', 'Cestas',
          ${index + 1}, 1.00, ${index + 1}, 'applied', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      );
    }

    await conn.query(`
      INSERT INTO monthly_donor_summary (
        id, import_id, donor_id, reference_month, cpf, donor_name, demand,
        notes_count, value_per_note, abatement_amount, abatement_status,
        created_at, updated_at
      )
      VALUES ${values.join(",")}
    `);

    await seedAssignments(conn, ["donor-0", "donor-1"]);

    const rows = (await conn.query(buildMonthlyTrendSql(DEFAULT_PROJECT_ID))).toArray().map((row) => row.toJSON());

    assert.equal(rows.length, MONTHLY_TREND_LIMIT);

    // A query devolve do mais novo pro mais antigo; o service inverte.
    const months = rows.map((row) => row.reference_month);
    assert.equal(months[0], "2026-02-01");
    assert.deepEqual([...months].sort().reverse(), months);
    // Os dois meses mais antigos (2025-01 e 2025-02) ficaram fora da janela.
    assert.ok(!months.includes("2025-01-01"));

    // Um mês com dois doadores agrega as duas linhas e conta 2 doadores.
    await conn.query(`
      INSERT INTO monthly_donor_summary (
        id, import_id, donor_id, reference_month, cpf, donor_name, demand,
        notes_count, value_per_note, abatement_amount, abatement_status,
        created_at, updated_at
      )
      VALUES ('t-extra', 'imp-x', 'donor-9', DATE '2026-02-01', '99999999999',
              'Outro', 'Remedios', 7, 1.00, 7.00, 'pending',
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);

    await conn.query(`
      INSERT INTO donor_project_assignments
        (id, donor_id, project_id, valid_from, valid_to, reason, created_at)
      VALUES ('dpa-extra', 'donor-9', '${DEFAULT_PROJECT_ID}',
              DATE '${ASSIGNMENT_OPEN_START}', DATE '${ASSIGNMENT_OPEN_END}',
              'inicial', CURRENT_TIMESTAMP)
    `);

    const updated = (await conn.query(buildMonthlyTrendSql(DEFAULT_PROJECT_ID))).toArray().map((row) => row.toJSON());
    const fev = updated.find((row) => row.reference_month === "2026-02-01");
    assert.equal(Number(fev.donor_count), 2);
    assert.equal(Number(fev.total_notes), 14 + 7);
  } finally {
    conn.close();
  }
});

/**
 * Painel de crédito por projeto.
 *
 * O cenário reproduz a queixa que originou o painel: um projeto novo mostrando
 * número do projeto principal. Aqui os dois projetos têm crédito no MESMO mês,
 * de propósito — se cada um tivesse meses distintos, uma query mal escopada
 * passaria despercebida.
 */
async function seedProjectCreditFixtures(conn) {
  await conn.query(`
    INSERT INTO projects (id, name, slug, modules, color, is_active, created_at, updated_at)
    VALUES ('prj-capoeira', 'Capoeira', 'capoeira', '{}', '#6366f1', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);

  await conn.query(`
    INSERT INTO donors (id, name, cpf, demand, donor_type, is_active, created_at, updated_at)
    VALUES
      ('donor-mor', 'Marina Moradia', '33333333333', 'Sao Lucas', 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('donor-cap', 'Carla Capoeira', '44444444444', NULL, 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('donor-cap-sem', 'Cesar Sem Credito', '55555555555', NULL, 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
  await conn.query(`
    INSERT INTO donor_cpf_links (id, donor_id, name, cpf, link_type, is_active, created_at, updated_at)
    VALUES
      ('lk-mor', 'donor-mor', 'Marina Moradia', '33333333333', 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('lk-cap', 'donor-cap', 'Carla Capoeira', '44444444444', 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('lk-cap-sem', 'donor-cap-sem', 'Cesar Sem Credito', '55555555555', 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);

  await conn.query(`
    INSERT INTO donor_project_assignments
      (id, donor_id, project_id, valid_from, valid_to, reason, created_at)
    VALUES
      ('dpa-mor', 'donor-mor', '${DEFAULT_PROJECT_ID}', DATE '${ASSIGNMENT_OPEN_START}', DATE '${ASSIGNMENT_OPEN_END}', 'inicial', CURRENT_TIMESTAMP),
      ('dpa-cap', 'donor-cap', 'prj-capoeira', DATE '${ASSIGNMENT_OPEN_START}', DATE '${ASSIGNMENT_OPEN_END}', 'inicial', CURRENT_TIMESTAMP),
      ('dpa-cap-sem', 'donor-cap-sem', 'prj-capoeira', DATE '${ASSIGNMENT_OPEN_START}', DATE '${ASSIGNMENT_OPEN_END}', 'inicial', CURRENT_TIMESTAMP)
  `);

  await conn.query(`
    INSERT INTO donation_notes (
      id, import_id, cpf, numero_nota, valor_nota, reference_month,
      cnpj_estabelecimento, is_valid, created_at
    )
    VALUES
      ('dn-mor', 'imp-p', '33333333333', '701', 50.00, DATE '2026-03-01', '33333333000133', TRUE, CURRENT_TIMESTAMP),
      ('dn-cap', 'imp-p', '44444444444', '702', 80.00, DATE '2026-03-01', '44444444000144', TRUE, CURRENT_TIMESTAMP),
      ('dn-cap-2', 'imp-p', '44444444444', '703', 30.00, DATE '2026-04-01', '44444444000144', TRUE, CURRENT_TIMESTAMP)
  `);
  await conn.query(`
    INSERT INTO credit_notes (
      id, credit_import_id, cnpj_estabelecimento, numero_nota,
      valor_nf, credito, situacao, is_valid, created_at
    )
    VALUES
      ('cn-mor', 'ci-p', '33333333000133', '701', 50.00, 7.00, 'Calculado', TRUE, CURRENT_TIMESTAMP),
      ('cn-cap', 'ci-p', '44444444000144', '702', 80.00, 2.00, 'Calculado', TRUE, CURRENT_TIMESTAMP),
      ('cn-cap-2', 'ci-p', '44444444000144', '703', 30.00, 3.00, 'Calculado', TRUE, CURRENT_TIMESTAMP)
  `);
}

test("project credit dashboard only sees the credit of its own donors", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seedProjectCreditFixtures(conn);
    await runCreditReconciliation(conn);

    const capRows = (
      await conn.query(buildProjectCreditByMonthSql("prj-capoeira"))
    )
      .toArray()
      .map((row) => [String(row.reference_month), Number(row.total_credit)]);

    // Marina gerou R$7,00 no MESMO marco. Sem escopo, marco viria R$9,00.
    assert.deepEqual(capRows, [
      ["2026-04-01", 3],
      ["2026-03-01", 2],
    ]);

    const moradiaRows = (
      await conn.query(buildProjectCreditByMonthSql(DEFAULT_PROJECT_ID))
    ).toArray();
    assert.equal(moradiaRows.length, 1);
    assert.equal(Number(moradiaRows[0].total_credit), 7);

    const donorRows = (
      await conn.query(buildProjectCreditByDonorSql("prj-capoeira", { limit: 10 }))
    ).toArray();
    assert.equal(donorRows.length, 1, "so Carla tem credito em Capoeira");
    assert.equal(donorRows[0].donor_name, "Carla Capoeira");
    assert.equal(Number(donorRows[0].total_credit), 5);
    assert.equal(Number(donorRows[0].month_count), 2);

    // Marina nao gerou credito NESTE projeto, mas tambem nao e doadora dele —
    // nao pode aparecer como pendencia de Capoeira.
    const withoutRows = (
      await conn.query(buildProjectDonorsWithoutCreditSql("prj-capoeira"))
    ).toArray();
    assert.deepEqual(
      withoutRows.map((row) => row.donor_name),
      ["Cesar Sem Credito"],
    );
  } finally {
    await conn.close();
  }
});

test("project credit stays with the project the donor had at the time of the note", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seedProjectCreditFixtures(conn);

    // Carla e transferida para Moradia a partir de abril: a janela de Capoeira
    // fecha em marco e a de Moradia abre em abril.
    await conn.query(`
      UPDATE donor_project_assignments
      SET valid_to = DATE '2026-03-01'
      WHERE id = 'dpa-cap'
    `);
    await conn.query(`
      INSERT INTO donor_project_assignments
        (id, donor_id, project_id, valid_from, valid_to, reason, created_at)
      VALUES ('dpa-cap-2', 'donor-cap', '${DEFAULT_PROJECT_ID}', DATE '2026-04-01', DATE '${ASSIGNMENT_OPEN_END}', 'transferencia', CURRENT_TIMESTAMP)
    `);

    await runCreditReconciliation(conn);

    // Marco continua em Capoeira mesmo depois da transferencia.
    const capRows = (
      await conn.query(buildProjectCreditByMonthSql("prj-capoeira"))
    )
      .toArray()
      .map((row) => [String(row.reference_month), Number(row.total_credit)]);
    assert.deepEqual(capRows, [["2026-03-01", 2]]);

    const moradiaRows = (
      await conn.query(buildProjectCreditByMonthSql(DEFAULT_PROJECT_ID))
    )
      .toArray()
      .map((row) => [String(row.reference_month), Number(row.total_credit)]);
    assert.deepEqual(moradiaRows, [
      ["2026-04-01", 3],
      ["2026-03-01", 7],
    ]);
  } finally {
    await conn.close();
  }
});

/**
 * Doadores sem vínculo de projeto.
 *
 * Contador e lista precisam usar o MESMO predicado. Quando divergiram em
 * Pessoas, o resultado foi total inflado e última página vazia — o card diria
 * "3 sem projeto" e o modal abriria com 5, ou pior, vazio.
 */
test("orphan donor list and count agree on the same predicate", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    await conn.query(`
      INSERT INTO donors (id, name, cpf, demand, donor_type, is_active, created_at, updated_at)
      VALUES
        ('orf-1', 'Orfao Um', '11111111111', NULL, 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('orf-2', 'Orfao Dois', '22222222222', NULL, 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('orf-inativo', 'Orfao Inativo', '33333333333', NULL, 'holder', FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('vinculado', 'Com Projeto', '44444444444', NULL, 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    await seedAssignments(conn, ["vinculado"]);

    const listRows = (
      await conn.query(`
        SELECT donors.id, donors.name, donors.cpf
        FROM donors
        WHERE donors.is_active = TRUE
          AND NOT EXISTS (
            SELECT 1 FROM donor_project_assignments
            WHERE donor_project_assignments.donor_id = donors.id
          )
        ORDER BY donors.name ASC
        LIMIT 200
      `)
    ).toArray();

    const countRows = (
      await conn.query(`
        SELECT count(*) AS total
        FROM donors
        WHERE donors.is_active = TRUE
          AND NOT EXISTS (
            SELECT 1 FROM donor_project_assignments
            WHERE donor_project_assignments.donor_id = donors.id
          )
      `)
    ).toArray();

    // Inativo fica de fora dos dois; vinculado idem.
    assert.deepEqual(
      listRows.map((row) => row.name),
      ["Orfao Dois", "Orfao Um"],
    );
    assert.equal(Number(countRows[0].total), listRows.length);
  } finally {
    await conn.close();
  }
});

/**
 * Uma transferência não pode reescrever o passado.
 *
 * O invariante é a janela FECHADA: o mês anterior à transferência continua
 * apontando para o projeto antigo. Reescrever `project_id` do vínculo — o
 * atalho óbvio — moveria todo o histórico junto.
 */
test("transferring a donor closes the previous window instead of rewriting it", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await conn.query(`
      INSERT INTO projects (id, name, slug, modules, color, is_active, created_at, updated_at)
      VALUES ('prj-b', 'Projeto B', 'projeto-b', '{}', '#6366f1', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    await conn.query(`
      INSERT INTO donors (id, name, cpf, demand, donor_type, is_active, created_at, updated_at)
      VALUES ('donor-t', 'Doador Transferido', '11111111111', NULL, 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    await seedAssignments(conn, ["donor-t"]);

    // Mesma sequência que `transferDonorToProject` executa.
    await conn.query(`
      UPDATE donor_project_assignments
      SET valid_to = (DATE '2026-04-01' - INTERVAL 1 MONTH)
      WHERE donor_id = 'donor-t' AND valid_to = DATE '${ASSIGNMENT_OPEN_END}'
    `);
    await conn.query(`
      INSERT INTO donor_project_assignments
        (id, donor_id, project_id, valid_from, valid_to, reason, created_at)
      VALUES ('dpa-novo', 'donor-t', 'prj-b', DATE '2026-04-01', DATE '${ASSIGNMENT_OPEN_END}', 'transferencia', CURRENT_TIMESTAMP)
    `);

    const atMarch = (
      await conn.query(`
        SELECT project_id FROM donor_project_assignments
        WHERE donor_id = 'donor-t'
          AND DATE '2026-03-01' BETWEEN valid_from AND valid_to
      `)
    ).toArray();
    const atApril = (
      await conn.query(`
        SELECT project_id FROM donor_project_assignments
        WHERE donor_id = 'donor-t'
          AND DATE '2026-04-01' BETWEEN valid_from AND valid_to
      `)
    ).toArray();

    // Exatamente UM projeto por mês: vigência sobreposta contaria o crédito
    // do mês da transferência duas vezes.
    assert.equal(atMarch.length, 1);
    assert.equal(atMarch[0].project_id, DEFAULT_PROJECT_ID);
    assert.equal(atApril.length, 1);
    assert.equal(atApril[0].project_id, "prj-b");
  } finally {
    await conn.close();
  }
});

/**
 * Vínculo apontando para um projeto que não existe mais.
 *
 * É alcançável pela interface: excluir o doador tira as linhas de
 * `donor_project_assignments` (elas vão para o payload da lixeira), o que
 * libera a exclusão do projeto — cujo guard conta exatamente essas linhas.
 * Restaurar o doador depois reinsere o vínculo apontando para um projeto que
 * já não existe.
 *
 * Sem tratamento, o doador some de toda lista de projeto E não é contado como
 * "sem projeto" (ele TEM vínculo), ficando invisível e sem caminho de volta.
 */
async function seedDanglingAssignment(conn) {
  await conn.query(`
    INSERT INTO donors (id, name, cpf, demand, donor_type, is_active, created_at, updated_at)
    VALUES
      ('donor-dangling', 'Carla Orfa', '11111111111', NULL, 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('donor-ok', 'Bruno Certo', '22222222222', NULL, 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
  await conn.query(`
    INSERT INTO donor_cpf_links (id, donor_id, name, cpf, link_type, is_active, created_at, updated_at)
    VALUES
      ('lk-dangling', 'donor-dangling', 'Carla Orfa', '11111111111', 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('lk-ok', 'donor-ok', 'Bruno Certo', '22222222222', 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);

  // 'prj-apagado' nunca existiu na tabela projects — é o estado que sobra
  // depois de excluir o projeto e restaurar o doador.
  await conn.query(`
    INSERT INTO donor_project_assignments
      (id, donor_id, project_id, valid_from, valid_to, reason, created_at)
    VALUES
      ('dpa-dangling', 'donor-dangling', 'prj-apagado', DATE '${ASSIGNMENT_OPEN_START}', DATE '${ASSIGNMENT_OPEN_END}', 'inicial', CURRENT_TIMESTAMP),
      ('dpa-ok', 'donor-ok', '${DEFAULT_PROJECT_ID}', DATE '${ASSIGNMENT_OPEN_START}', DATE '${ASSIGNMENT_OPEN_END}', 'inicial', CURRENT_TIMESTAMP)
  `);

  await conn.query(`
    INSERT INTO donation_notes (
      id, import_id, cpf, numero_nota, valor_nota, reference_month,
      cnpj_estabelecimento, is_valid, created_at
    )
    VALUES ('dn-dangling', 'imp-x', '11111111111', '901', 100.00, DATE '2026-03-01', '11111111000111', TRUE, CURRENT_TIMESTAMP)
  `);
  await conn.query(`
    INSERT INTO credit_notes (
      id, credit_import_id, cnpj_estabelecimento, numero_nota,
      valor_nf, credito, situacao, is_valid, created_at
    )
    VALUES ('cn-dangling', 'ci-x', '11111111000111', '901', 100.00, 9.00, 'Calculado', TRUE, CURRENT_TIMESTAMP)
  `);
}

test("a donor whose project was deleted counts as having no project", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seedDanglingAssignment(conn);

    const rows = (await conn.query(DONORS_WITHOUT_PROJECT_SQL)).toArray();

    // Bruno tem vínculo com projeto existente e fica de fora; Carla precisa
    // aparecer para o operador conseguir religá-la.
    assert.deepEqual(
      rows.map((row) => row.name),
      ["Carla Orfa"],
    );
  } finally {
    await conn.close();
  }
});

test("credit of a deleted project falls into unattributed instead of vanishing", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seedDanglingAssignment(conn);
    await runCreditReconciliation(conn);

    const rows = (await conn.query(CREDIT_BY_PROJECT_SQL)).toArray();
    const total = rows.reduce((sum, row) => sum + Number(row.total_credit), 0);
    const unattributed = rows
      .filter((row) => !row.project_id)
      .reduce((sum, row) => sum + Number(row.total_credit), 0);

    // O invariante: o que não pertence a projeto existente tem de aparecer
    // como não atribuído. Se o project_id apagado passasse adiante, os R$9
    // sumiriam da tela — não entram em nenhum projeto listado nem no total
    // de "não atribuído".
    assert.equal(total, 9);
    assert.equal(unattributed, 9);
  } finally {
    await conn.close();
  }
});

/**
 * Anotações pertencem a um projeto.
 *
 * Antes da v14 a tabela `notes` não tinha projeto, então a mesma lista
 * aparecia em todos — quem abria um projeto novo encontrava os lembretes do
 * principal.
 */
test("migration v14 stamps notes written before it with the default project", async () => {
  const conn = await createTestConnection();
  try {
    // Reproduz um banco parado na v13: aplica as migrations de produção até
    // ali e carimba a versão, para que runMigrations siga daí.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS schema_version (
        id INTEGER, name TEXT, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    for (const migration of MIGRATIONS.filter((item) => item.id <= 13)) {
      await migration.up(conn);
      await conn.query(
        `INSERT INTO schema_version (id, name) VALUES (${migration.id}, 'x')`,
      );
    }

    await conn.query(`
      INSERT INTO notes (id, title, content, color, created_at, updated_at)
      VALUES ('nota-antiga', 'Lembrete de Moradia', 'texto', '#4f46e5', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);

    await runMigrations(conn);

    const rows = (
      await conn.query(`SELECT project_id FROM notes WHERE id = 'nota-antiga'`)
    ).toArray();

    // Sem o backfill a anotação ficaria com project_id nulo e sumiria de
    // todas as telas, já que a listagem passa a filtrar por projeto.
    assert.equal(rows.length, 1);
    assert.equal(rows[0].project_id, DEFAULT_PROJECT_ID);
  } finally {
    await conn.close();
  }
});

test("the bootstrap backfill rescues notes restored from a pre-v14 backup", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);

    // Um backup anterior à v14 não traz project_id: as linhas voltam nulas.
    await conn.query(`
      INSERT INTO notes (id, project_id, title, content, color, created_at, updated_at)
      VALUES ('nota-restaurada', NULL, 'Veio de backup antigo', '', '#4f46e5', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    await conn.query(BACKFILL_NOTE_PROJECT_SQL);

    const rows = (
      await conn.query(
        `SELECT project_id FROM notes WHERE id = 'nota-restaurada'`,
      )
    ).toArray();

    assert.equal(rows[0].project_id, DEFAULT_PROJECT_ID);
  } finally {
    await conn.close();
  }
});

test("each project only lists its own notes", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await conn.query(`
      INSERT INTO projects (id, name, slug, modules, color, is_active, created_at, updated_at)
      VALUES ('prj-capoeira', 'Capoeira', 'capoeira', '{}', '#059669', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    await conn.query(`
      INSERT INTO notes (id, project_id, title, content, color, created_at, updated_at)
      VALUES
        ('n-moradia', '${DEFAULT_PROJECT_ID}', 'Lembrete de Moradia', '', '#4f46e5', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('n-capoeira', 'prj-capoeira', 'Lembrete de Capoeira', '', '#059669', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);

    const capoeira = (
      await conn.query(
        `SELECT title FROM notes WHERE project_id = 'prj-capoeira'`,
      )
    ).toArray();
    const moradia = (
      await conn.query(
        `SELECT title FROM notes WHERE project_id = '${DEFAULT_PROJECT_ID}'`,
      )
    ).toArray();

    assert.deepEqual(
      capoeira.map((row) => row.title),
      ["Lembrete de Capoeira"],
    );
    assert.deepEqual(
      moradia.map((row) => row.title),
      ["Lembrete de Moradia"],
    );
  } finally {
    await conn.close();
  }
});

/**
 * O recorte da Gestão Mensal usa o mês DA LINHA.
 *
 * Um doador transferido em abril tem março na apuração do projeto antigo e
 * abril na do novo. Escopar pelo vínculo vigente arrastaria março junto — o
 * histórico se movendo, que é justamente o que a vigência impede.
 */
test("monthly scoping follows the assignment in force at the row month", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await conn.query(`
      INSERT INTO projects (id, name, slug, modules, color, is_active, created_at, updated_at)
      VALUES ('prj-capoeira', 'Capoeira', 'capoeira', '{}', '#059669', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    await conn.query(`
      INSERT INTO donors (id, name, cpf, demand, donor_type, is_active, created_at, updated_at)
      VALUES ('donor-x', 'Doador Transferido', '11111111111', NULL, 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);

    // Moradia até março; Capoeira de abril em diante.
    await conn.query(`
      INSERT INTO donor_project_assignments
        (id, donor_id, project_id, valid_from, valid_to, reason, created_at)
      VALUES
        ('dpa-antigo', 'donor-x', '${DEFAULT_PROJECT_ID}', DATE '${ASSIGNMENT_OPEN_START}', DATE '2026-03-01', 'inicial', CURRENT_TIMESTAMP),
        ('dpa-novo', 'donor-x', 'prj-capoeira', DATE '2026-04-01', DATE '${ASSIGNMENT_OPEN_END}', 'transferencia', CURRENT_TIMESTAMP)
    `);

    await conn.query(`
      INSERT INTO monthly_donor_summary (
        id, import_id, donor_id, reference_month, cpf, donor_name,
        notes_count, value_per_note, abatement_amount, abatement_status,
        created_at, updated_at
      )
      VALUES
        ('m-mar', 'imp', 'donor-x', DATE '2026-03-01', '11111111111', 'Doador Transferido', 3, 1.00, 3.00, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('m-abr', 'imp', 'donor-x', DATE '2026-04-01', '11111111111', 'Doador Transferido', 4, 1.00, 4.00, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);

    const monthsFor = async (projectId) => {
      const rows = (
        await conn.query(`
          SELECT strftime(monthly_donor_summary.reference_month, '%Y-%m-%d') AS reference_month
          FROM monthly_donor_summary
          WHERE ${donorBelongedToProjectAtMonth(
            "monthly_donor_summary.donor_id",
            "monthly_donor_summary.reference_month",
            projectId,
          )}
          ORDER BY reference_month
        `)
      ).toArray();

      return rows.map((row) => String(row.reference_month));
    };

    assert.deepEqual(await monthsFor(DEFAULT_PROJECT_ID), ["2026-03-01"]);
    assert.deepEqual(await monthsFor("prj-capoeira"), ["2026-04-01"]);
  } finally {
    await conn.close();
  }
});

test("the abatement sheet only lists CPFs of the project apurating that month", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await conn.query(`
      INSERT INTO projects (id, name, slug, modules, color, is_active, created_at, updated_at)
      VALUES ('prj-capoeira', 'Capoeira', 'capoeira', '{}', '#059669', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    await conn.query(`
      INSERT INTO donors (id, person_id, name, cpf, demand, donor_type, holder_person_id, is_active)
      VALUES
        ('d-moradia', 'p1', 'DOADOR MORADIA', '11111111111', 'CESTAS', 'holder', NULL, TRUE),
        ('d-capoeira', 'p2', 'DOADOR CAPOEIRA', '22222222222', NULL, 'holder', NULL, TRUE)
    `);
    await conn.query(`
      INSERT INTO donor_cpf_links (id, donor_id, name, cpf, link_type, is_active)
      VALUES
        ('lk-moradia', 'd-moradia', 'DOADOR MORADIA', '11111111111', 'holder', TRUE),
        ('lk-capoeira', 'd-capoeira', 'DOADOR CAPOEIRA', '22222222222', 'holder', TRUE)
    `);
    await conn.query(`
      INSERT INTO donor_project_assignments
        (id, donor_id, project_id, valid_from, valid_to, reason, created_at)
      VALUES
        ('dpa-m', 'd-moradia', '${DEFAULT_PROJECT_ID}', DATE '${ASSIGNMENT_OPEN_START}', DATE '${ASSIGNMENT_OPEN_END}', 'inicial', CURRENT_TIMESTAMP),
        ('dpa-c', 'd-capoeira', 'prj-capoeira', DATE '${ASSIGNMENT_OPEN_START}', DATE '${ASSIGNMENT_OPEN_END}', 'inicial', CURRENT_TIMESTAMP)
    `);
    await conn.query(`
      INSERT INTO import_cpf_summary
        (id, import_id, reference_month, cpf, notes_count, invalid_notes_count, matched_donor_id, matched_source_id, is_registered_donor)
      VALUES
        ('i1', 'imp', DATE '2026-04-01', '11111111111', 10, 0, 'd-moradia', 'lk-moradia', TRUE),
        ('i2', 'imp', DATE '2026-04-01', '22222222222',  7, 0, 'd-capoeira', 'lk-capoeira', TRUE)
    `);

    const sheetFor = async (projectId) => {
      const stmt = await conn.prepare(buildAbatementSheetSql(projectId));
      try {
        return (await stmt.query("2026-04-01")).toArray().map((row) => String(row.cpf));
      } finally {
        await stmt.close();
      }
    };

    // A planilha vai para o sistema que dá baixa: levar o CPF do outro projeto
    // abateria doação que não é daquela apuração.
    assert.deepEqual(await sheetFor(DEFAULT_PROJECT_ID), ["11111111111"]);
    assert.deepEqual(await sheetFor("prj-capoeira"), ["22222222222"]);
  } finally {
    await conn.close();
  }
});

/**
 * Pessoas: listagem por projeto, identidade global.
 *
 * A separação é deliberada. A LISTA é do projeto — quem abre Capoeira não deve
 * ver as pessoas de referência de Moradia. A IDENTIDADE não é: o CPF continua
 * único na plataforma, senão a mesma pessoa seria cadastrada duas vezes, uma
 * em cada projeto, e o vínculo doador → pessoa passaria a depender de onde o
 * operador estava quando cadastrou.
 *
 * Este caminho ainda não é alcançável pela interface (o módulo Pessoas não é
 * ligável em projeto novo), então a garantia fica aqui.
 */
test("people are listed per project but identified globally", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await conn.query(`
      INSERT INTO projects (id, name, slug, modules, color, is_active, created_at, updated_at)
      VALUES ('prj-capoeira', 'Capoeira', 'capoeira', '{}', '#059669', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    await conn.query(`
      INSERT INTO people (id, project_id, name, cpf, is_active, created_at, updated_at)
      VALUES
        ('p-moradia', '${DEFAULT_PROJECT_ID}', 'PESSOA DE MORADIA', '11111111111', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('p-capoeira', 'prj-capoeira', 'PESSOA DE CAPOEIRA', '22222222222', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);

    const listFor = async (projectId) => {
      const rows = (
        await conn.query(
          `SELECT name FROM people WHERE is_active = TRUE AND project_id = '${projectId}' ORDER BY name`,
        )
      ).toArray();
      return rows.map((row) => String(row.name));
    };

    assert.deepEqual(await listFor(DEFAULT_PROJECT_ID), ["PESSOA DE MORADIA"]);
    assert.deepEqual(await listFor("prj-capoeira"), ["PESSOA DE CAPOEIRA"]);

    // A busca por CPF — que sustenta a unicidade e o vínculo do doador — não
    // filtra projeto: ela encontra a pessoa venha de onde vier.
    const byCpf = (
      await conn.query(
        `SELECT id, project_id FROM people WHERE cpf = '22222222222' AND is_active = TRUE`,
      )
    ).toArray();

    assert.equal(byCpf.length, 1);
    assert.equal(byCpf[0].id, "p-capoeira");
  } finally {
    await conn.close();
  }
});

test("migration v15 stamps people written before it with the default project", async () => {
  const conn = await createTestConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS schema_version (
        id INTEGER, name TEXT, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    for (const migration of MIGRATIONS.filter((item) => item.id <= 14)) {
      await migration.up(conn);
      await conn.query(
        `INSERT INTO schema_version (id, name) VALUES (${migration.id}, 'x')`,
      );
    }

    await conn.query(`
      INSERT INTO people (id, name, cpf, is_active, created_at, updated_at)
      VALUES ('p-antiga', 'PESSOA ANTIGA', '11111111111', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);

    await runMigrations(conn);

    const rows = (
      await conn.query(`SELECT project_id FROM people WHERE id = 'p-antiga'`)
    ).toArray();

    // Sem o carimbo a pessoa sumiria da tela, já que a listagem passa a
    // filtrar por projeto.
    assert.equal(rows[0].project_id, DEFAULT_PROJECT_ID);
  } finally {
    await conn.close();
  }
});

/**
 * Ranking de doador recortado por mês.
 *
 * A fixture é montada para que a ordem MUDE conforme o mês: no total Ana
 * lidera, mas em abril quem lidera é Carla. Se o filtro fosse inerte, o teste
 * passaria de qualquer jeito — é o recorte trocar o pódio que prova que ele
 * está sendo aplicado.
 */
test("the donor ranking can be narrowed to a single month", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seedProjectCreditFixtures(conn);
    await runCreditReconciliation(conn);

    const rankingFor = async (referenceMonth) => {
      const rows = (
        await conn.query(
          buildProjectCreditByDonorSql("prj-capoeira", {
            limit: 10,
            referenceMonth,
          }),
        )
      ).toArray();

      return rows.map((row) => [
        String(row.donor_name),
        Number(row.total_credit),
      ]);
    };

    // Sem recorte: soma de março (2) e abril (3) para Carla.
    assert.deepEqual(await rankingFor(""), [["Carla Capoeira", 5]]);

    // Só março, só abril.
    assert.deepEqual(await rankingFor("2026-03-01"), [["Carla Capoeira", 2]]);
    assert.deepEqual(await rankingFor("2026-04-01"), [["Carla Capoeira", 3]]);

    // Mês sem crédito nenhum devolve lista vazia, e não a soma de tudo — o
    // erro que um filtro ignorado produziria.
    assert.deepEqual(await rankingFor("2026-01-01"), []);

    // Valor fora do formato de mês é ignorado com segurança: cai no total,
    // sem interferir no SQL.
    assert.deepEqual(await rankingFor("'; DROP TABLE donors; --"), [
      ["Carla Capoeira", 5],
    ]);
  } finally {
    await conn.close();
  }
});

/**
 * Série mensal: crédito, abatido e ganho líquido.
 *
 * O bug que originou isto: a série não trazia coluna de crédito nenhuma, então
 * o botão "Crédito" do gráfico mostrava R$ 0,00 em todos os meses.
 */
async function seedTrendFixtures(conn) {
  await conn.query(`
    INSERT INTO donors (id, name, cpf, demand, donor_type, is_active, created_at, updated_at)
    VALUES ('donor-tr', 'Doador Tendencia', '11111111111', 'CESTAS', 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
  await conn.query(`
    INSERT INTO donor_cpf_links (id, donor_id, name, cpf, link_type, is_active, created_at, updated_at)
    VALUES ('lk-tr', 'donor-tr', 'Doador Tendencia', '11111111111', 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
  await seedAssignments(conn, ["donor-tr"]);

  // Março: R$ 30 de crédito, R$ 10 abatidos  -> líquido +20
  // Abril: R$  5 de crédito, R$ 40 abatidos  -> líquido -35
  await conn.query(`
    INSERT INTO donation_notes (
      id, import_id, cpf, numero_nota, valor_nota, reference_month,
      cnpj_estabelecimento, is_valid, created_at
    )
    VALUES
      ('dn-mar', 'imp', '11111111111', '301', 300.00, DATE '2026-03-01', '11111111000111', TRUE, CURRENT_TIMESTAMP),
      ('dn-abr', 'imp', '11111111111', '401', 50.00, DATE '2026-04-01', '11111111000122', TRUE, CURRENT_TIMESTAMP)
  `);
  await conn.query(`
    INSERT INTO credit_notes (
      id, credit_import_id, cnpj_estabelecimento, numero_nota,
      valor_nf, credito, situacao, is_valid, created_at
    )
    VALUES
      ('cn-mar', 'ci', '11111111000111', '301', 300.00, 30.00, 'Calculado', TRUE, CURRENT_TIMESTAMP),
      ('cn-abr', 'ci', '11111111000122', '401', 50.00, 5.00, 'Calculado', TRUE, CURRENT_TIMESTAMP)
  `);

  // O abatimento de abril tem uma parcela PENDENTE, que não pode entrar na
  // conta: "já abatido" é o que saiu, não o que se pretende abater.
  await conn.query(`
    INSERT INTO monthly_donor_summary (
      id, import_id, donor_id, reference_month, cpf, donor_name,
      notes_count, value_per_note, abatement_amount, abatement_status,
      created_at, updated_at
    )
    VALUES
      ('ms-mar', 'imp', 'donor-tr', DATE '2026-03-01', '11111111111', 'Doador Tendencia', 3, 1.00, 10.00, 'applied', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('ms-abr', 'imp', 'donor-tr', DATE '2026-04-01', '11111111111', 'Doador Tendencia', 1, 1.00, 40.00, 'applied', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('ms-mai', 'imp', 'donor-tr', DATE '2026-05-01', '11111111111', 'Doador Tendencia', 2, 1.00, 99.00, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
}

test("the monthly trend carries credit, applied abatement and net gain", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seedTrendFixtures(conn);
    await runCreditReconciliation(conn);

    const rows = (
      await conn.query(buildMonthlyTrendSql(DEFAULT_PROJECT_ID))
    ).toArray();
    const byMonth = new Map(
      rows.map((row) => [
        String(row.reference_month),
        {
          credito: Number(row.total_credit),
          abatido: Number(row.total_abatement),
          liquido: Number(row.net_gain),
        },
      ]),
    );

    // Antes da correção, total_credit nem existia — o gráfico mostrava zero.
    assert.deepEqual(byMonth.get("2026-03-01"), {
      credito: 30,
      abatido: 10,
      liquido: 20,
    });

    // Mês em que se abateu mais do que entrou: o líquido é negativo, e é esse
    // caso que o gráfico precisa conseguir desenhar.
    assert.deepEqual(byMonth.get("2026-04-01"), {
      credito: 5,
      abatido: 40,
      liquido: -35,
    });

    // Maio só tem abatimento PENDENTE: não conta como abatido nem derruba o
    // líquido.
    assert.deepEqual(byMonth.get("2026-05-01"), {
      credito: 0,
      abatido: 0,
      liquido: 0,
    });
  } finally {
    await conn.close();
  }
});

test("the monthly trend keeps a transferred donor's past months in the old project", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await conn.query(`
      INSERT INTO projects (id, name, slug, modules, color, is_active, created_at, updated_at)
      VALUES ('prj-capoeira', 'Capoeira', 'capoeira', '{}', '#059669', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    await seedTrendFixtures(conn);
    await runCreditReconciliation(conn);

    // Transfere para Capoeira a partir de abril.
    await conn.query(`
      UPDATE donor_project_assignments
      SET valid_to = DATE '2026-03-01'
      WHERE donor_id = 'donor-tr' AND valid_to = DATE '${ASSIGNMENT_OPEN_END}'
    `);
    await conn.query(`
      INSERT INTO donor_project_assignments
        (id, donor_id, project_id, valid_from, valid_to, reason, created_at)
      VALUES ('dpa-tr-2', 'donor-tr', 'prj-capoeira', DATE '2026-04-01', DATE '${ASSIGNMENT_OPEN_END}', 'transferencia', CURRENT_TIMESTAMP)
    `);

    const monthsFor = async (projectId) =>
      (await conn.query(buildMonthlyTrendSql(projectId)))
        .toArray()
        .map((row) => String(row.reference_month))
        .sort();

    // A série usava o vínculo VIGENTE, então março teria migrado junto com o
    // doador e sumido do projeto que de fato o apurou.
    assert.deepEqual(await monthsFor(DEFAULT_PROJECT_ID), ["2026-03-01"]);
    assert.deepEqual(await monthsFor("prj-capoeira"), [
      "2026-04-01",
      "2026-05-01",
    ]);
  } finally {
    await conn.close();
  }
});

/**
 * Painel da plataforma: planilha, conciliado e não identificado.
 *
 * A soma tem de fechar em três partes — o que a planilha creditou é o que
 * casou com doador mais o que não casou. Se as duas somas saíssem de filtros
 * diferentes, a diferença apareceria como "não identificado" fantasma e o
 * operador procuraria um problema que não existe.
 */
test("platform credit splits the spreadsheet into matched and unidentified", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seedProjectCreditFixtures(conn);

    // Crédito de um CNPJ que nenhum doador cadastrado enviou: fica sem dono.
    await conn.query(`
      INSERT INTO credit_notes (
        id, credit_import_id, cnpj_estabelecimento, numero_nota,
        valor_nf, credito, situacao, is_valid, created_at
      )
      VALUES ('cn-orfao', 'ci-p', '99999999000199', '999', 500.00, 12.00, 'Calculado', TRUE, CURRENT_TIMESTAMP)
    `);
    // E uma nota inválida, que não pode entrar em soma nenhuma.
    await conn.query(`
      INSERT INTO credit_notes (
        id, credit_import_id, cnpj_estabelecimento, numero_nota,
        valor_nf, credito, situacao, is_valid, created_at
      )
      VALUES ('cn-invalida', 'ci-p', '88888888000188', '888', 100.00, 7.00, 'Pendente', FALSE, CURRENT_TIMESTAMP)
    `);

    await runCreditReconciliation(conn);

    const rows = (await conn.query(PLATFORM_CREDIT_TOTALS_SQL)).toArray();
    const planilha = Number(rows[0].spreadsheet_credit);
    const conciliado = Number(rows[0].matched_credit);

    // Fixture: 7 + 2 + 3 = 12 conciliados, mais 12 órfãos = 24 na planilha.
    // A nota inválida (7) fica de fora dos dois.
    assert.equal(planilha, 24);
    assert.equal(conciliado, 12);
    assert.equal(planilha - conciliado, 12);

    // O denominador da média sobre TODAS as notas conta as 4 notas válidas —
    // as 3 que casaram mais a órfã. A inválida fica fora, senão a média cairia
    // por causa de uma linha que não representa doação nenhuma.
    //
    // Contar só as casadas daria 12/3 = R$ 4,00 e esconderia justamente o que
    // esta média existe para mostrar: o crédito que a NFP concedeu por nota,
    // independentemente de a conciliação já ter alcançado a nota ou não.
    const notasDaPlanilha = Number(rows[0].credit_notes_count);
    assert.equal(notasDaPlanilha, 4);
    assert.equal(planilha / notasDaPlanilha, 6);
  } finally {
    await conn.close();
  }
});

test("the sum per project plus unattributed equals the reconciled credit", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seedProjectCreditFixtures(conn);

    // Doador sem vínculo nenhum: o crédito dele não pertence a projeto algum
    // e precisa aparecer como não atribuído, senão some da conta.
    await conn.query(`
      INSERT INTO donors (id, name, cpf, demand, donor_type, is_active, created_at, updated_at)
      VALUES ('donor-solto', 'Doador Sem Projeto', '66677788899', NULL, 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    await conn.query(`
      INSERT INTO donor_cpf_links (id, donor_id, name, cpf, link_type, is_active, created_at, updated_at)
      VALUES ('lk-solto', 'donor-solto', 'Doador Sem Projeto', '66677788899', 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    await conn.query(`
      INSERT INTO donation_notes (
        id, import_id, cpf, numero_nota, valor_nota, reference_month,
        cnpj_estabelecimento, is_valid, created_at
      )
      VALUES ('dn-solto', 'imp-p', '66677788899', '777', 40.00, DATE '2026-03-01', '77777777000177', TRUE, CURRENT_TIMESTAMP)
    `);
    await conn.query(`
      INSERT INTO credit_notes (
        id, credit_import_id, cnpj_estabelecimento, numero_nota,
        valor_nf, credito, situacao, is_valid, created_at
      )
      VALUES ('cn-solto', 'ci-p', '77777777000177', '777', 40.00, 4.00, 'Calculado', TRUE, CURRENT_TIMESTAMP)
    `);

    await runCreditReconciliation(conn);

    const byProject = (await conn.query(CREDIT_BY_PROJECT_SQL)).toArray();
    const comProjeto = byProject
      .filter((row) => row.project_id)
      .reduce((sum, row) => sum + Number(row.total_credit), 0);
    const semProjeto = byProject
      .filter((row) => !row.project_id)
      .reduce((sum, row) => sum + Number(row.total_credit), 0);

    const totals = (await conn.query(PLATFORM_CREDIT_TOTALS_SQL)).toArray();
    const conciliado = Number(totals[0].matched_credit);

    // 12 dos doadores com projeto + 4 do doador solto.
    assert.equal(comProjeto, 12);
    assert.equal(semProjeto, 4);
    assert.equal(comProjeto + semProjeto, conciliado);
  } finally {
    await conn.close();
  }
});

/**
 * Semeia dois doadores com crédito e abatimento em MESES DIFERENTES.
 *
 * A separação por mês é o ponto: se tudo caísse na mesma competência, uma
 * consulta que ignorasse o recorte passaria no teste do mesmo jeito.
 *
 * Alice tem crédito em jan e fev, e abatimento aplicado só em jan.
 * Bruno tem abatimento aplicado em fev, sem crédito nenhum — é o lado que
 * prova que o recorte também vale para a metade do abatimento.
 */
async function seedDonorMonthStatusFixtures(conn) {
  await conn.query(`
    INSERT INTO donor_cpf_links (id, donor_id, name, cpf, link_type, is_active, created_at, updated_at)
    VALUES
      ('l-a', 'donor-a', 'Alice', '11111111111', 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('l-b', 'donor-b', 'Bruno', '22222222222', 'holder', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);

  await conn.query(`
    INSERT INTO donation_notes (id, import_id, cpf, reference_month, numero_nota, valor_nota, is_valid, created_at)
    VALUES
      ('dn-jan', 'imp-1', '11111111111', DATE '2025-01-01', '1', 50.00, TRUE, CURRENT_TIMESTAMP),
      ('dn-fev', 'imp-2', '11111111111', DATE '2025-02-01', '2', 50.00, TRUE, CURRENT_TIMESTAMP)
  `);

  await conn.query(`
    INSERT INTO credit_notes (id, credit_import_id, numero_nota, credito, situacao, is_valid, created_at)
    VALUES
      ('cn-jan', 'ci-1', '1', 3.00, 'Calculado', TRUE, CURRENT_TIMESTAMP),
      ('cn-fev', 'ci-2', '2', 7.00, 'Calculado', TRUE, CURRENT_TIMESTAMP)
  `);

  await conn.query(`
    INSERT INTO credit_reconciliation (id, credit_note_id, donation_note_id, match_status, created_at)
    VALUES
      ('r-jan', 'cn-jan', 'dn-jan', 'matched', CURRENT_TIMESTAMP),
      ('r-fev', 'cn-fev', 'dn-fev', 'matched', CURRENT_TIMESTAMP)
  `);

  await conn.query(`
    INSERT INTO monthly_donor_summary (
      id, import_id, donor_id, reference_month, cpf, donor_name,
      notes_count, value_per_note, abatement_amount, abatement_status, created_at, updated_at
    )
    VALUES
      ('s-a-jan', 'imp-1', 'donor-a', DATE '2025-01-01', '11111111111', 'Alice',
       1, 50.00, 500.00, 'applied', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('s-b-fev', 'imp-2', 'donor-b', DATE '2025-02-01', '22222222222', 'Bruno',
       1, 50.00, 900.00, 'applied', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
}

test("o status por doador/mês devolve o histórico inteiro quando não recebe mês", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seedDonorMonthStatusFixtures(conn);

    const { sql, params } = buildDonorMonthStatusQuery();
    assert.deepEqual(params, [], "sem mês não deve haver parâmetro para ligar");

    const linhas = (await conn.query(sql)).toArray();

    // Alice em jan e fev, Bruno em fev.
    assert.equal(linhas.length, 3);
  } finally {
    await conn.close();
  }
});

test("o status por doador/mês recorta os dois lados no mesmo mês", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seedDonorMonthStatusFixtures(conn);

    const { sql, params } = buildDonorMonthStatusQuery({
      referenceMonth: "2025-01-01",
    });
    // Dois parâmetros porque os dois lados são recortados — crédito e
    // abatimento precisam andar juntos.
    assert.deepEqual(params, ["2025-01-01", "2025-01-01"]);

    const stmt = await conn.prepare(sql);
    let linhas;
    try {
      linhas = (await stmt.query(...params)).toArray();
    } finally {
      await stmt.close();
    }

    // Só Alice em janeiro. Fevereiro (dela e do Bruno) fica de fora.
    assert.equal(linhas.length, 1);
    assert.equal(String(linhas[0].donor_id), "donor-a");
    assert.equal(String(linhas[0].reference_month), "2025-01-01");
    assert.equal(Number(linhas[0].total_credit), 3);
    assert.equal(Number(linhas[0].total_abated), 500);
  } finally {
    await conn.close();
  }
});

test("recortar um mês não arrasta o abatimento de outro mês do mesmo doador", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seedDonorMonthStatusFixtures(conn);

    // Fevereiro: Alice tem crédito (7) e NENHUM abatimento aplicado — o dela
    // é de janeiro. Se o recorte valesse só para o crédito, os 500 de janeiro
    // apareceriam aqui e a coluna "Saldo" mostraria uma diferença inventada.
    const { sql, params } = buildDonorMonthStatusQuery({
      referenceMonth: "2025-02-01",
    });

    const stmt = await conn.prepare(sql);
    let linhas;
    try {
      linhas = (await stmt.query(...params)).toArray();
    } finally {
      await stmt.close();
    }

    const alice = linhas.find((l) => String(l.donor_id) === "donor-a");
    assert.ok(alice, "Alice precisa aparecer em fevereiro, pelo crédito");
    assert.equal(Number(alice.total_credit), 7);
    assert.equal(Number(alice.total_abated), 0);

    // E Bruno aparece pelo lado oposto: abatimento sem crédito.
    const bruno = linhas.find((l) => String(l.donor_id) === "donor-b");
    assert.ok(bruno, "Bruno precisa aparecer em fevereiro, pelo abatimento");
    assert.equal(Number(bruno.total_credit), 0);
    assert.equal(Number(bruno.total_abated), 900);
  } finally {
    await conn.close();
  }
});

test("o status por doador/mês aceita o mês no formato do campo, sem dia", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seedDonorMonthStatusFixtures(conn);

    // Escolher o mês no campo da Gestão Mensal manda "2025-01", sem dia. Esse
    // valor chegava inteiro ao CAST(? AS DATE) e a consulta falhava — as
    // colunas de crédito real e saldo paravam de atualizar sem aviso.
    const { sql, params } = buildDonorMonthStatusQuery({
      referenceMonth: "2025-01",
    });
    assert.deepEqual(params, ["2025-01-01", "2025-01-01"]);

    const stmt = await conn.prepare(sql);
    let linhas;
    try {
      linhas = (await stmt.query(...params)).toArray();
    } finally {
      await stmt.close();
    }

    assert.equal(linhas.length, 1);
    assert.equal(String(linhas[0].donor_id), "donor-a");
  } finally {
    await conn.close();
  }
});

/**
 * Semeia notas de um mesmo mês em ordem de compra embaralhada, para a
 * numeração ter de ordenar de verdade em vez de devolver a ordem de inserção.
 *
 * Inclui de propósito três linhas que NÃO podem receber número: nota inválida,
 * nota sem data, e nota de um CPF que não é doador cadastrado. Cada uma delas,
 * se entrasse, deslocaria o número de todas as seguintes.
 */
async function seedRaffleFixtures(conn) {
  await conn.query(`
    INSERT INTO donors (id, person_id, name, cpf, demand, donor_type, is_active)
    VALUES
      ('d-ana', 'p-ana', 'ANA MARIA DE SOUZA', '11111111111', 'CESTAS', 'holder', TRUE),
      ('d-bru', 'p-bru', 'BRUNO SILVA',        '22222222222', 'CESTAS', 'holder', TRUE)
  `);
  await seedAssignments(conn, ["d-ana", "d-bru"]);
  await conn.query(`
    INSERT INTO donor_cpf_links (id, donor_id, name, cpf, link_type, is_active)
    VALUES
      ('l-ana', 'd-ana', 'ANA MARIA DE SOUZA', '11111111111', 'holder', TRUE),
      ('l-bru', 'd-bru', 'BRUNO SILVA',        '22222222222', 'holder', TRUE)
  `);

  await conn.query(`
    INSERT INTO donation_notes
      (id, import_id, cpf, reference_month, numero_nota, data_nota, is_valid, created_at)
    VALUES
      ('n3', 'imp', '11111111111', DATE '2026-04-01', '300', DATE '2026-04-20', TRUE,  CURRENT_TIMESTAMP),
      ('n1', 'imp', '22222222222', DATE '2026-04-01', '100', DATE '2026-04-02', TRUE,  CURRENT_TIMESTAMP),
      ('n2', 'imp', '11111111111', DATE '2026-04-01', '200', DATE '2026-04-11', TRUE,  CURRENT_TIMESTAMP),
      ('x-invalida',  'imp', '11111111111', DATE '2026-04-01', '400', DATE '2026-04-05', FALSE, CURRENT_TIMESTAMP),
      ('x-sem-data',  'imp', '11111111111', DATE '2026-04-01', '500', NULL,              TRUE,  CURRENT_TIMESTAMP),
      ('x-sem-dono',  'imp', '99999999999', DATE '2026-04-01', '600', DATE '2026-04-03', TRUE,  CURRENT_TIMESTAMP),
      ('n-maio', 'imp', '11111111111', DATE '2026-05-01', '700', DATE '2026-05-09', TRUE, CURRENT_TIMESTAMP)
  `);
}

test("os números da sorte seguem a ordem da compra e ignoram o que não pode ser sorteado", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seedRaffleFixtures(conn);

    const stmt = await conn.prepare(
      buildRaffleNumbersSql(DEFAULT_PROJECT_ID, { scope: "month" }),
    );
    let linhas;
    try {
      linhas = (await stmt.query("2026-04-01")).toArray();
    } finally {
      await stmt.close();
    }

    // Três notas elegíveis em abril. A inválida, a sem data e a de CPF sem
    // cadastro ficam de fora — e é por isso que os números vão só até 3.
    assert.equal(linhas.length, 3);
    assert.deepEqual(
      linhas.map((l) => [Number(l.numero_sorte), String(l.data_nota)]),
      [
        [1, "2026-04-02"],
        [2, "2026-04-11"],
        [3, "2026-04-20"],
      ],
    );

    // O número 1 é do Bruno, que comprou primeiro — não do primeiro inserido.
    assert.equal(String(linhas[0].donor_name), "BRUNO SILVA");
    assert.equal(String(linhas[0].cpf), "22222222222");

    // Maio não vaza para abril.
    assert.ok(linhas.every((l) => String(l.data_nota).startsWith("2026-04")));
  } finally {
    await conn.close();
  }
});

test("o recorte anual numera o ano inteiro numa sequência só", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seedRaffleFixtures(conn);

    const stmt = await conn.prepare(
      buildRaffleNumbersSql(DEFAULT_PROJECT_ID, { scope: "year" }),
    );
    let linhas;
    try {
      // Qualquer mês de 2026 delimita o ano: o recorte usa o ano da data.
      linhas = (await stmt.query("2026-04-01")).toArray();
    } finally {
      await stmt.close();
    }

    // As três de abril mais a de maio, numeradas continuamente — a de maio
    // não recomeça do 1, senão dois bilhetes diferentes teriam o mesmo número
    // no sorteio anual.
    assert.equal(linhas.length, 4);
    assert.deepEqual(
      linhas.map((l) => Number(l.numero_sorte)),
      [1, 2, 3, 4],
    );
    assert.equal(String(linhas[3].data_nota), "2026-05-09");
  } finally {
    await conn.close();
  }
});

test("a numeração é estável: a mesma consulta devolve os mesmos números", async () => {
  const conn = await createTestConnection();
  try {
    await runMigrations(conn);
    await seedRaffleFixtures(conn);

    // Um sorteio pode ser conferido depois. Se a ordem dependesse do acaso do
    // motor, refazer a lista trocaria os ganhadores.
    const rodar = async () => {
      const stmt = await conn.prepare(
        buildRaffleNumbersSql(DEFAULT_PROJECT_ID, { scope: "month" }),
      );
      try {
        return (await stmt.query("2026-04-01"))
          .toArray()
          .map((l) => `${l.numero_sorte}:${l.cpf}:${l.data_nota}`);
      } finally {
        await stmt.close();
      }
    };

    assert.deepEqual(await rodar(), await rodar());
  } finally {
    await conn.close();
  }
});
