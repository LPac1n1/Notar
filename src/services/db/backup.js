import {
  SNAPSHOT_PAYLOAD_VERSION,
  buildSnapshotStats,
  normalizeSnapshotPayload,
  snapshotHasData,
} from "../../utils/backup.js";
import {
  SNAPSHOT_SOURCES,
  buildSnapshotJsonQuery,
} from "./snapshotSources.js";
import {
  execute,
  executePrepared,
  flushAfterTransaction,
  getConnection,
  initDB,
  runInTransaction,
  runStructuralReload,
} from "./connection.js";
import { notifyDatabaseChanged } from "./events.js";
import { CREDIT_RECONCILE_STATEMENTS } from "../reconciliation/creditReconcileSql.js";
import { query } from "./connection.js";

export const RESTORE_TABLE_COLUMNS = {
  projects: [
    "id",
    "display_order",
    "name",
    "slug",
    "modules",
    "color",
    "is_active",
    "created_at",
    "updated_at",
  ],
  donor_project_assignments: [
    "id",
    "donor_id",
    "project_id",
    "valid_from",
    "valid_to",
    "reason",
    "created_at",
  ],
  demands: [
    "id",
    "project_id",
    "name",
    "color",
    "is_active",
    "created_at",
    "updated_at",
  ],
  people: [
    "id",
    "project_id",
    "name",
    "cpf",
    "is_active",
    "created_at",
    "updated_at",
  ],
  donors: [
    "id",
    "person_id",
    "name",
    "cpf",
    "demand",
    "donor_type",
    "holder_donor_id",
    "holder_person_id",
    "donation_start_date",
    "is_active",
    "created_at",
    "updated_at",
  ],
  donor_cpf_links: [
    "id",
    "donor_id",
    "name",
    "cpf",
    "donation_start_date",
    "link_type",
    "is_active",
    "created_at",
    "updated_at",
  ],
  imports: [
    "id",
    "reference_month",
    "file_name",
    "value_per_note",
    "total_rows",
    "matched_rows",
    "matched_donors",
    "status",
    "notes",
    "cnpj_entidade_social",
    "imported_at",
    "updated_at",
  ],
  import_cpf_summary: [
    "id",
    "import_id",
    "reference_month",
    "cpf",
    "notes_count",
    "invalid_notes_count",
    "matched_donor_id",
    "matched_source_id",
    "is_registered_donor",
    "created_at",
    "updated_at",
  ],
  monthly_donor_summary: [
    "id",
    "import_id",
    "donor_id",
    "reference_month",
    "cpf",
    "donor_name",
    "demand",
    "notes_count",
    "invalid_notes_count",
    "value_per_note",
    "abatement_amount",
    "abatement_status",
    "abatement_marked_at",
    "created_at",
    "updated_at",
  ],
  notes: [
    "id",
    "project_id",
    "title",
    "content",
    "color",
    "created_at",
    "updated_at",
  ],
  action_history: [
    "id",
    "action_type",
    "entity_type",
    "entity_id",
    "label",
    "description",
    "payload_json",
    "created_at",
  ],
  donor_activity_history: [
    "id",
    "donor_id",
    "event_type",
    "reference_month",
    "created_at",
  ],
  abatement_adjustments: [
    "id",
    "donor_id",
    "reference_month",
    "range_start_month",
    "range_end_month",
    "notes_count",
    "abatement_amount",
    "description",
    "abatement_status",
    "abatement_marked_at",
    "created_at",
    "updated_at",
  ],
  trash_items: [
    "id",
    "entity_type",
    "entity_id",
    "label",
    "payload_json",
    "deleted_at",
  ],
  donation_notes: [
    "id",
    "import_id",
    "cpf",
    "reference_month",
    "numero_nota",
    "valor_nota",
    "data_nota",
    "data_pedido",
    "cnpj_estabelecimento",
    "status_pedido",
    "tipo_doacao",
    "is_valid",
    "match_key",
    "valor_cents",
    "created_at",
  ],
  credit_imports: [
    "id",
    "reference_month",
    "file_name",
    "total_rows",
    "valid_rows",
    "status",
    "notes",
    "imported_at",
    "updated_at",
  ],
  credit_notes: [
    "id",
    "credit_import_id",
    "cnpj_estabelecimento",
    "emitente",
    "numero_nota",
    "data_emissao",
    "valor_nf",
    "data_registro",
    "credito",
    "situacao",
    "is_valid",
    "match_key",
    "valor_cents",
    "created_at",
  ],
  // `credit_reconciliation` não tem colunas de restauração: não vem do
  // arquivo, é refeita a partir das notas no fim de
  // `restoreDatabaseSnapshot`.
};


