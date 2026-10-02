import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestConnection } from "./helpers/duckdbHelper.js";
import { runMigrations } from "../src/services/db/migrations.js";
import { SNAPSHOT_SOURCES } from "../src/services/db/snapshotSources.js";
import {
  COLUMN_TYPES_SQL,
  buildJsonRestoreInsertSql,
  restoreFileNameFor,
} from "../src/services/db/restoreSql.js";
import {
  MANIFEST_OBJECT_NAME,
  RETIRED_FILE_RETENTION_MS,
  SNAPSHOT_MANIFEST_FORMAT,
  SNAPSHOT_MANIFEST_VERSION,
  buildLegacyTombstoneText,
  buildManifest,
  buildPartExportQuery,
  buildPartFileName,
  buildPartFingerprintsQuery,
  buildPartId,
  buildSourceColumnsQuery,
  countManifestRows,
  findMissingPartFiles,
  fingerprintOf,
  listCurrentParts,
  listReferencedFiles,
  parseManifest,
  planPartUploads,
  selectOrphanFiles,
} from "../src/services/db/snapshotParts.js";

/**
 * O snapshot em partes.
 *
 * O que estes testes protegem, em ordem de gravidade:
 *
 *  1. Parte que mudou e não sobe. A decisão de subir sai da impressão
 *     digital; se ela não mudar quando o conteúdo muda, a alteração fica só
 *     neste navegador, com o sistema dizendo "sincronizado".
 *  2. Linha que some ou duplica ao dividir a tabela.
 *  3. Índice mal lido: quem abre restaura o que o índice diz e, na gravação
 *     seguinte, sobe isso por cima do resto.
 */

function rows(result) {
  return result.toArray().map((row) => row.toJSON());
}

async function bootstrap() {
  const conn = await createTestConnection();
  await runMigrations(conn);
  return conn;
}

async function seed(conn) {
  await conn.query(`
    INSERT INTO monthly_donor_summary (
      id, import_id, donor_id, reference_month, cpf, donor_name, demand,
      notes_count, invalid_notes_count, value_per_note, abatement_amount,
      abatement_status, abatement_marked_at, created_at, updated_at
    )
    VALUES
      ('s1', 'imp-a', 'd1', DATE '2026-01-01', '11111111111', 'JOÃO "ZÉ"', 'A',
       3, 0, 1.5, 4.5, 'pending', NULL,
       TIMESTAMP '2026-01-05 10:00:00', TIMESTAMP '2026-01-05 10:00:00'),
      ('s2', 'imp-a', 'd2', DATE '2026-01-01', '22222222222', 'MARIA', 'A',
       5, 1, 1.5, 7.5, 'pending', NULL,
       TIMESTAMP '2026-01-05 10:00:00', TIMESTAMP '2026-01-05 10:00:00')
  `);
  await conn.query(`
    INSERT INTO donation_notes (
      id, import_id, cpf, reference_month, numero_nota, valor_nota, data_nota,
      cnpj_estabelecimento, is_valid, match_key, valor_cents, created_at
    )
    VALUES
      ('n1', 'imp-a', '11111111111', DATE '2026-01-01', '000123', 10.55, DATE '2026-01-10',
       '11111111000191', TRUE, '11111111000191|123', 1055, TIMESTAMP '2026-01-10 10:00:00'),
      ('n2', 'imp-a', '22222222222', DATE '2026-01-01', '124', 20, DATE '2026-01-11',
       '22222222000172', FALSE, NULL, 2000, TIMESTAMP '2026-01-11 10:00:00'),
      ('n3', 'imp-b', '11111111111', DATE '2026-02-01', '9', 0.1, DATE '2026-02-03',
       '11111111000191', TRUE, '11111111000191|9', 10, TIMESTAMP '2026-02-03 10:00:00'),
      ('n4', NULL, '11111111111', DATE '2026-02-01', '10', 1, NULL,
       NULL, TRUE, NULL, 100, TIMESTAMP '2026-02-03 10:00:00')
  `);
}

