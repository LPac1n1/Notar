import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestConnection } from "./helpers/duckdbHelper.js";
import { runMigrations } from "../src/services/db/migrations.js";
import {
  COLUMN_TYPES_SQL,
  buildDropIndexSql,
  buildDuplicateKeyCheckSql,
  buildJsonRestoreInsertSql,
  buildRestorableIndexesSql,
  parseIndexColumns,
  restoreFileNameFor,
} from "../src/services/db/restoreSql.js";

/**
 * Restauração rápida: o DuckDB lê o JSON de cada tabela.
 *
 * O que estes testes protegem é a FIDELIDADE. A restauração é o caminho por
 * onde todo o banco passa a cada vez que o sistema abre; se ela arredondar
 * um valor, comer um zero à esquerda ou trocar um nulo por texto vazio, o
 * erro entra em silêncio e sobe para a nuvem no próximo envio.
 */

async function bootstrap() {
  const conn = await createTestConnection();
  await runMigrations(conn);
  return conn;
}

function rows(result) {
  return result.toArray().map((row) => row.toJSON());
}

async function columnTypesOf(conn, table) {
  const types = new Map();
  for (const row of rows(await conn.query(COLUMN_TYPES_SQL))) {
    if (row.table_name === table) types.set(row.column_name, row.data_type);
  }
  return types;
}

async function load(conn, table, columns, data) {
  const fileName = restoreFileNameFor(table);
  conn.registerFileText(fileName, JSON.stringify(data));
  try {
    await conn.query(
      buildJsonRestoreInsertSql({
        table,
        columns,
        columnTypes: await columnTypesOf(conn, table),
        fileName,
      }),
    );
  } finally {
    conn.dropFile(fileName);
  }
}

test("texto, CPF com zero à esquerda, booleano, data e nulo voltam como estavam", async () => {
  const conn = await bootstrap();
  try {
    await load(
      conn,
      "donors",
      ["id", "name", "cpf", "demand", "donor_type", "donation_start_date", "is_active", "created_at"],
      [
        {
          id: "d1",
          name: 'JOÃO "ZÉ" D\'ÁVILA',
          cpf: "01234567890",
          demand: "São Lucas",
          donor_type: "holder",
          donation_start_date: "2026-03-01",
          is_active: true,
          created_at: "2026-01-15 10:30:00",
        },
        {
          id: "d2",
          name: "MARIA",
          cpf: "00000000191",
          demand: null,
          donor_type: "auxiliary",
          donation_start_date: null,
          is_active: false,
          created_at: "2026-01-16 08:00:00.123456",
        },
      ],
    );

    const loaded = rows(
      await conn.query(`
        SELECT id, name, cpf, demand, donor_type, is_active,
          CAST(donation_start_date AS VARCHAR) AS donation_start_date,
          CAST(created_at AS VARCHAR) AS created_at
        FROM donors ORDER BY id
      `),
    );

    assert.deepEqual(loaded, [
      {
        id: "d1",
        name: 'JOÃO "ZÉ" D\'ÁVILA',
        // Lido como texto: um CPF não é um número, e o zero faz parte dele.
        cpf: "01234567890",
        demand: "São Lucas",
        donor_type: "holder",
        is_active: true,
        donation_start_date: "2026-03-01",
        created_at: "2026-01-15 10:30:00",
      },
      {
        id: "d2",
        name: "MARIA",
        cpf: "00000000191",
        demand: null,
        donor_type: "auxiliary",
        is_active: false,
        donation_start_date: null,
        created_at: "2026-01-16 08:00:00.123456",
      },
    ]);
  } finally {
    conn.close();
  }
});

test("valor em centavos, decimal e contagem não perdem precisão", async () => {
  const conn = await bootstrap();
  try {
    await load(
      conn,
      "donation_notes",
      ["id", "import_id", "cpf", "numero_nota", "valor_nota", "is_valid", "match_key", "valor_cents"],
      [
        {
          id: "n1",
          import_id: "imp",
          cpf: "01234567890",
          // Número de nota é texto: zeros e tamanho são significativos.
          numero_nota: "000123",
          valor_nota: 1234.56,
          is_valid: true,
          match_key: "11111111000111|123",
          valor_cents: 123456,
        },
        {
          id: "n2",
          import_id: "imp",
          cpf: "11144477735",
          numero_nota: "9",
          valor_nota: 0.1,
          is_valid: false,
          match_key: "|9",
          valor_cents: 9007199254740991,
        },
      ],
    );

    const loaded = rows(
      await conn.query(`
        SELECT id, numero_nota, valor_nota, is_valid, match_key,
          CAST(valor_cents AS VARCHAR) AS valor_cents,
          typeof(valor_cents) AS cents_type
        FROM donation_notes ORDER BY id
      `),
    );

    assert.deepEqual(loaded, [
      {
        id: "n1",
        numero_nota: "000123",
        valor_nota: 1234.56,
        is_valid: true,
        match_key: "11111111000111|123",
        valor_cents: "123456",
        cents_type: "BIGINT",
      },
      {
        id: "n2",
        numero_nota: "9",
        valor_nota: 0.1,
        is_valid: false,
        match_key: "|9",
        valor_cents: "9007199254740991",
        cents_type: "BIGINT",
      },
    ]);
  } finally {
    conn.close();
  }
});