/**
 * Monta o snapshot como TEXTO, com o JSON gerado pelo próprio DuckDB.
 *
 * O caminho anterior trazia cada linha para o JavaScript (`.toArray()`) e
 * depois passava tudo por `JSON.stringify`. Com um ano de uso — 30 mil notas
 * de doação e outras tantas de crédito — isso media 552ms de thread
 * principal TRAVADA, medido com PerformanceObserver. E não acontecia uma vez:
 * a nuvem regrava o snapshot a cada alteração, então a interface engasgava a
 * cada gravação.
 *
 * `json_group_array` faz o mesmo trabalho dentro do worker do DuckDB, que é
 * outra thread. O que volta é uma string pronta por tabela; o envelope sai de
 * concatenação, que o V8 resolve por referência em vez de copiar.
 *
 * A fidelidade foi conferida campo a campo contra a saída do `JSON.stringify`
 * (acento, aspas, barra invertida, null, booleano, BIGINT e tabela vazia). A
 * única diferença é textual — o DuckDB escreve `2.0` onde o JS escreve `2` —
 * e some no parse, porque os dois viram o mesmo número.
 *
 * O `count(*)` sai na MESMA consulta de propósito: contar à parte significaria
 * varrer a tabela duas vezes e abriria a chance de o número não bater com o
 * conteúdo, caso alguma gravação caísse entre as duas.
 */
