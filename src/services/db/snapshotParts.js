import { SNAPSHOT_SOURCES } from "./snapshotSources.js";

/**
 * O snapshot da nuvem em PARTES, com um índice.
 *
 * Módulo puro — sem rede, sem banco —, para a suíte exercitar as consultas
 * contra o DuckDB e as decisões sem subir nada.
 *
 * ── Por que existe ──────────────────────────────────────────────────────
 * O snapshot era um arquivo só, regravado inteiro a cada alteração. No banco
 * real (867 mil linhas) isso é exportar 294 MB de JSON e subir 26,8 MiB para
 * marcar UM abatimento — e o arquivo cresce 7–8 MiB por mês, contra um limite
 * de 50 MB por arquivo no plano gratuito do armazenamento.
 *
 * Aqui o banco vira várias partes:
 *
 *   • cada tabela pequena é uma parte;
 *   • as notas de doação e de crédito — 99% do volume — são uma parte por
 *     importação (na prática, por mês). A maior do banco real tem 4 MiB.
 *
 * e um ÍNDICE (`manifest.json`) diz quais arquivos formam o banco. Cada
 * gravação sobe só as partes que mudaram e, por último, o índice.
 *
 * ── As três garantias ───────────────────────────────────────────────────
 * 1. Um arquivo de parte NUNCA é sobrescrito: o nome dele traz a impressão
 *    digital do conteúdo. Quem está lendo um índice antigo continua achando
 *    os arquivos que ele cita.
 * 2. A troca do banco é a troca do índice, que é um arquivo só — ou vale o
 *    conjunto antigo inteiro, ou o novo inteiro.
 * 3. Um arquivo só é apagado depois de ficar um tempo fora do índice
 *    (`RETIRED_FILE_RETENTION_MS`).
 */

export const SNAPSHOT_MANIFEST_FORMAT = "notar-snapshot";
export const SNAPSHOT_MANIFEST_VERSION = 2;
export const MANIFEST_OBJECT_NAME = "manifest.json";
export const PARTS_FOLDER = "parts";

/**
 * Quanto tempo um arquivo que saiu do índice continua guardado.
 *
 * Abrir o sistema leva de segundos a um minuto, e nesse intervalo outro
 * computador pode gravar várias vezes. Quem começou a baixar pelo índice
 * antigo precisa achar os arquivos dele até terminar.
 */
export const RETIRED_FILE_RETENTION_MS = 30 * 60 * 1000;

/**
 * Tabelas divididas, e a coluna que separa as partes.
 *
 * A partição é a IMPORTAÇÃO, não o mês: a nota pertence a uma importação
 * (reimportar apaga e recria as notas dela), a coluna está na própria
 * tabela — nota de crédito não tem mês, só a importação — e não existe o
 * caso "nota sem mês". No uso real há uma importação por mês.
 */
export const PARTITION_COLUMN_BY_KEY = {
  donationNotes: "import_id",
  creditNotes: "credit_import_id",
};

const KNOWN_KEYS = new Set(SNAPSHOT_SOURCES.map((source) => source.key));
const PART_FILE_PATTERN = /^[A-Za-z0-9]+(\.[A-Za-z0-9-]+)+\.json\.gz$/;

function sourceFor(key) {
  const source = SNAPSHOT_SOURCES.find((item) => item.key === key);
  if (!source) {
    throw new Error(`Snapshot: tabela desconhecida (${String(key)}).`);
  }
  return source;
}

// Os três números da impressão digital de um conjunto de linhas.
//
// `hash(fonte)` é o hash da LINHA inteira (todas as colunas exportadas).
// A soma e o ou-exclusivo não dependem da ordem das linhas.
//
// O ou-exclusivo é sobre o hash REFEITO (`hash(hash(...))`) de propósito. O
// hash de linha do DuckDB combina a última coluna por ou-exclusivo simples:
// duas linhas recebendo o mesmo valor novo nessa coluna se cancelam, e um
// `bit_xor(hash(fonte))` puro NÃO MUDA — medido, com `updated_at` em duas
// linhas, que é exatamente o que "abater em massa" faz. Uma impressão que
// não muda significa parte que não sobe.
const FINGERPRINT_COLUMNS = `
      count(*) AS total,
      CAST(sum(CAST(hash(fonte) AS HUGEINT)) AS VARCHAR) AS row_sum,
      CAST(bit_xor(hash(hash(fonte))) AS VARCHAR) AS row_xor`;

/**
 * Impressão digital de cada parte de uma tabela: uma linha por partição
 * (`partition = ''` para a tabela que não é dividida).
 *
 * Roda dentro do DuckDB, que está em outra thread: saber o que mudou não
 * custa exportar o banco nem trava a tela.
 */