async function fingerprintRows(conn) {
  const byKey = {};
  for (const source of SNAPSHOT_SOURCES) {
    byKey[source.key] = rows(await conn.query(buildPartFingerprintsQuery(source.key)));
  }
  return byKey;
}

async function currentParts(conn) {
  return listCurrentParts(await fingerprintRows(conn));
}

const partOf = (parts, id) => parts.find((part) => part.id === id);

async function exportPart(conn, part) {
  const statement = await conn.prepare(buildPartExportQuery(part.key));
  try {
    const params = part.id.includes("/") ? [part.partition] : [];
    return rows(await statement.query(...params))[0];
  } finally {
    await statement.close();
  }
}

test("a impressão digital muda quando DUAS linhas recebem o mesmo valor novo", async () => {
  // O caso de "abater em massa". O hash de linha do DuckDB combina a última
  // coluna por ou-exclusivo: duas linhas com o mesmo `updated_at` novo se
  // cancelam, e uma impressão feita só de `bit_xor(hash(linha))` não muda —
  // a parte não subiria.
  const conn = await bootstrap();
  try {
    await seed(conn);
    const before = partOf(await currentParts(conn), "monthlyDonorSummary").fingerprint;

    await conn.query(
      "UPDATE monthly_donor_summary SET updated_at = TIMESTAMP '2026-03-03 12:00:00'",
    );
    const afterLastColumn = partOf(await currentParts(conn), "monthlyDonorSummary").fingerprint;
    assert.notEqual(afterLastColumn, before);

    await conn.query("UPDATE monthly_donor_summary SET abatement_status = 'applied'");
    const afterStatus = partOf(await currentParts(conn), "monthlyDonorSummary").fingerprint;
    assert.notEqual(afterStatus, afterLastColumn);

    // Desfazer devolve a impressão antiga: ela descreve o conteúdo, não a
    // história.
    await conn.query(`
      UPDATE monthly_donor_summary
      SET abatement_status = 'pending', updated_at = TIMESTAMP '2026-01-05 10:00:00'
    `);
    assert.equal(
      partOf(await currentParts(conn), "monthlyDonorSummary").fingerprint,
      before,
    );
  } finally {
    conn.close();
  }
});

test("a impressão digital é a mesma em outro banco com o mesmo conteúdo", async () => {
  // Sem isto, todo computador que abrisse o sistema acharia que TUDO mudou e
  // subiria o banco inteiro na primeira gravação.
  const first = await bootstrap();
  const second = await bootstrap();
  try {
    await seed(first);
    await seed(second);

    const pick = (parts) =>
      parts
        .filter((part) => ["monthlyDonorSummary", "donationNotes"].includes(part.key))
        .map((part) => [part.id, part.fingerprint]);

    assert.deepEqual(pick(await currentParts(first)), pick(await currentParts(second)));
  } finally {
    first.close();
    second.close();
  }
});

test("as notas viram uma parte por importação, e mexer numa não muda as outras", async () => {
  const conn = await bootstrap();
  try {
    await seed(conn);
    const before = await currentParts(conn);

    assert.deepEqual(
      before.filter((part) => part.key === "donationNotes").map((part) => [part.id, part.rows]),
      [
        // Nota sem importação tem a própria parte: não pode sumir.
        ["donationNotes/", 1],
        ["donationNotes/imp-a", 2],
        ["donationNotes/imp-b", 1],
      ],
    );
    // Tabela dividida e vazia não tem parte; tabela inteira e vazia tem.
    assert.equal(before.some((part) => part.key === "creditNotes"), false);
    assert.equal(partOf(before, "people").rows, 0);

    await conn.query("UPDATE donation_notes SET valor_cents = 1056 WHERE id = 'n1'");
    const after = await currentParts(conn);

    const changed = after
      .filter((part) => partOf(before, part.id)?.fingerprint !== part.fingerprint)
      .map((part) => part.id);
    assert.deepEqual(changed, ["donationNotes/imp-a"]);
  } finally {
    conn.close();
  }
});

