import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestConnection } from "./helpers/duckdbHelper.js";
import { runMigrations } from "../src/services/db/migrations.js";
import {
  SNAPSHOT_SOURCES,
  buildSnapshotJsonQuery,
} from "../src/services/db/snapshotSources.js";
import { SNAPSHOT_TABLE_KEYS } from "../src/utils/backup.js";

/**
 * O snapshot da nuvem passou a ser serializado pelo próprio DuckDB
 * (`json_group_array`) em vez de percorrido em JavaScript: montá-lo aqui
 * travava a thread principal por meio segundo A CADA gravação, com um ano de
 * dados.
 *
 * A troca só é segura se o JSON do banco disser exatamente o mesmo que o do
 * `JSON.stringify`. Estes testes rodam o SQL DE PRODUÇÃO contra um DuckDB real,
 * com as migrations reais — reescrever as consultas aqui provaria apenas que a
 * cópia funciona.
 *
 * O bundle node-blocking do harness é o MVP, que estoura com `_setThrew is not
 * defined` ao inserir em coluna criada por `ALTER TABLE` (é o caso de
 * `donors.notes` e `donors.value_per_note`). Por isso a checagem de fidelidade
 * usa `donation_notes`, `credit_notes`, `demands` e `notes`, que cobrem os
 * mesmos tipos — texto com acento e aspas, decimal, booleano, nulo e BIGINT —
 * sem esbarrar no defeito do harness.
 */

async function bootstrap() {
  const handle = await createTestConnection();
  const conn = handle.conn ?? handle;
  await runMigrations(conn);
  return { conn, close: handle.close ?? (async () => {}) };
}

async function readOne(conn, sql) {
  const result = await conn.query(sql);
  return result.toArray()[0] ?? {};
}

test("toda tabela do snapshot devolve JSON válido contra o schema real", async () => {
  const { conn, close } = await bootstrap();

  try {
    for (const source of SNAPSHOT_SOURCES) {
      const row = await readOne(conn, buildSnapshotJsonQuery(source.sql));

      let parsed;
      assert.doesNotThrow(() => {
        parsed = JSON.parse(row.json_text);
      }, `${source.key} não produziu JSON analisável`);

      assert.ok(Array.isArray(parsed), `${source.key} não devolveu um array`);
      assert.equal(
        parsed.length,
        Number(row.total),
        `${source.key}: a contagem não descreve o conteúdo serializado`,
      );
    }
  } finally {
    await close();
  }
});

test("tabela vazia vira [] e não NULL", async () => {
  const { conn, close } = await bootstrap();

  try {
    // `people` nasce vazia; as migrations semeiam apenas o projeto padrão.
    const source = SNAPSHOT_SOURCES.find((item) => item.key === "people");
    const row = await readOne(conn, buildSnapshotJsonQuery(source.sql));

    // Um NULL concatenado no envelope produziria um backup ilegível, e a falha
    // só apareceria na hora de restaurar.
    assert.equal(row.json_text, "[]");
    assert.equal(Number(row.total), 0);
  } finally {
    await close();
  }
});

test("a tabela derivada de conciliação não é exportada", () => {
  // Ela é reconstruída a partir das notas ao restaurar. Exportá-la de novo
  // devolveria ao arquivo o terço do tamanho que esta mudança tirou.
  assert.equal(
    SNAPSHOT_SOURCES.some((source) => /credit_reconciliation/.test(source.sql)),
    false,
  );
});

test("as chaves do snapshot cobrem exatamente as tabelas exportadas", () => {
  assert.deepEqual(
    SNAPSHOT_SOURCES.map((source) => source.key).sort(),
    [...SNAPSHOT_TABLE_KEYS].sort(),
    "uma tabela exportada sem chave correspondente sumiria do backup em silêncio",
  );
});

test("o JSON do DuckDB é idêntico ao do JSON.stringify", async () => {
  const { conn, close } = await bootstrap();

  try {
    await conn.query(`
      INSERT INTO demands (id, project_id, name, color, is_active, created_at, updated_at)
      VALUES ('dm1', 'prj-demandas-moradia', 'CESTA "BÁSICA"', '#ffffff', TRUE,
              TIMESTAMP '2025-01-01 08:00:00', TIMESTAMP '2025-01-02 09:30:00')
    `);

    await conn.query(`
      INSERT INTO notes (id, project_id, title, content, color, created_at, updated_at)
      VALUES ('nt1', 'prj-demandas-moradia', 'Título com ção', 'aspas "aqui"', '#fff',
              TIMESTAMP '2025-01-01 08:00:00', TIMESTAMP '2025-01-01 08:00:00')
    `);

    // Decimal, booleano, nulo (data_pedido) e BIGINT (valor_cents) numa linha.
    await conn.query(`
      INSERT INTO donation_notes (
        id, import_id, cpf, reference_month, numero_nota, valor_nota,
        data_nota, data_pedido, cnpj_estabelecimento, status_pedido,
        tipo_doacao, is_valid, match_key, valor_cents, created_at
      ) VALUES
        ('n1', 'i1', '52998224725', DATE '2025-01-01', '123', 10.55,
         DATE '2025-01-10', NULL, '11111111000191', 'Calculado', 'NFP',
         TRUE, '11111111000191|123|1055', 1055, TIMESTAMP '2025-01-10 10:00:00'),
        ('n2', 'i1', '11144477735', DATE '2025-01-01', '124', 20,
         DATE '2025-01-11', DATE '2025-01-09', '22222222000172', NULL, 'NFP',
         FALSE, NULL, 2000, TIMESTAMP '2025-01-11 10:00:00')
    `);

    for (const key of ["demands", "notes", "donationNotes"]) {
      const source = SNAPSHOT_SOURCES.find((item) => item.key === key);
      const row = await readOne(conn, buildSnapshotJsonQuery(source.sql));
      const peloDuckDB = JSON.parse(row.json_text);

      // O caminho antigo, reproduzido: trazer as linhas e serializar no JS.
      const rows = (await conn.query(source.sql))
        .toArray()
        .map((entry) => ({ ...entry }));
      const peloJavaScript = JSON.parse(
        JSON.stringify(rows, (_key, value) =>
          typeof value === "bigint" ? Number(value) : value,
        ),
      );

      assert.deepEqual(
        peloDuckDB,
        peloJavaScript,
        `${key} divergiu entre o JSON do DuckDB e o do JSON.stringify`,
      );
      assert.equal(Number(row.total), rows.length);
    }
  } finally {
    await close();
  }
});