test("arquivo antigo: chave que falta vira nulo, chave a mais é ignorada, 1 e 0 valem como booleano", async () => {
  const conn = await bootstrap();
  try {
    await load(
      conn,
      "demands",
      ["id", "name", "color", "is_active"],
      [
        // Sem `color`; com um campo que a tabela não tem.
        { id: "dm1", name: "CESTAS", is_active: 1, campo_de_outra_versao: "x" },
        { id: "dm2", name: "REMÉDIOS", color: "#ff0000", is_active: 0 },
      ],
    );

    const loaded = rows(
      await conn.query("SELECT id, name, color, is_active FROM demands ORDER BY id"),
    );

    assert.deepEqual(loaded, [
      { id: "dm1", name: "CESTAS", color: null, is_active: true },
      { id: "dm2", name: "REMÉDIOS", color: "#ff0000", is_active: false },
    ]);
  } finally {
    conn.close();
  }
});

test("conteúdo hostil no arquivo é dado, nunca SQL", async () => {
  const conn = await bootstrap();
  try {
    const hostile = "x'); DROP TABLE demands; --";
    await load(conn, "demands", ["id", "name"], [{ id: "dm1", name: hostile }]);

    const loaded = rows(await conn.query("SELECT name FROM demands"));
    assert.deepEqual(loaded, [{ name: hostile }]);
  } finally {
    conn.close();
  }
});

test("os índices da tabela são listados com o SQL que os recria", async () => {
  const conn = await bootstrap();
  try {
    const indexes = rows(
      await conn.query(buildRestorableIndexesSql(["donation_notes"])),
    );
    const names = indexes.map((index) => index.index_name);

    assert.ok(names.includes("uq_donation_notes_id"));
    assert.ok(names.includes("idx_donation_notes_cpf"));
    assert.ok(indexes.every((index) => index.table_name === "donation_notes"));

    // Derrubar e recriar com o SQL do catálogo devolve o mesmo conjunto.
    for (const index of indexes) {
      await conn.query(buildDropIndexSql(index.index_name));
    }
    assert.equal(
      rows(await conn.query(buildRestorableIndexesSql(["donation_notes"]))).length,
      0,
    );
    for (const index of indexes) {
      await conn.query(index.sql);
    }
    assert.deepEqual(
      rows(await conn.query(buildRestorableIndexesSql(["donation_notes"]))).map(
        (index) => index.index_name,
      ),
      names,
    );
  } finally {
    conn.close();
  }
});

test("as colunas de um índice saem do SQL do catálogo", () => {
  assert.deepEqual(
    parseIndexColumns("CREATE UNIQUE INDEX uq_people_cpf ON people(cpf);"),
    ["cpf"],
  );
  assert.deepEqual(
    parseIndexColumns(
      'CREATE UNIQUE INDEX uq_x ON donor_project_assignments(donor_id, "valid_to")',
    ),
    ["donor_id", "valid_to"],
  );
  // Índice sobre expressão: melhor dizer "não sei" do que conferir errado.
  assert.equal(parseIndexColumns("CREATE INDEX i ON t(lower(name))"), null);
  assert.equal(parseIndexColumns(""), null);
});

test("chave repetida é detectada sem índice; nulo não conta como repetição", async () => {
  const conn = await bootstrap();
  try {
    const check = async () =>
      rows(await conn.query(buildDuplicateKeyCheckSql("people", ["cpf"]))).length > 0;

    await conn.query("DROP INDEX IF EXISTS uq_people_cpf");
    await conn.query(`
      INSERT INTO people (id, name, cpf) VALUES
        ('p1', 'A', '11111111111'),
        ('p2', 'B', NULL),
        ('p3', 'C', NULL)
    `);
    assert.equal(await check(), false);

    await conn.query("INSERT INTO people (id, name, cpf) VALUES ('p4', 'D', '11111111111')");
    assert.equal(await check(), true);
  } finally {
    conn.close();
  }
});

test("nome de tabela, coluna ou arquivo fora do formato é recusado", () => {
  const columnTypes = new Map([["id", "VARCHAR"]]);

  assert.throws(() => restoreFileNameFor("demands; DROP"));
  assert.throws(() =>
    buildJsonRestoreInsertSql({
      table: "demands",
      columns: ['id" FROM x; --'],
      columnTypes,
      fileName: "restore_demands.json",
    }),
  );
  assert.throws(() =>
    buildJsonRestoreInsertSql({
      table: "demands",
      columns: ["id"],
      columnTypes,
      fileName: "a'); DROP TABLE demands; --",
    }),
  );
  // Coluna sem tipo conhecido no catálogo.
  assert.throws(() =>
    buildJsonRestoreInsertSql({
      table: "demands",
      columns: ["id", "coluna_que_nao_existe"],
      columnTypes,
      fileName: "restore_demands.json",
    }),
  );
});