test("as partes de uma tabela, juntas, são a tabela: nenhuma linha some ou repete", async () => {
  const conn = await bootstrap();
  try {
    await seed(conn);
    const parts = (await currentParts(conn)).filter((part) => part.key === "donationNotes");

    const ids = [];
    for (const part of parts) {
      const exported = await exportPart(conn, part);
      const list = JSON.parse(exported.json_text);

      // A impressão que sai junto do JSON é a mesma da varredura.
      assert.equal(fingerprintOf(exported), part.fingerprint);
      assert.equal(list.length, part.rows);
      ids.push(...list.map((row) => row.id));
    }

    assert.deepEqual(ids.sort(), ["n1", "n2", "n3", "n4"]);
  } finally {
    conn.close();
  }
});

test("ida e volta: o que sai em partes volta idêntico", async () => {
  const source = await bootstrap();
  const target = await bootstrap();
  try {
    await seed(source);
    const parts = await currentParts(source);

    const columnTypes = new Map();
    for (const row of rows(await target.query(COLUMN_TYPES_SQL))) {
      if (!columnTypes.has(row.table_name)) columnTypes.set(row.table_name, new Map());
      columnTypes.get(row.table_name).set(row.column_name, row.data_type);
    }

    const tables = {
      monthlyDonorSummary: "monthly_donor_summary",
      donationNotes: "donation_notes",
    };
    for (const [key, table] of Object.entries(tables)) {
      const columns = rows(await source.query(buildSourceColumnsQuery(key))).map((row) =>
        String(row.column_name),
      );
      const keyParts = parts.filter((part) => part.key === key);

      for (const [index, part] of keyParts.entries()) {
        const fileName = restoreFileNameFor(table, index);
        target.registerFileText(fileName, (await exportPart(source, part)).json_text);
        try {
          await target.query(
            buildJsonRestoreInsertSql({
              table,
              columns,
              columnTypes: columnTypes.get(table),
              fileName,
            }),
          );
        } finally {
          target.dropFile(fileName);
        }
      }
    }

    const pick = (list) =>
      list
        .filter((part) => Object.keys(tables).includes(part.key))
        .map((part) => [part.id, part.rows, part.fingerprint]);

    // Mesmas partes, mesmas contagens, mesmas impressões: acento, aspas,
    // zero à esquerda, decimal, nulo, booleano e BIGINT voltaram como eram.
    assert.deepEqual(pick(await currentParts(target)), pick(parts));
  } finally {
    source.close();
    target.close();
  }
});

test("as colunas de uma parte são as que o SELECT exporta", async () => {
  const conn = await bootstrap();
  try {
    const columns = rows(await conn.query(buildSourceColumnsQuery("donors"))).map(
      (row) => String(row.column_name),
    );
    assert.ok(columns.includes("donation_start_date"));
    assert.equal(columns[0], "id");
  } finally {
    conn.close();
  }
});

// ── Decisões sobre o índice (sem banco) ────────────────────────────────

function fakeParts() {
  const fingerprints = Object.fromEntries(
    SNAPSHOT_SOURCES.map((source) => [source.key, [{ partition: "", total: 0 }]]),
  );
  fingerprints.donors = [{ partition: "", total: 2, row_sum: "10", row_xor: "20" }];
  fingerprints.donationNotes = [
    { partition: "imp-a", total: 3, row_sum: "30", row_xor: "40" },
    { partition: "imp-b", total: 1, row_sum: "50", row_xor: "60" },
  ];
  fingerprints.creditNotes = [];
  return listCurrentParts(fingerprints);
}

function uploaded(plan) {
  return plan.map((part) => ({
    ...part,
    file: part.file ?? buildPartFileName(part.key, part.partition, part.fingerprint),
    bytes: part.bytes ?? 10,
  }));
}