export function buildPartFingerprintsQuery(key) {
  const source = sourceFor(key);
  const partitionColumn = PARTITION_COLUMN_BY_KEY[key];

  if (!partitionColumn) {
    return `
    SELECT
      '' AS partition,${FINGERPRINT_COLUMNS}
    FROM (${source.sql}) AS fonte
  `;
  }

  return `
    SELECT
      coalesce(fonte.${partitionColumn}, '') AS partition,${FINGERPRINT_COLUMNS}
    FROM (${source.sql}) AS fonte
    GROUP BY 1
    ORDER BY 1
  `;
}

/**
 * O JSON de UMA parte, com a impressão digital do que foi serializado.
 *
 * A impressão sai na MESMA consulta do JSON: se alguém gravar entre a
 * varredura das impressões e a exportação, o nome do arquivo e o índice
 * descrevem o conteúdo que de fato subiu, e não o de antes.
 *
 * Tabela dividida recebe a partição como único parâmetro (`?`).
 */
export function buildPartExportQuery(key) {
  const source = sourceFor(key);
  const partitionColumn = PARTITION_COLUMN_BY_KEY[key];

  return `
    SELECT
      coalesce(json_group_array(fonte), '[]') AS json_text,${FINGERPRINT_COLUMNS}
    FROM (${source.sql}) AS fonte
    ${partitionColumn ? `WHERE coalesce(fonte.${partitionColumn}, '') = ?` : ""}
  `;
}

/** As colunas que o SELECT de uma tabela exporta, na ordem. */
export function buildSourceColumnsQuery(key) {
  return `DESCRIBE ${sourceFor(key).sql}`;
}

/**
 * Impressão digital, a partir da linha devolvida pelas consultas acima.
 * Só dígitos e hífens: vai no nome do arquivo.
 */
export function fingerprintOf(row) {
  const total = Number(row?.total ?? 0);
  const digits = (value) => {
    const text = String(value ?? "0");
    return /^\d+$/.test(text) ? text : "0";
  };

  return `${total}-${digits(row?.row_sum)}-${digits(row?.row_xor)}`;
}

export function isPartitionedKey(key) {
  return Boolean(PARTITION_COLUMN_BY_KEY[key]);
}

/** Identificador de uma parte dentro do índice. */
export function buildPartId(key, partition = "") {
  return isPartitionedKey(key) ? `${key}/${partition}` : key;
}