export async function exportSnapshotText() {
  if (!getConnection()) {
    return null;
  }

  const parts = [];
  const counts = {};

  for (const source of SNAPSHOT_SOURCES) {
    const rows = await query(buildSnapshotJsonQuery(source.sql));

    const row = rows[0] ?? {};
    parts.push(JSON.stringify(source.key) + ":" + (row.json_text ?? "[]"));
    counts[source.key] = Number(row.total ?? 0);
  }

  const exportedAt = new Date().toISOString();
  const text =
    "{" +
    JSON.stringify("version") + ":" + JSON.stringify(SNAPSHOT_PAYLOAD_VERSION) + "," +
    JSON.stringify("exportedAt") + ":" + JSON.stringify(exportedAt) + "," +
    JSON.stringify("data") + ":{" + parts.join(",") + "}" +
    "}";

  return { text, exportedAt, counts };
}
export async function restoreDatabaseSnapshot(
  snapshot,
  { allowEmpty = false, emitChange = true, onProgress } = {},
) {
  const normalizedSnapshot = normalizeSnapshotPayload(snapshot);

  if (!normalizedSnapshot) {
    throw new Error("O arquivo de backup não está em um formato válido.");
  }

  if (!allowEmpty && !snapshotHasData(normalizedSnapshot)) {
    return;
  }

  const tableOrderToClear = [
    // Reconciliation derived data first — references both donation_notes
    // and credit_notes, so wiping it before its sources avoids dangling
    // references during the rebuild.
    "credit_reconciliation",
    "credit_notes",
    "donation_notes",
    "abatement_adjustments",
    "donor_activity_history",
    "action_history",
    "notes",
    "monthly_donor_summary",
    "import_cpf_summary",
    "imports",
    "credit_imports",
    // Vínculos antes de donors: eles referenciam o doador e o projeto.
    "donor_project_assignments",
    "donor_cpf_links",
    "donors",
    "people",
    "demands",
    "projects",
    "trash_items",
  ];
  const tableEntriesToInsert = [
    ["projects", normalizedSnapshot.projects],
    ["demands", normalizedSnapshot.demands],
    ["people", normalizedSnapshot.people],
    ["donors", normalizedSnapshot.donors],
    ["donor_cpf_links", normalizedSnapshot.donorCpfLinks],
    ["donor_project_assignments", normalizedSnapshot.donorProjectAssignments],
    ["imports", normalizedSnapshot.imports],
    ["donation_notes", normalizedSnapshot.donationNotes],
    ["import_cpf_summary", normalizedSnapshot.importCpfSummary],
    ["monthly_donor_summary", normalizedSnapshot.monthlyDonorSummary],
    ["notes", normalizedSnapshot.notes],
    ["action_history", normalizedSnapshot.actionHistory],
    ["donor_activity_history", normalizedSnapshot.donorActivityHistory],
    ["abatement_adjustments", normalizedSnapshot.abatementAdjustments],
    ["credit_imports", normalizedSnapshot.creditImports],
    ["credit_notes", normalizedSnapshot.creditNotes],
    ["trash_items", normalizedSnapshot.trashItems],
  ];

  // Chunked bulk insert. Restoring a 30k+ row table one INSERT at a time
  // through DuckDB-WASM's single-threaded executor took several seconds per
  // table; multi-row VALUES in batches of 500 brings the same load under a
  // second. The chunk size leaves plenty of headroom under DuckDB's parsed-
  // SQL size limit even for the widest table here (donation_notes, 13 cols).
  const BULK_INSERT_CHUNK_SIZE = 500;

  // Pre-compute the per-table row count so the progress callback can
  // report a meaningful "X / Y rows" indicator. Costs an extra pass over
  // the snapshot but it's all in-memory JS arrays — negligible compared
  // to the actual INSERTs.
  const totalRowsToInsert = tableEntriesToInsert.reduce(
    (sum, [, rows]) => sum + (rows?.length ?? 0),
    0,
  );
  let restoredRows = 0;
  const notifyProgress = (tableName) => {
    if (typeof onProgress !== "function") return;
    onProgress({
      phase: "restore",
      currentTable: tableName,
      restoredRows,
      totalRows: totalRowsToInsert,
    });
  };

  await runInTransaction(
    async () => {
      for (const tableName of tableOrderToClear) {
        await execute(`DELETE FROM ${tableName}`);
      }

      for (const [tableName, rows] of tableEntriesToInsert) {
        if (!rows || rows.length === 0) continue;

        const allowedColumns = RESTORE_TABLE_COLUMNS[tableName] ?? [];
        if (allowedColumns.length === 0) continue;

        notifyProgress(tableName);

        // Decide the column set ONCE per table — taken from the union of
        // allowed columns and what the first row carries. All subsequent
        // rows are coerced to the same column order; missing keys serialize
        // as NULL so a heterogeneous payload (legacy backup without new
        // columns) still imports cleanly.
        const sampleColumns = Object.keys(rows[0] ?? {}).filter((columnName) =>
          allowedColumns.includes(columnName),
        );
        if (sampleColumns.length === 0) continue;

        for (
          let chunkStart = 0;
          chunkStart < rows.length;
          chunkStart += BULK_INSERT_CHUNK_SIZE
        ) {
          const chunk = rows.slice(
            chunkStart,
            chunkStart + BULK_INSERT_CHUNK_SIZE,
          );
          // Os valores vêm do arquivo de backup, que é conteúdo fornecido
          // pelo usuário — é a entrada menos confiável que chega ao banco.
          // Por isso vão todos por parâmetro, e o SQL varia só na quantidade
          // de tuplas. Os nomes de coluna continuam interpolados porque o
          // DuckDB não aceita `?` em posição de identificador, mas eles já
          // passaram pela allowlist de `allowedColumns` logo acima.
          const rowPlaceholders = `(${sampleColumns.map(() => "?").join(", ")})`;
          const valuesSql = chunk.map(() => rowPlaceholders).join(",\n");
          const params = chunk.flatMap((row) =>
            sampleColumns.map((columnName) => {
              const value = row[columnName];
              return value === undefined ? null : value;
            }),
          );

          await executePrepared(
            `
            INSERT INTO ${tableName} (${sampleColumns.join(", ")})
            VALUES ${valuesSql}
          `,
            params,
          );
          restoredRows += chunk.length;
          notifyProgress(tableName);
        }
      }

      // A reposição do estado de projeto (projeto padrão, demanda sem
      // projeto, doador sem vínculo) NÃO fica aqui: vive em
      // `runSchemaBootstrap`, que roda logo abaixo no reload estrutural.
      // Precisa ser lá porque as normalizações podem CRIAR doadores — a
      // conversão do modelo antigo de auxiliares é um caso — e um doador
      // criado depois deste ponto ficaria sem vínculo.
    },
    { emitChange: false },
  );

  await runStructuralReload();

  // A conciliação não viaja no arquivo: é refeita aqui, com as mesmas
  // instruções que o motor usa em toda importação.
  //
  // Vem DEPOIS do reload estrutural, e não dentro da transação acima: é o
  // reload que preenche `match_key`/`valor_cents` em arquivos anteriores a
  // essas colunas. Conciliar antes disso deixaria todas as notas de um
  // backup antigo sem par.
  //
  // Arquivos antigos que trazem a tabela gravada também passam por aqui —
  // as linhas deles são ignoradas, então o resultado segue sempre a regra
  // de conciliação atual, e não a do dia em que o arquivo foi salvo.
  if (typeof onProgress === "function") {
    onProgress({
      phase: "reconcile",
      currentTable: "credit_reconciliation",
      restoredRows,
      totalRows: totalRowsToInsert,
    });
  }
  await runInTransaction(
    async () => {
      for (const statement of CREDIT_RECONCILE_STATEMENTS) {
        await execute(statement);
      }
    },
    { emitChange: false },
  );

  await flushAfterTransaction();
  if (emitChange) {
    notifyDatabaseChanged({ source: "restore" });
  }
}