const COLUMNS = { donors: ["id", "name"] };

test("na primeira gravação tudo sobe; depois, só o que mudou", () => {
  const parts = fakeParts();

  const first = planPartUploads(parts, null);
  assert.equal(first.every((part) => part.upload), true);

  const { manifest } = buildManifest({
    parts: uploaded(first),
    columnsByKey: COLUMNS,
    exportedAt: "2026-10-02T12:00:00.000Z",
  });

  // Nada mudou: nada sobe.
  assert.equal(planPartUploads(parts, manifest).some((part) => part.upload), false);

  // Muda uma importação e entra outra.
  const changed = parts.map((part) =>
    part.id === "donationNotes/imp-a" ? { ...part, fingerprint: "3-31-41" } : part,
  );
  changed.push({
    id: "donationNotes/imp-c",
    key: "donationNotes",
    partition: "imp-c",
    rows: 4,
    fingerprint: "4-1-1",
  });

  assert.deepEqual(
    planPartUploads(changed, manifest)
      .filter((part) => part.upload)
      .map((part) => part.id),
    ["donationNotes/imp-a", "donationNotes/imp-c"],
  );
});

test("arquivo que sai do índice fica guardado um tempo antes de ser apagado", () => {
  const start = Date.parse("2026-10-02T12:00:00.000Z");
  const parts = fakeParts();
  const first = buildManifest({
    parts: uploaded(planPartUploads(parts, null)),
    columnsByKey: COLUMNS,
    exportedAt: new Date(start).toISOString(),
    now: start,
  });
  const oldFile = first.manifest.parts.find((part) => part.id === "donors").file;

  // Os doadores mudam: o arquivo antigo sai das partes, mas NÃO é apagado —
  // quem começou a abrir o sistema pelo índice anterior ainda vai baixá-lo.
  const changed = parts.map((part) =>
    part.id === "donors" ? { ...part, fingerprint: "2-11-21" } : part,
  );
  const second = buildManifest({
    parts: uploaded(planPartUploads(changed, first.manifest)),
    columnsByKey: COLUMNS,
    previousManifest: first.manifest,
    exportedAt: new Date(start + 5_000).toISOString(),
    now: start + 5_000,
  });
  assert.deepEqual(second.filesToDelete, []);
  assert.deepEqual(second.manifest.retired.map((entry) => entry.file), [oldFile]);
  assert.equal(listReferencedFiles(second.manifest).has(oldFile), true);

  // Gravações seguintes dentro do prazo continuam guardando, com a hora
  // ORIGINAL — senão cada gravação renovaria o prazo para sempre.
  const third = buildManifest({
    parts: uploaded(planPartUploads(changed, second.manifest)),
    columnsByKey: COLUMNS,
    previousManifest: second.manifest,
    exportedAt: new Date(start + 60_000).toISOString(),
    now: start + 60_000,
  });
  assert.deepEqual(third.filesToDelete, []);
  assert.equal(third.manifest.retired[0].at, new Date(start + 5_000).toISOString());

  // Passado o prazo, sai do índice e vai para a lista de apagar.
  const later = start + 5_000 + RETIRED_FILE_RETENTION_MS;
  const fourth = buildManifest({
    parts: uploaded(planPartUploads(changed, third.manifest)),
    columnsByKey: COLUMNS,
    previousManifest: third.manifest,
    exportedAt: new Date(later).toISOString(),
    now: later,
  });
  assert.deepEqual(fourth.filesToDelete, [oldFile]);
  assert.deepEqual(fourth.manifest.retired, []);
});

