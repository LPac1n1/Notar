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
  registerFileText,
  releaseRegisteredFile,
  runInTransaction,
  runStructuralReload,
} from "./connection.js";
import {
  COLUMN_TYPES_SQL,
  buildDropIndexSql,
  buildDuplicateKeyCheckSql,
  buildJsonRestoreInsertSql,
  buildRestorableIndexesSql,
  parseIndexColumns,
  restoreFileNameFor,
} from "./restoreSql.js";
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
/**
 * De qual tabela sai — e para qual volta — cada chave do snapshot, NA ORDEM
 * em que as tabelas são carregadas (quem é referenciado vem antes).
 */
const RESTORE_TABLES_IN_ORDER = [
  ["projects", "projects"],
  ["demands", "demands"],
  ["people", "people"],
  ["donors", "donors"],
  ["donor_cpf_links", "donorCpfLinks"],
  ["donor_project_assignments", "donorProjectAssignments"],
  ["imports", "imports"],
  ["donation_notes", "donationNotes"],
  ["import_cpf_summary", "importCpfSummary"],
  ["monthly_donor_summary", "monthlyDonorSummary"],
  ["notes", "notes"],
  ["action_history", "actionHistory"],
  ["donor_activity_history", "donorActivityHistory"],
  ["abatement_adjustments", "abatementAdjustments"],
  ["credit_imports", "creditImports"],
  ["credit_notes", "creditNotes"],
  ["trash_items", "trashItems"],
];

/**
 * Restaura o banco a partir de um snapshot inteiro em memória — o arquivo de
 * backup, ou o arquivo único antigo da nuvem.
 */
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

  // As colunas de cada tabela são decididas UMA vez: as permitidas que a
  // primeira linha traz. Chave ausente nas demais linhas vira NULL, então um
  // backup antigo, sem colunas mais novas, continua entrando.
  const tablesToLoad = [];
  for (const [tableName, key] of RESTORE_TABLES_IN_ORDER) {
    const rows = normalizedSnapshot[key];
    if (!rows || rows.length === 0) continue;

    const allowedColumns = RESTORE_TABLE_COLUMNS[tableName] ?? [];
    const columns = Object.keys(rows[0] ?? {}).filter((columnName) =>
      allowedColumns.includes(columnName),
    );
    if (columns.length === 0) continue;

    tablesToLoad.push({
      tableName,
      columns,
      files: [
        {
          rowCount: rows.length,
          // As linhas viajam para o worker como um texto só, e não valor a
          // valor.
          loadText: async () => JSON.stringify(rows),
          loadRows: async () => rows,
        },
      ],
    });
  }

  return restoreFromTableSources(tablesToLoad, { emitChange, onProgress });
}

/**
 * Restaura o banco a partir das PARTES do snapshot da nuvem.
 *
 * `tables`: `[{ key, columns, files: [{ rowCount, loadText }] }]`, onde
 * `loadText` devolve o JSON (um array) daquela parte. O texto vai direto
 * para o leitor de JSON do DuckDB: não existe um momento em que o banco
 * inteiro esteja num objeto ou num texto só — foi isso que fez o arquivo
 * único bater no tamanho máximo de texto do navegador.
 *
 * `columns` são as colunas que quem gravou exportou. Só entram as que esta
 * versão conhece; coluna que a parte não traz fica com o valor padrão da
 * tabela.
 */
export async function restoreDatabaseFromParts(
  tables,
  { emitChange = true, onProgress } = {},
) {
  const byKey = new Map((tables ?? []).map((table) => [table.key, table]));
  const tablesToLoad = [];

  for (const [tableName, key] of RESTORE_TABLES_IN_ORDER) {
    const table = byKey.get(key);
    const files = (table?.files ?? []).filter((file) => Number(file.rowCount) > 0);
    if (files.length === 0) continue;

    const allowedColumns = RESTORE_TABLE_COLUMNS[tableName] ?? [];
    const columns = Array.isArray(table.columns)
      ? table.columns.filter((columnName) => allowedColumns.includes(columnName))
      : allowedColumns;
    if (columns.length === 0) continue;

    tablesToLoad.push({
      tableName,
      columns,
      files: files.map((file) => ({
        rowCount: Number(file.rowCount),
        loadText: file.loadText,
        loadRows: async () => JSON.parse(await file.loadText()),
      })),
    });
  }

  return restoreFromTableSources(tablesToLoad, { emitChange, onProgress });
}