function createBackupFileName() {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");

  return `notar-backup-${year}-${month}-${day}-${hours}${minutes}.json`;
}


/**
 * Arquivo de backup para download.
 *
 * Sai sem indentação: são dezenas de MB, e recuar cada linha triplicaria o
 * arquivo para agradar uma leitura humana que ninguém faz — o destino dele é
 * voltar pelo próprio importador.
 */
export async function exportDatabaseBackup() {
  await initDB();

  const snapshot = await exportSnapshotText();

  if (!snapshot) {
    throw new Error("O banco de dados ainda não está disponível.");
  }

  return {
    fileName: createBackupFileName(),
    text: snapshot.text,
    exportedAt: snapshot.exportedAt,
    stats: snapshot.counts,
  };
}

export async function importDatabaseBackup(file, { emitChange = true } = {}) {
  if (!file) {
    throw new Error("Selecione um arquivo de backup para importar.");
  }

  const fileText = await file.text();

  if (!fileText.trim()) {
    throw new Error("O arquivo de backup está vazio.");
  }

  let parsedPayload = null;

  try {
    parsedPayload = JSON.parse(fileText);
  } catch {
    throw new Error("O arquivo selecionado não contém um JSON válido.");
  }

  const snapshot = normalizeSnapshotPayload(parsedPayload);

  if (!snapshot) {
    throw new Error("O arquivo selecionado não parece ser um backup válido do Notar.");
  }

  await restoreDatabaseSnapshot(snapshot, { allowEmpty: true, emitChange });

  return {
    stats: buildSnapshotStats(snapshot),
  };
}