test("arquivo que volta a ser usado sai da lista de guardados", () => {
  const start = Date.parse("2026-10-02T12:00:00.000Z");
  const parts = fakeParts();
  const first = buildManifest({
    parts: uploaded(planPartUploads(parts, null)),
    columnsByKey: COLUMNS,
    exportedAt: "a",
    now: start,
  });
  const changed = parts.map((part) =>
    part.id === "donors" ? { ...part, fingerprint: "2-11-21" } : part,
  );
  const second = buildManifest({
    parts: uploaded(planPartUploads(changed, first.manifest)),
    columnsByKey: COLUMNS,
    previousManifest: first.manifest,
    exportedAt: "b",
    now: start + 1_000,
  });

  // O usuário desfez a alteração: o conteúdo volta a ser o do arquivo
  // antigo, que precisa deixar de estar marcado para apagar.
  const third = buildManifest({
    parts: uploaded(planPartUploads(parts, second.manifest)),
    columnsByKey: COLUMNS,
    previousManifest: second.manifest,
    exportedAt: "c",
    now: start + RETIRED_FILE_RETENTION_MS * 2,
  });
  const reused = third.manifest.parts.find((part) => part.id === "donors").file;

  assert.equal(third.filesToDelete.includes(reused), false);
  assert.equal(third.manifest.retired.some((entry) => entry.file === reused), false);
});

test("arquivo que nenhum índice cita só é apagado depois de velho", () => {
  const now = Date.parse("2026-10-02T12:00:00.000Z");
  const { manifest } = buildManifest({
    parts: uploaded(planPartUploads(fakeParts(), null)),
    columnsByKey: COLUMNS,
    exportedAt: "a",
    now,
  });
  const current = manifest.parts[0].file;
  const old = new Date(now - RETIRED_FILE_RETENTION_MS - 1).toISOString();
  const fresh = new Date(now - 1_000).toISOString();

  const orphans = selectOrphanFiles(
    [
      { name: current, created_at: old },
      // Sobra de um envio que falhou antes do índice, há muito tempo.
      { name: "donors.9-9-9.json.gz", created_at: old },
      // Pode ser de um envio em andamento em outro computador.
      { name: "donors.8-8-8.json.gz", created_at: fresh },
      // Não é arquivo de parte: nunca é tocado.
      { name: "anotacao-do-usuario.txt", created_at: old },
      { name: "parts", created_at: null },
    ],
    manifest,
    now,
  );

  assert.deepEqual(orphans, ["donors.9-9-9.json.gz"]);
});

test("a conferência das partes acusa arquivo que falta ou com outro tamanho", () => {
  const { manifest } = buildManifest({
    parts: uploaded(planPartUploads(fakeParts(), null)),
    columnsByKey: COLUMNS,
    exportedAt: "a",
  });
  const listing = manifest.parts.map((part) => ({
    name: part.file,
    metadata: { size: part.bytes },
  }));

  assert.deepEqual(findMissingPartFiles(listing, manifest), []);
  assert.deepEqual(findMissingPartFiles(listing.slice(1), manifest), [
    manifest.parts[0].file,
  ]);

  const truncated = listing.map((entry, index) =>
    index === 2 ? { ...entry, metadata: { size: 3 } } : entry,
  );
  assert.deepEqual(findMissingPartFiles(truncated, manifest), [manifest.parts[2].file]);

  // Listagem sem tamanho (alguns servidores não devolvem): a presença basta.
  assert.deepEqual(
    findMissingPartFiles(listing.map((entry) => ({ name: entry.name })), manifest),
    [],
  );
});

test("o índice gravado é lido de volta", () => {
  const { manifest } = buildManifest({
    parts: uploaded(planPartUploads(fakeParts(), null)),
    columnsByKey: COLUMNS,
    exportedAt: "2026-10-02T12:00:00.000Z",
    legacy: { archivedAs: "x.json", blockedAt: "2026-10-02T12:00:00.000Z" },
  });
  const read = parseManifest(JSON.stringify(manifest));

  assert.equal(read.format, SNAPSHOT_MANIFEST_FORMAT);
  assert.equal(read.version, SNAPSHOT_MANIFEST_VERSION);
  assert.deepEqual(read.parts, manifest.parts);
  assert.deepEqual(read.legacy, manifest.legacy);
  assert.equal(countManifestRows(read), 2 + 3 + 1);
  assert.equal(MANIFEST_OBJECT_NAME, "manifest.json");
});

