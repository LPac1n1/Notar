/**
 * SQL da restauração rápida: o próprio DuckDB lê o JSON de uma tabela.
 *
 * Módulo puro (sem import de banco), para o teste de integração rodar estas
 * instruções contra o DuckDB.
 *
 * ── Por que existe ──────────────────────────────────────────────────────
 * A restauração inseria as linhas em blocos de 500, com cada valor
 * atravessando a ponte para o worker como parâmetro, e com todos os índices
 * da tabela ativos. No banco real (867 mil linhas) eram 143 s — e isso roda
 * toda vez que o sistema abre, porque o banco vive em memória.
 *
 * Aqui o JSON de cada tabela é registrado como arquivo virtual e carregado
 * com UMA instrução, e os índices são derrubados antes e recriados depois
 * (construir um índice de uma vez é muito mais barato do que mantê-lo a cada
 * linha). Mesmo banco: ~13 s.
 */

// Só o que pode aparecer como nome de tabela, coluna, tipo ou arquivo nas
// instruções abaixo. Nenhum desses valores vem do arquivo de backup — tabela
// e coluna saem de listas fixas, o tipo vem do catálogo do banco e o nome do
// arquivo é gerado aqui —, mas eles são interpolados (o DuckDB não aceita
// parâmetro nessas posições), então a forma é conferida mesmo assim.
const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;
const TYPE_PATTERN = /^[A-Z][A-Z0-9_ ]*(\(\d+(,\s*\d+)?\))?$/;
const FILE_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

function assertShape(value, pattern, what) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`Restauração: ${what} inválido (${String(value)}).`);
  }
  return value;
}

/** Nome do arquivo virtual de uma tabela durante a restauração. */
export function restoreFileNameFor(table) {
  return `restore_${assertShape(table, IDENTIFIER_PATTERN, "nome de tabela")}.json`;
}

/**
 * `INSERT … SELECT` que carrega uma tabela a partir do arquivo JSON dela.
 *
 * Toda coluna é lida como TEXTO e convertida para o tipo da tabela com um
 * CAST explícito. Ler já no tipo final seria um pouco mais rápido, mas mais
 * rígido: o leitor de JSON recusa, por exemplo, um `1` numa coluna booleana,
 * que o caminho antigo (valor por parâmetro) aceitava. Passando por texto, a
 * conversão é a mesma de sempre — e um backup antigo que abria continua
 * abrindo.
 *
 * Chave ausente numa linha vira NULL; chave a mais no arquivo é ignorada.
 *
 * @param {object} options
 * @param {string} options.table Tabela de destino (de lista fixa).
 * @param {string[]} options.columns Colunas a carregar (de lista fixa).
 * @param {Map<string, string>} options.columnTypes Tipo de cada coluna, do
 *   catálogo do banco.
 * @param {string} options.fileName Arquivo virtual já registrado.
 */
export function buildJsonRestoreInsertSql({
  table,
  columns,
  columnTypes,
  fileName,
}) {
  assertShape(table, IDENTIFIER_PATTERN, "nome de tabela");
  assertShape(fileName, FILE_NAME_PATTERN, "nome de arquivo");

  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error(`Restauração: nenhuma coluna para a tabela ${table}.`);
  }

  const quoted = columns.map(
    (column) => `"${assertShape(column, IDENTIFIER_PATTERN, "nome de coluna")}"`,
  );
  const casts = columns.map((column, index) => {
    const type = assertShape(
      String(columnTypes.get(column) ?? "").toUpperCase(),
      TYPE_PATTERN,
      `tipo da coluna ${column}`,
    );
    return `CAST(${quoted[index]} AS ${type})`;
  });
  const asText = quoted.map((column) => `${column}: 'VARCHAR'`).join(", ");

  return `
    INSERT INTO ${table} (${quoted.join(", ")})
    SELECT ${casts.join(", ")}
    FROM read_json(
      '${fileName}',
      format = 'array',
      columns = {${asText}},
      maximum_object_size = 104857600
    )
  `;
}

/**
 * Índices das tabelas que serão recarregadas, com o SQL que os recria.
 *
 * Vêm do catálogo, e não de uma lista escrita à mão, para a restauração
 * devolver exatamente os índices que encontrou — inclusive os que uma
 * migration futura criar.
 */
export function buildRestorableIndexesSql(tables) {
  const list = tables
    .map((table) => `'${assertShape(table, IDENTIFIER_PATTERN, "nome de tabela")}'`)
    .join(", ");

  return `
    SELECT index_name, table_name, is_unique, sql
    FROM duckdb_indexes()
    WHERE table_name IN (${list})
      AND sql IS NOT NULL
    ORDER BY table_name, index_name
  `;
}

/**
 * As colunas de um índice, tiradas do SQL que o catálogo guarda para ele
 * (`CREATE [UNIQUE] INDEX nome ON tabela(col_a, col_b)`).
 *
 * Devolve `null` quando o texto não tem a forma esperada — índice sobre
 * expressão, por exemplo. Quem chama trata isso como "não sei conferir".
 */
export function parseIndexColumns(indexSql) {
  const match = /\(([^()]+)\)\s*;?\s*$/.exec(String(indexSql ?? ""));
  if (!match) return null;

  const columns = match[1]
    .split(",")
    .map((column) => column.trim().replace(/^"|"$/g, ""));

  return columns.every((column) => IDENTIFIER_PATTERN.test(column))
    ? columns
    : null;
}

/**
 * Há duas linhas com a mesma chave? Devolve uma linha se houver, nenhuma se
 * não houver.
 *
 * Substitui, durante a carga, a garantia que o índice único daria: os
 * índices só voltam depois do commit (ver `restoreTablesFromJson`), e um
 * arquivo com chave repetida precisa ser recusado ANTES dele.
 *
 * Linhas com NULL em alguma coluna da chave ficam de fora, como no índice:
 * NULL nunca é igual a NULL.
 */
export function buildDuplicateKeyCheckSql(table, columns) {
  assertShape(table, IDENTIFIER_PATTERN, "nome de tabela");
  const quoted = columns.map(
    (column) => `"${assertShape(column, IDENTIFIER_PATTERN, "nome de coluna")}"`,
  );

  return `
    SELECT 1 AS duplicated
    FROM ${table}
    WHERE ${quoted.map((column) => `${column} IS NOT NULL`).join(" AND ")}
    GROUP BY ${quoted.join(", ")}
    HAVING count(*) > 1
    LIMIT 1
  `;
}

export function buildDropIndexSql(indexName) {
  return `DROP INDEX IF EXISTS "${assertShape(indexName, IDENTIFIER_PATTERN, "nome de índice")}"`;
}

/** Tipo de cada coluna das tabelas do banco, do catálogo. */
export const COLUMN_TYPES_SQL = `
  SELECT table_name, column_name, data_type
  FROM information_schema.columns
  WHERE table_schema = 'main'
`;