/**
 * O que as duas restaurações têm em comum: limpar, carregar, refazer o que é
 * derivado.
 *
 * `tablesToLoad`: `[{ tableName, columns, files }]`, com cada arquivo
 * sabendo entregar o próprio conteúdo como texto (caminho rápido) ou como
 * linhas (caminho de reserva).
 */
async function restoreFromTableSources(
  tablesToLoad,
  { emitChange = true, onProgress } = {},
) {
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
  // Total de linhas, para o indicador "X de Y" da tela de carregamento.
  const totalRowsToInsert = tablesToLoad.reduce(
    (sum, table) =>
      sum + table.files.reduce((count, file) => count + file.rowCount, 0),
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

  // A reposição do estado de projeto (projeto padrão, demanda sem projeto,
  // doador sem vínculo) NÃO fica em nenhum dos dois caminhos abaixo: vive em
  // `runSchemaBootstrap`, que roda logo depois, no reload estrutural. Precisa
  // ser lá porque as normalizações podem CRIAR doadores — a conversão do
  // modelo antigo de auxiliares é um caso — e um doador criado depois deste
  // ponto ficaria sem vínculo.
  let strategy = "json";
  try {
    restoredRows = 0;
    await restoreTablesFromJson({
      tableOrderToClear,
      tablesToLoad,
      onTableLoaded: (tableName, rowCount) => {
        restoredRows += rowCount;
        notifyProgress(tableName);
      },
      onTableStart: notifyProgress,
    });
  } catch (fastPathError) {
    // O caminho rápido depende do leitor de JSON do DuckDB, que é uma
    // extensão. Se ela não estiver disponível — ou se qualquer outra coisa
    // der errado —, a transação foi desfeita e o banco está como antes:
    // refaz pelo caminho antigo, mais lento e sem dependência nenhuma.
    console.warn(
      "Restauração rápida indisponível; usando o caminho por parâmetros.",
      fastPathError,
    );
    strategy = "parameters";
    restoredRows = 0;
    await restoreTablesWithParameters({
      tableOrderToClear,
      tablesToLoad,
      onChunkLoaded: (tableName, rowCount) => {
        restoredRows += rowCount;
        notifyProgress(tableName);
      },
      onTableStart: notifyProgress,
    });
  }

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

  return { strategy };
}

/**
 * Caminho rápido: o DuckDB lê o JSON de cada tabela (ver `restoreSql.js`).
 *
 * Três tempos, e a ordem é imposta pelo DuckDB:
 *
 *   1. Os índices são derrubados, fora de transação.
 *   2. Limpeza e carga rodam numa transação. Antes do commit, a unicidade
 *      que os índices únicos garantiriam é conferida por consulta.
 *   3. Os índices são recriados, depois do commit.
 *
 * Não dá para fazer tudo numa transação só. O DuckDB não aceita derrubar e
 * recriar um índice de mesmo nome na mesma transação; e um índice único
 * criado na transação que apagou e reinseriu a mesma chave enxerga as duas
 * versões da linha e acusa duplicata no commit.
 *
 * O que a ordem preserva: se a carga falhar — arquivo com chave repetida
 * incluído —, a transação é desfeita, os índices voltam sobre os dados
 * antigos e o banco fica como estava.
 */
async function restoreTablesFromJson({
  tableOrderToClear,
  tablesToLoad,
  onTableStart,
  onTableLoaded,
}) {
  const columnTypesByTable = new Map();
  for (const row of await query(COLUMN_TYPES_SQL)) {
    const tableName = String(row.table_name);
    if (!columnTypesByTable.has(tableName)) {
      columnTypesByTable.set(tableName, new Map());
    }
    columnTypesByTable
      .get(tableName)
      .set(String(row.column_name), String(row.data_type));
  }

  const indexes = await query(buildRestorableIndexesSql(tableOrderToClear));
  const registeredFiles = [];

  // A conferência de unicidade precisa saber as colunas de cada índice
  // único. Se algum não der para interpretar, o caminho rápido desiste
  // ANTES de mexer em qualquer coisa: carregar sem conseguir conferir seria
  // trocar uma garantia por velocidade.
  const uniqueKeys = indexes
    .filter((index) => Boolean(index.is_unique))
    .map((index) => {
      const columns = parseIndexColumns(index.sql);
      if (!columns) {
        throw new Error(
          `Índice único sem colunas reconhecíveis: ${String(index.index_name)}`,
        );
      }
      return { table: String(index.table_name), columns };
    });

  // `flush: false` nas instruções de índice: são estrutura, não dado. Sem
  // isso cada uma agendaria sincronização e avisaria as telas no meio da
  // restauração.
  for (const index of indexes) {
    await execute(buildDropIndexSql(String(index.index_name)), { flush: false });
  }

  try {
    await runInTransaction(
      async () => {
        for (const tableName of tableOrderToClear) {
          await execute(`DELETE FROM ${tableName}`);
        }

        for (const { tableName, columns, files } of tablesToLoad) {
          onTableStart?.(tableName);

          for (const [index, file] of files.entries()) {
            const fileName = restoreFileNameFor(tableName, index);
            // O conteúdo vem do arquivo de backup ou da nuvem — a entrada
            // menos confiável que chega ao banco —, e continua sem tocar em
            // SQL: é DADO lido pelo `read_json`, nunca parte da instrução.
            await registerFileText(fileName, await file.loadText());
            registeredFiles.push(fileName);

            await execute(
              buildJsonRestoreInsertSql({
                table: tableName,
                columns,
                columnTypes: columnTypesByTable.get(tableName) ?? new Map(),
                fileName,
              }),
            );

            // Solto assim que a parte entra: com dezenas de partes, segurar
            // todas até o fim seria manter o banco inteiro duas vezes na
            // memória do worker.
            await releaseRegisteredFile(fileName);
            registeredFiles.pop();

            onTableLoaded?.(tableName, file.rowCount);
          }
        }

        for (const { table, columns } of uniqueKeys) {
          const duplicated = await query(buildDuplicateKeyCheckSql(table, columns));
          if (duplicated.length > 0) {
            throw new Error(
              `O arquivo tem linhas repetidas em ${table} (${columns.join(", ")}).`,
            );
          }
        }
      },
      { emitChange: false },
    );
  } catch (error) {
    // A transação desfez a carga; os índices precisam voltar por aqui.
    // `IF NOT EXISTS` não se aplica — o SQL vem do catálogo como foi criado —,
    // então cada falha é engolida: um índice que por acaso já exista de novo
    // não pode impedir os outros de voltarem.
    for (const index of indexes) {
      await execute(String(index.sql), { flush: false }).catch(() => null);
    }
    throw error;
  } finally {
    for (const fileName of registeredFiles) {
      await releaseRegisteredFile(fileName);
    }
  }

  // Dados confirmados; os índices voltam. A unicidade já foi conferida, então
  // uma falha aqui não é esperada — mas, se acontecer, não pode impedir os
  // outros índices de voltarem nem derrubar uma restauração que já entrou.
  for (const index of indexes) {
    await execute(String(index.sql), { flush: false }).catch((error) => {
      console.error(
        `Restauração: não foi possível recriar o índice ${String(index.index_name)}.`,
        error,
      );
    });
  }
}

/**
 * Caminho antigo: blocos de 500 linhas, cada valor como parâmetro. Fica como
 * reserva do caminho rápido.
 */
async function restoreTablesWithParameters({
  tableOrderToClear,
  tablesToLoad,
  onTableStart,
  onChunkLoaded,
}) {
  const BULK_INSERT_CHUNK_SIZE = 500;

  await runInTransaction(
    async () => {
      for (const tableName of tableOrderToClear) {
        await execute(`DELETE FROM ${tableName}`);
      }

      for (const { tableName, columns, files } of tablesToLoad) {
        onTableStart?.(tableName);

        for (const file of files) {
          const rows = await file.loadRows();

          for (
            let chunkStart = 0;
            chunkStart < rows.length;
            chunkStart += BULK_INSERT_CHUNK_SIZE
          ) {
            const chunk = rows.slice(
              chunkStart,
              chunkStart + BULK_INSERT_CHUNK_SIZE,
            );
            // Os nomes de coluna são interpolados porque o DuckDB não aceita
            // `?` em posição de identificador, mas já passaram pela lista de
            // colunas permitidas. Os valores vão todos por parâmetro.
            const rowPlaceholders = `(${columns.map(() => "?").join(", ")})`;
            const valuesSql = chunk.map(() => rowPlaceholders).join(",\n");
            const params = chunk.flatMap((row) =>
              columns.map((columnName) => {
                const value = row[columnName];
                return value === undefined ? null : value;
              }),
            );

            await executePrepared(
              `
              INSERT INTO ${tableName} (${columns.join(", ")})
              VALUES ${valuesSql}
            `,
              params,
            );
            onChunkLoaded?.(tableName, chunk.length);
          }
        }
      }
    },
    { emitChange: false },
  );
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