test("índice que não dá para confiar é recusado, não lido pela metade", () => {
  const { manifest } = buildManifest({
    parts: uploaded(planPartUploads(fakeParts(), null)),
    columnsByKey: COLUMNS,
    exportedAt: "2026-10-02T12:00:00.000Z",
  });
  const broken = (change) => {
    const copy = JSON.parse(JSON.stringify(manifest));
    change(copy);
    return JSON.stringify(copy);
  };

  assert.throws(() => parseManifest("não é json"), /JSON válido/);
  assert.throws(() => parseManifest("{}"), /não é um índice/);
  assert.throws(() => parseManifest(broken((m) => delete m.parts)), /lista de partes/);

  // Gravado por uma versão mais nova: abrir assim perderia o que esta não
  // entende na primeira gravação.
  assert.throws(
    () => parseManifest(broken((m) => (m.version = SNAPSHOT_MANIFEST_VERSION + 1))),
    /versão mais nova/,
  );
  assert.throws(
    () =>
      parseManifest(
        broken((m) =>
          m.parts.push({ id: "tabelaNova", key: "tabelaNova", partition: "", file: "tabelaNova.0-0-0.json.gz" }),
        ),
      ),
    /não conhece/,
  );

  // Tabela faltando seria lida como "tabela vazia" e gravada assim.
  assert.throws(
    () => parseManifest(broken((m) => (m.parts = m.parts.filter((part) => part.id !== "donors")))),
    /sem a tabela donors/,
  );

  // Nome de arquivo que sai da pasta das partes.
  assert.throws(
    () => parseManifest(broken((m) => (m.parts[0].file = "../outro/dados.json"))),
    /nome inválido/,
  );
  assert.throws(
    () => parseManifest(broken((m) => m.parts.push({ ...m.parts[0] }))),
    /duas vezes/,
  );
});

test("o nome do arquivo de uma parte só tem caracteres que o armazenamento aceita", () => {
  assert.equal(buildPartId("donors"), "donors");
  assert.equal(buildPartId("donationNotes", "imp-a"), "donationNotes/imp-a");

  assert.equal(buildPartFileName("donors", "", "2-10-20"), "donors.2-10-20.json.gz");
  // A partição vai em hexadecimal: nenhum identificador consegue pôr barra,
  // ponto ou qualquer outro caractere no nome.
  assert.equal(
    buildPartFileName("donationNotes", "a/../b", "1-2-3"),
    "donationNotes.612f2e2e2f62.1-2-3.json.gz",
  );
  assert.equal(
    buildPartFileName("donationNotes", "", "1-2-3"),
    "donationNotes.-.1-2-3.json.gz",
  );
  assert.throws(() => buildPartFileName("naoExiste", "", "1-2-3"));
  assert.throws(() => buildPartFileName("donors", "", "1/2"));
});

test("o aviso que substitui o arquivo antigo faz a versão antiga PARAR, não abrir vazia", () => {
  const text = buildLegacyTombstoneText({
    archivedAs: "dados-formato-antigo.json",
    blockedAt: "2026-10-02T12:00:00.000Z",
  });

  // A versão antiga faz exatamente isto com o arquivo: se estiver vazio,
  // abre como "primeiro uso" (e grava por cima); se não for JSON, acusa erro
  // e não grava nada. Só o segundo caso protege.
  assert.notEqual(text.trim(), "");
  assert.throws(() => JSON.parse(text));
  // E não pode ser confundido com um arquivo comprimido.
  assert.notDeepEqual([text.charCodeAt(0), text.charCodeAt(1)], [0x1f, 0x8b]);
  assert.match(text, /dados-formato-antigo\.json/);
});