function toHex(text) {
  return Array.from(new TextEncoder().encode(String(text)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Nome do arquivo de uma parte. Traz a impressão digital: conteúdo novo,
 * nome novo — é o que garante que um arquivo nunca é sobrescrito.
 *
 * A partição vai em hexadecimal porque o armazenamento só aceita um conjunto
 * restrito de caracteres no nome, e porque assim nenhum identificador
 * consegue se passar por outro pedaço do nome.
 */
export function buildPartFileName(key, partition, fingerprint) {
  sourceFor(key);
  const pieces = [key];

  if (isPartitionedKey(key)) {
    pieces.push(partition === "" ? "-" : toHex(partition));
  }

  pieces.push(String(fingerprint));
  const fileName = `${pieces.join(".")}.json.gz`;

  if (!PART_FILE_PATTERN.test(fileName)) {
    throw new Error(`Snapshot: nome de parte inválido (${fileName}).`);
  }

  return fileName;
}

/**
 * As partes que o banco tem agora, a partir das impressões digitais lidas.
 *
 * `fingerprintRowsByKey`: para cada tabela, as linhas de
 * `buildPartFingerprintsQuery`.
 *
 * Tabela não dividida sempre vira uma parte, mesmo vazia: é o que distingue
 * "a tabela está vazia" de "a tabela não foi gravada". Tabela dividida vazia
 * não tem parte nenhuma.
 */
export function listCurrentParts(fingerprintRowsByKey) {
  const parts = [];

  for (const source of SNAPSHOT_SOURCES) {
    const rows = fingerprintRowsByKey?.[source.key];
    if (!Array.isArray(rows)) {
      throw new Error(`Snapshot: faltou a impressão digital de ${source.key}.`);
    }

    if (!isPartitionedKey(source.key)) {
      const row = rows[0] ?? { total: 0 };
      parts.push({
        id: buildPartId(source.key),
        key: source.key,
        partition: "",
        rows: Number(row.total ?? 0),
        fingerprint: fingerprintOf(row),
      });
      continue;
    }

    for (const row of rows) {
      const partition = String(row.partition ?? "");
      parts.push({
        id: buildPartId(source.key, partition),
        key: source.key,
        partition,
        rows: Number(row.total ?? 0),
        fingerprint: fingerprintOf(row),
      });
    }
  }

  return parts;
}

/**
 * Quais partes precisam subir: as que não estão no índice conhecido com a
 * mesma impressão digital. Sem índice (primeira gravação neste formato),
 * todas.
 */
export function planPartUploads(currentParts, knownManifest) {
  const known = new Map(
    (knownManifest?.parts ?? []).map((part) => [part.id, part]),
  );

  return currentParts.map((part) => {
    const previous = known.get(part.id);
    const unchanged =
      previous && previous.fingerprint === part.fingerprint && previous.file;

    return unchanged
      ? { ...part, file: previous.file, bytes: previous.bytes ?? null, upload: false }
      : { ...part, file: null, bytes: null, upload: true };
  });
}

/** Todos os arquivos que um índice ainda precisa que existam. */
export function listReferencedFiles(manifest) {
  const files = new Set();
  for (const part of manifest?.parts ?? []) {
    if (part.file) files.add(part.file);
  }
  for (const retired of manifest?.retired ?? []) {
    if (retired.file) files.add(retired.file);
  }
  return files;
}

/**
 * Monta o índice novo.
 *
 * `parts` já vêm com `file` e `bytes` preenchidos (as que subiram agora e as
 * que foram reaproveitadas). Os arquivos do índice anterior que saíram do
 * conjunto entram em `retired`, com a hora; os que já passaram do prazo de
 * guarda saem do índice e voltam em `filesToDelete`, para quem chamou
 * apagar DEPOIS de o índice novo estar gravado.
 */
export function buildManifest({
  parts,
  columnsByKey,
  previousManifest = null,
  exportedAt,
  now = Date.now(),
  legacy,
}) {
  for (const part of parts) {
    if (!part.file) {
      throw new Error(`Snapshot: a parte ${part.id} está sem arquivo.`);
    }
  }

  const current = new Set(parts.map((part) => part.file));
  const retired = [];
  const filesToDelete = [];
  const seen = new Set();

  const consider = (file, at) => {
    if (!file || current.has(file) || seen.has(file)) return;
    seen.add(file);
    if (now - at >= RETIRED_FILE_RETENTION_MS) {
      filesToDelete.push(file);
    } else {
      retired.push({ file, at: new Date(at).toISOString() });
    }
  };

  for (const entry of previousManifest?.retired ?? []) {
    const at = Date.parse(entry.at);
    consider(entry.file, Number.isFinite(at) ? at : now);
  }
  for (const part of previousManifest?.parts ?? []) {
    consider(part.file, now);
  }

  const manifest = {
    format: SNAPSHOT_MANIFEST_FORMAT,
    version: SNAPSHOT_MANIFEST_VERSION,
    exportedAt,
    columns: columnsByKey,
    parts: parts.map((part) => ({
      id: part.id,
      key: part.key,
      partition: part.partition,
      rows: part.rows,
      fingerprint: part.fingerprint,
      file: part.file,
      bytes: part.bytes ?? null,
    })),
    retired,
  };

  const legacyInfo = legacy ?? previousManifest?.legacy;
  if (legacyInfo) {
    manifest.legacy = legacyInfo;
  }

  return { manifest, filesToDelete };
}

/**
 * Lê e confere o índice. Lança erro em vez de devolver um índice pela
 * metade: quem chama restaura o banco a partir dele e, na gravação seguinte,
 * sobe o que restaurou — um índice mal lido viraria perda de dado.
 */
export function parseManifest(text) {
  let manifest;
  try {
    manifest = JSON.parse(String(text ?? ""));
  } catch (error) {
    throw new Error("O índice da nuvem não está em um JSON válido.", {
      cause: error,
    });
  }

  if (!manifest || manifest.format !== SNAPSHOT_MANIFEST_FORMAT) {
    throw new Error("O índice da nuvem não é um índice do Notar.");
  }

  // Um índice mais novo pode ter tabelas ou regras que esta versão não
  // conhece. Abrir assim mesmo perderia o que ela não entende na primeira
  // gravação.
  if (Number(manifest.version) > SNAPSHOT_MANIFEST_VERSION) {
    throw new Error(
      "Os dados na nuvem foram gravados por uma versão mais nova do sistema. Atualize o sistema neste computador para continuar.",
    );
  }

  if (!Array.isArray(manifest.parts)) {
    throw new Error("O índice da nuvem está sem a lista de partes.");
  }

  const ids = new Set();
  for (const part of manifest.parts) {
    if (!KNOWN_KEYS.has(part?.key)) {
      throw new Error(
        "Os dados na nuvem têm uma tabela que esta versão do sistema não conhece. Atualize o sistema neste computador para continuar.",
      );
    }
    if (typeof part.file !== "string" || !PART_FILE_PATTERN.test(part.file)) {
      throw new Error("O índice da nuvem cita um arquivo com nome inválido.");
    }
    if (part.id !== buildPartId(part.key, String(part.partition ?? ""))) {
      throw new Error("O índice da nuvem tem uma parte com identificação inválida.");
    }
    if (ids.has(part.id)) {
      throw new Error("O índice da nuvem cita a mesma parte duas vezes.");
    }
    ids.add(part.id);
  }

  // Toda tabela não dividida tem de estar no índice: a ausência dela seria
  // lida como "tabela vazia" e gravada assim.
  for (const key of KNOWN_KEYS) {
    if (!isPartitionedKey(key) && !ids.has(buildPartId(key))) {
      throw new Error(`O índice da nuvem está sem a tabela ${key}.`);
    }
  }

  return {
    ...manifest,
    retired: Array.isArray(manifest.retired)
      ? manifest.retired.filter(
          (entry) =>
            typeof entry?.file === "string" && PART_FILE_PATTERN.test(entry.file),
        )
      : [],
  };
}

/**
 * Arquivos da pasta de partes que nenhum índice cita e que já são antigos.
 *
 * Sobram quando um envio sobe partes e falha antes de gravar o índice: o
 * arquivo existe e ninguém sabe dele. `entries` é a listagem da pasta.
 *
 * A idade mínima é a mesma da guarda dos arquivos retirados, e pela mesma
 * razão em espelho: um arquivo recém-criado pode ser de um envio que ainda
 * não gravou o índice dele.
 */
export function selectOrphanFiles(entries, manifest, now = Date.now()) {
  const referenced = listReferencedFiles(manifest);

  return (entries ?? [])
    .filter((entry) => {
      const name = entry?.name;
      if (typeof name !== "string" || !PART_FILE_PATTERN.test(name)) return false;
      if (referenced.has(name)) return false;

      // A gravação mais RECENTE: um arquivo antigo regravado agora (mesmo
      // nome, mesmo conteúdo) pode estar prestes a entrar num índice.
      const writtenAt = Date.parse(entry.updated_at ?? entry.created_at ?? "");
      return Number.isFinite(writtenAt) && now - writtenAt >= RETIRED_FILE_RETENTION_MS;
    })
    .map((entry) => entry.name);
}

/**
 * Os arquivos que o índice cita estão todos na pasta, com o tamanho certo?
 * Devolve os que faltam ou divergem (vazio = está tudo lá).
 *
 * É a conferência feita ANTES de trocar o arquivo antigo pelo aviso: depois
 * dela o formato novo é o único lugar onde os dados estão.
 */
export function findMissingPartFiles(entries, manifest) {
  const sizes = new Map(
    (entries ?? []).map((entry) => [entry?.name, entry?.metadata?.size]),
  );

  return (manifest?.parts ?? [])
    .filter((part) => {
      if (!sizes.has(part.file)) return true;
      const size = sizes.get(part.file);
      return (
        Number.isFinite(Number(size)) &&
        Number.isFinite(Number(part.bytes)) &&
        part.bytes !== null &&
        Number(size) !== Number(part.bytes)
      );
    })
    .map((part) => part.file);
}

/** Linhas de todas as partes, para o indicador de progresso. */
export function countManifestRows(manifest) {
  return (manifest?.parts ?? []).reduce(
    (sum, part) => sum + Number(part.rows ?? 0),
    0,
  );
}

/**
 * Texto que substitui o arquivo antigo (`dados.json`) depois da migração.
 *
 * NÃO é JSON, de propósito. Toda versão do sistema anterior a este formato
 * lê `dados.json`; ao encontrar um texto que não é JSON, ela acusa erro ao
 * abrir e não grava nada. É isso que impede um computador desatualizado de
 * trabalhar em cima de dados velhos sem ninguém perceber — o que ele
 * gravasse no arquivo antigo nunca chegaria aos outros.
 *
 * (Vazio não serve: arquivo vazio é lido como "primeiro uso", o sistema
 * antigo abriria sem dado nenhum e gravaria por cima.)
 */
export function buildLegacyTombstoneText({ archivedAs, blockedAt }) {
  return [
    "NOTAR - ESTE ARQUIVO NAO E MAIS USADO.",
    "",
    "Os dados passaram a ser gravados em outro formato (manifest.json + pasta parts).",
    "Este computador esta com uma versao antiga do sistema: atualize pelo GitHub",
    "(git pull, depois npm install) e abra de novo.",
    "",
    `Copia do arquivo como estava antes da mudanca: ${archivedAs}`,
    `Mudanca feita em: ${blockedAt}`,
    "",
  ].join("\n");
}
