import {
  createEmptySnapshot,
  normalizeSnapshotPayload,
  snapshotHasData,
} from "../../utils/backup.js";
import {
  STORAGE_BUCKET,
  STORAGE_OBJECT_NAME,
  getUserStorageObjectPath,
  isSupabaseConfigured,
  supabase,
} from "../supabaseClient.js";
import { restoreDatabaseFromParts, restoreDatabaseSnapshot } from "./backup.js";
import {
  initDB,
  query,
  queryPrepared,
  setOnAfterTransaction,
} from "./connection.js";
import { updateStorageInfo } from "./events.js";
import { localizeHydrationError } from "./cloudSyncUtils.js";
import {
  hasRemoteVersionChanged,
  hasUnsyncedRevision,
  isAlreadyExistsError,
  isObjectNotFoundError,
  nextUploadRetryDelay,
  pickServerVersion,
  pickSnapshotVersion,
  shouldFlushOnHide,
} from "./cloudSyncDecisions.js";
import {
  compressSnapshot,
  readSnapshotBlob,
} from "./snapshotCodec.js";
import {
  MANIFEST_OBJECT_NAME,
  PARTS_FOLDER,
  buildLegacyTombstoneText,
  buildManifest,
  buildPartExportQuery,
  buildPartFileName,
  buildPartFingerprintsQuery,
  buildSourceColumnsQuery,
  findMissingPartFiles,
  fingerprintOf,
  isPartitionedKey,
  listCurrentParts,
  parseManifest,
  planPartUploads,
  selectOrphanFiles,
} from "./snapshotParts.js";
import { SNAPSHOT_SOURCES } from "./snapshotSources.js";
import { logError } from "../logger.js";

/**
 * Persistência na nuvem: o banco vive em memória e é gravado no Supabase
 * Storage, em PARTES, com um índice (ver `snapshotParts.js`).
 *
 * Fluxo:
 *   - ao abrir (depois do login) → `hydrateFromCloud(userId)`: baixa o índice
 *     e as partes e monta o banco;
 *   - a cada gravação → `scheduleCloudFlush()` (espera ~2 s e junta as
 *     gravações): sobe só as partes que mudaram e, por último, o índice;
 *   - ao sair da aba → `flushPendingCloudSync()`.
 *
 * Até o commit 320 o banco era UM arquivo (`dados.json`), regravado inteiro
 * a cada alteração. Uma conta que ainda está nesse formato é lida por ele e
 * migrada no primeiro envio — ver `blockLegacyFile`.
 */

const FLUSH_DEBOUNCE_MS = 2000;
const DOWNLOAD_CONCURRENCY = 4;
const UPLOAD_CONCURRENCY = 3;

// Nome com que o arquivo único antigo é guardado na migração.
const LEGACY_ARCHIVE_NAME = "dados-formato-antigo.json";

let activeUserId = null;
let pendingTimer = null;
// Nova tentativa automática depois de um upload que falhou — ver
// `scheduleUploadRetry`.
let retryTimer = null;
let consecutiveUploadFailures = 0;
// Quantas gravações locais já houve, e até qual delas o último upload
// bem-sucedido chegou — ver `hasUnsyncedRevision`.
let localRevision = 0;
let uploadedRevision = 0;
let pendingPromise = null;
let isUploading = false;
let lastSyncedAt = null;
let lastError = null;
let status = "idle"; // idle | syncing | error | offline
// A versão do que está na nuvem que este navegador viu por último (a do
// índice; ou a do arquivo antigo, numa conta que ainda não migrou).
let lastKnownServerVersion = null;
let remoteConflict = false;

// O índice que descreve o que este navegador sabe estar na nuvem: o que foi
// lido ao abrir ou o que ele mesmo gravou por último. É contra ele que se
// decide quais partes subir. `null` = a conta ainda não tem índice.
let knownManifest = null;
// O arquivo único antigo existe na pasta do usuário? (lido na listagem)
let legacyFileExists = false;
// Há algo a enviar que não depende de gravação do usuário: migrar a conta
// para o formato em partes, ou concluir o bloqueio do arquivo antigo.
let uploadNeededAfterHydration = false;
// As colunas que cada SELECT do snapshot exporta. Não mudam durante a sessão.
let columnsByKeyCache = null;
let orphanSweepDone = false;
// O bloqueio do arquivo antigo é tentado uma vez por sessão: se a causa da
// falha for permanente (permissão, por exemplo), insistir a cada envio só
// encheria o histórico de erros.
let legacyBlockAttempted = false;

// Hydration is idempotent at the module level: concurrent callers (React
// StrictMode runs effects twice in dev) share the same promise, and once
// we've hydrated a given userId we skip re-running unless the user changes.
let hydrationPromise = null;
let hydratedUserId = null;

const listeners = new Set();
const conflictListeners = new Set();

function notifyListeners() {
  const snapshot = getCloudSyncStatus();
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (error) {
      logError("cloudStorage.listener", error);
    }
  }
  updateStorageInfo(buildCloudStorageInfo(snapshot));
}

function buildCloudStorageInfo(snapshot) {
  if (!isSupabaseConfigured) {
    return {
      mode: "memory",
      isPersistent: false,
      label: "Sincronização não configurada",
      description:
        "Defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY no .env para sincronizar com a nuvem.",
    };
  }
  if (!activeUserId) {
    return {
      mode: "memory",
      isPersistent: false,
      label: "Sessão não autenticada",
      description:
        "Os dados não são gravados até que você entre com sua conta.",
    };
  }
  return {
    mode: "cloud",
    isPersistent: true,
    label:
      snapshot.status === "syncing"
        ? "Sincronizando…"
        : snapshot.status === "error"
        ? "Falha ao sincronizar"
        : "Sincronizado com a nuvem",
    description:
      snapshot.status === "error"
        ? "A última gravação não foi salva no servidor. O sistema tenta de novo sozinho por alguns minutos e a cada nova alteração; você também pode usar \"Sincronizar agora\"."
        : "As alterações são salvas automaticamente no Supabase Storage.",
    lastSyncedAt: snapshot.lastSyncedAt,
    syncStatus: snapshot.status,
  };
}

export function getCloudSyncStatus() {
  return { status, lastSyncedAt, error: lastError };
}

export function onCloudSyncStatusChange(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

export function onRemoteConflict(handler) {
  conflictListeners.add(handler);
  return () => conflictListeners.delete(handler);
}

function notifyConflictListeners() {
  for (const handler of conflictListeners) {
    try {
      handler(remoteConflict);
    } catch (error) {
      logError("cloudStorage.conflictListener", error);
    }
  }
}

// ── Caminhos e operações no armazenamento ────────────────────────────────

const storage = () => supabase.storage.from(STORAGE_BUCKET);
const manifestPath = (userId) => `${userId}/${MANIFEST_OBJECT_NAME}`;
const partPath = (userId, file) => `${userId}/${PARTS_FOLDER}/${file}`;

/** Roda `worker` sobre `items`, no máximo `limit` de cada vez. */
async function runWithConcurrency(items, limit, worker) {
  let next = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        await worker(items[index], index);
      }
    },
  );
  await Promise.all(runners);
}

/**
 * A versão do que está na nuvem, e se o arquivo único antigo ainda existe.
 * Uma listagem da pasta do usuário responde as duas coisas.
 */
async function fetchServerState(userId) {
  if (!isSupabaseConfigured || !userId) {
    return { version: null, legacyExists: false };
  }

  const { data, error } = await storage().list(userId, { limit: 100 });

  if (error) {
    throw error;
  }

  return {
    version: pickServerVersion(data, {
      manifestName: MANIFEST_OBJECT_NAME,
      legacyName: STORAGE_OBJECT_NAME,
    }),
    legacyExists: Boolean(pickSnapshotVersion(data, STORAGE_OBJECT_NAME)),
  };
}

async function fetchServerVersion(userId) {
  const state = await fetchServerState(userId);
  legacyFileExists = state.legacyExists;
  return state.version;
}

/** O índice que está na nuvem; `null` se a conta ainda não tem um. */
async function downloadManifest(userId) {
  const { data, error } = await storage().download(manifestPath(userId));

  if (error) {
    // Índice ausente = conta que ainda não migrou (ou conta nova). Qualquer
    // outra falha precisa subir: ler "sem índice" por engano faria o app
    // abrir pelo arquivo antigo, ou vazio, e gravar isso por cima.
    if (isObjectNotFoundError(error)) {
      return null;
    }
    throw error;
  }

  return parseManifest(await readSnapshotBlob(data));
}

/**
 * Compares the server-side version of the snapshot with what we last
 * uploaded/downloaded. If they don't match, another tab/device has written
 * to the bucket while this tab was idle.
 *
 * Skips the check while a local upload is in flight — the server version
 * would match a stale local value during that window.
 */
export async function checkForRemoteChanges() {
  if (!isSupabaseConfigured || !activeUserId) return false;
  if (isUploading) return false;

  try {
    const version = await fetchServerVersion(activeUserId);
    const isConflict = hasRemoteVersionChanged(lastKnownServerVersion, version);
    if (isConflict && !remoteConflict) {
      remoteConflict = true;
      notifyConflictListeners();
    }
    return isConflict;
  } catch (error) {
    logError("cloudStorage.checkForRemoteChanges", error);
    return false;
  }
}

// O usuário escolheu "Manter minhas alterações" no aviso de conflito: o que
// está neste navegador vai por cima do que o outro dispositivo gravou.
//
// Só limpar o aviso não basta. O upload checa conflito antes de subir, e a
// checagem compara a versão do servidor com a última que ESTE navegador
// conhecia — que continuava sendo a de antes do outro dispositivo gravar.
// Resultado: o conflito era detectado de novo na hora, o aviso voltava e
// nada subia, nem nas alterações seguintes. A única saída era "Recarregar",
// que descarta o trabalho local — o contrário do que o botão promete.
//
// Aceitar o conflito é exatamente declarar a versão remota como vista. Por
// isso a âncora é atualizada ANTES do upload — e o índice remoto passa a ser
// o conhecido: é contra ELE que o envio decide o que subir e quais arquivos
// do outro dispositivo saem de uso. Se outro dispositivo gravar de novo
// nesse intervalo, a checagem do upload pega e o aviso reaparece — o que é
// o comportamento certo.
export async function acknowledgeRemoteConflict() {
  if (!remoteConflict) return;

  const userId = activeUserId;
  if (userId) {
    try {
      const remoteManifest = await downloadManifest(userId);
      const serverVersion = await fetchServerVersion(userId);
      knownManifest = remoteManifest;
      if (serverVersion) {
        lastKnownServerVersion = serverVersion;
      }
    } catch (error) {
      // Sem conseguir ler a versão remota não dá para aceitá-la: o aviso
      // fica na tela e o usuário pode tentar de novo.
      logError("cloudStorage.acknowledgeRemoteConflict", error);
      return;
    }
  }

  remoteConflict = false;
  notifyConflictListeners();

  if (userId && userId === activeUserId) {
    await uploadSnapshotImmediate(userId);
  }
}

export function setActiveCloudUser(userId) {
  const previousUserId = activeUserId;
  activeUserId = userId || null;
  if (!activeUserId) {
    cancelPendingTimer();
    cancelRetryTimer();
    consecutiveUploadFailures = 0;
    localRevision = 0;
    uploadedRevision = 0;
    knownManifest = null;
    legacyFileExists = false;
    uploadNeededAfterHydration = false;
    orphanSweepDone = false;
    legacyBlockAttempted = false;
    // Invalidate the hydration cache so a new account on the same tab
    // forces a fresh download instead of trusting whatever happens to be
    // sitting in DuckDB right now.
    if (previousUserId) {
      resetHydrationCache();
    }
  } else if (uploadNeededAfterHydration) {
    // A hidratação deixou trabalho que não espera uma gravação do usuário:
    // levar a conta para o formato em partes, ou concluir o bloqueio do
    // arquivo antigo.
    uploadNeededAfterHydration = false;
    scheduleCloudFlush();
  }
  notifyListeners();
}

function cancelPendingTimer() {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

function cancelRetryTimer() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

// Agenda a próxima tentativa depois de um upload que falhou. As esperas e o
// limite vivem em `nextUploadRetryDelay`; esgotadas, nada é agendado e a
// próxima tentativa só acontece por um gatilho de fora — nova alteração,
// a aba indo para segundo plano, a rede voltando ou "Sincronizar agora".
function scheduleUploadRetry() {
  cancelRetryTimer();
  const delay = nextUploadRetryDelay(consecutiveUploadFailures);
  if (delay === null || !activeUserId) return;

  retryTimer = setTimeout(() => {
    retryTimer = null;
    uploadSnapshotImmediate(activeUserId);
  }, delay);
}

/**
 * O arquivo único do formato antigo, para a conta que ainda não migrou.
 * `null` se não existe (conta nova).
 */
async function downloadLegacySnapshot(userId) {
  const path = getUserStorageObjectPath(userId);
  const { data, error } = await storage().download(path);

  if (error) {
    // Object missing = first-time user; anything else must propagate. See
    // `isObjectNotFoundError` for why this distinction is load-bearing:
    // swallowing a real failure here would hydrate an empty database and the
    // next flush would upload that emptiness over the user's real data.
    if (isObjectNotFoundError(error)) {
      return null;
    }
    throw error;
  }

  if (!data) return null;
  const text = await readSnapshotBlob(data);
  if (!text.trim()) return null;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (parseError) {
    throw new Error(
      "O snapshot armazenado na nuvem não está em um JSON válido.",
      { cause: parseError },
    );
  }

  return normalizeSnapshotPayload(parsed);
}

/**
 * Baixa os arquivos das partes de um índice. Devolve `Map(arquivo → Blob)`.
 *
 * Tudo é baixado ANTES de o banco ser tocado: uma falha de rede no meio não
 * deixa nada pela metade. Os arquivos ficam comprimidos na memória (dezenas
 * de MB no total) e cada um só é aberto na hora de entrar no banco.
 */
async function downloadParts(userId, manifest, { reuse, onProgress } = {}) {
  const blobs = new Map();
  // Parte sem linha nenhuma (tabela vazia) não tem o que carregar.
  const files = Array.from(
    new Set(
      manifest.parts
        .filter((part) => Number(part.rows ?? 0) > 0)
        .map((part) => part.file),
    ),
  );
  let done = 0;

  await runWithConcurrency(files, DOWNLOAD_CONCURRENCY, async (file) => {
    const cached = reuse?.get(file);
    if (cached) {
      blobs.set(file, cached);
    } else {
      const { data, error } = await storage().download(partPath(userId, file));
      if (error) {
        const failure = new Error(
          "Não foi possível baixar uma parte dos dados da nuvem.",
          { cause: error },
        );
        failure.isMissingPart = isObjectNotFoundError(error);
        failure.partialBlobs = blobs;
        throw failure;
      }
      blobs.set(file, data);
    }
    done += 1;
    onProgress?.({ downloadedParts: done, totalParts: files.length });
  });

  return blobs;
}

async function uploadSnapshotImmediate(userId) {
  if (!isSupabaseConfigured || !userId) {
    return;
  }
  if (isUploading) {
    // Coalesce: if a flush is already in flight, the caller will land on
    // the same promise. Otherwise schedule another flush right after.
    return pendingPromise;
  }

  // Never overwrite a snapshot we know is stale. A live check here (not
  // just the flag from the last focus/visibility event) closes the gap
  // where another device writes while this tab never loses focus during a
  // long session — previously the upload below ran unconditionally
  // (`upsert: true`) and silently discarded the remote change.
  await checkForRemoteChanges();
  if (remoteConflict) {
    status = "error";
    lastError = new Error(
      "Sincronização pausada: os dados foram atualizados em outro dispositivo. Recarregue ou escolha manter suas alterações no aviso no topo da tela.",
    );
    notifyListeners();
    return;
  }

  return performUpload(userId);
}

async function getColumnsByKey() {
  if (!columnsByKeyCache) {
    const columns = {};
    for (const source of SNAPSHOT_SOURCES) {
      const rows = await query(buildSourceColumnsQuery(source.key));
      columns[source.key] = rows.map((row) => String(row.column_name));
    }
    columnsByKeyCache = columns;
  }
  return columnsByKeyCache;
}

/** As partes que o banco tem agora, com a impressão digital de cada uma. */
async function readCurrentParts() {
  const rowsByKey = {};
  for (const source of SNAPSHOT_SOURCES) {
    rowsByKey[source.key] = await query(buildPartFingerprintsQuery(source.key));
  }
  return listCurrentParts(rowsByKey);
}

async function uploadObject(path, blob, { contentType, cacheControl }) {
  const { error } = await storage().upload(path, blob, {
    upsert: true,
    contentType,
    cacheControl,
  });
  if (error) throw error;
}

async function uploadManifest(userId, manifest) {
  await uploadObject(
    manifestPath(userId),
    new Blob([JSON.stringify(manifest)], { type: "application/json" }),
    { contentType: "application/json", cacheControl: "0" },
  );
}

/**
 * Grava na nuvem o que mudou desde o índice conhecido.
 *
 * 1. Lê a impressão digital de cada parte (dentro do DuckDB, em outra thread).
 * 2. Exporta e sobe só as partes cuja impressão mudou. Cada arquivo tem a
 *    impressão no nome, então nunca sobrescreve um arquivo em uso.
 * 3. Sobe o índice novo. É ESTE passo que troca o banco na nuvem — se
 *    qualquer coisa falhar antes, o índice antigo continua valendo inteiro.
 * 4. Apaga os arquivos que saíram de uso há mais tempo que o prazo de guarda.
 *
 * Devolve `true` se gravou um índice novo.
 */
async function uploadChangedParts(userId) {
  const plan = planPartUploads(await readCurrentParts(), knownManifest);
  const pending = plan.filter((part) => part.upload);

  const nothingChanged =
    knownManifest &&
    pending.length === 0 &&
    plan.length === knownManifest.parts.length;
  if (nothingChanged) {
    return false;
  }

  const columnsByKey = await getColumnsByKey();
  const finalParts = plan.filter((part) => !part.upload);
  const uploads = [];

  // A exportação é uma de cada vez (o banco tem uma conexão só); o envio de
  // cada arquivo corre em paralelo com a exportação do seguinte.
  //
  // Cada envio guarda a própria falha em vez de rejeitar: uma recusa pode
  // chegar enquanto a parte seguinte está sendo exportada, e uma promessa
  // rejeitada sem ninguém escutando vira erro não tratado — um registro no
  // histórico por arquivo.
  const inFlight = new Set();
  const failures = [];

  for (const part of pending) {
    if (failures.length > 0) break;

    const rows = await queryPrepared(
      buildPartExportQuery(part.key),
      isPartitionedKey(part.key) ? [part.partition] : [],
    );
    const exported = rows[0] ?? {};
    const total = Number(exported.total ?? 0);

    // A partição sumiu entre a leitura das impressões e a exportação (uma
    // importação excluída, por exemplo): não há parte a gravar.
    if (isPartitionedKey(part.key) && total === 0) {
      continue;
    }

    // A impressão vem da MESMA consulta que gerou o JSON: o nome do arquivo
    // e o índice descrevem o que de fato subiu.
    const fingerprint = fingerprintOf(exported);
    const file = buildPartFileName(part.key, part.partition, fingerprint);
    const { blob, contentType } = await compressSnapshot(
      String(exported.json_text ?? "[]"),
    );

    finalParts.push({ ...part, rows: total, fingerprint, file, bytes: blob.size });

    // Conteúdo imutável (o nome muda quando o conteúdo muda): o navegador
    // pode guardar em cache pelo tempo que quiser.
    const upload = uploadObject(partPath(userId, file), blob, {
      contentType,
      cacheControl: "31536000",
    })
      .catch((error) => {
        failures.push(error);
      })
      .finally(() => inFlight.delete(upload));
    inFlight.add(upload);
    uploads.push(upload);

    if (inFlight.size >= UPLOAD_CONCURRENCY) {
      await Promise.race(inFlight);
    }
  }

  // Espera todos terminarem — dando certo ou não — antes de decidir. Sem o
  // índice novo, nada do que subiu vale: o índice antigo continua inteiro.
  await Promise.all(uploads);
  if (failures.length > 0) {
    throw failures[0];
  }

  const { manifest, filesToDelete } = buildManifest({
    parts: finalParts,
    columnsByKey,
    previousManifest: knownManifest,
    exportedAt: new Date().toISOString(),
  });

  await uploadManifest(userId, manifest);
  knownManifest = manifest;

  // Só depois do índice novo gravado. Falhar aqui não perde nada: o arquivo
  // fica sobrando e a varredura de órfãos o recolhe mais tarde.
  if (filesToDelete.length > 0) {
    const { error } = await storage().remove(
      filesToDelete.map((file) => partPath(userId, file)),
    );
    if (error) {
      logError("cloudStorage.removeRetiredParts", error, {
        files: filesToDelete.length,
      });
    }
  }

  return true;
}

async function listPartFiles(userId) {
  const entries = [];
  // O tamanho de página padrão do armazenamento. Pedir mais e receber menos
  // por um teto do servidor encerraria a listagem cedo, sem aviso.
  const pageSize = 100;

  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await storage().list(`${userId}/${PARTS_FOLDER}`, {
      limit: pageSize,
      offset,
    });
    if (error) throw error;
    entries.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }

  return entries;
}

/**
 * Troca o arquivo único antigo por um aviso, guardando uma cópia dele.
 *
 * Um computador com uma versão anterior do sistema só conhece `dados.json`.
 * Deixado como está, ele abriria com os dados do dia da migração e gravaria
 * por cima deles — trabalho que nenhum outro computador veria. Com o aviso
 * no lugar (que não é JSON), a versão antiga acusa erro ao abrir e não grava
 * nada, até ser atualizada.
 *
 * Só roda DEPOIS de conferir que todas as partes do índice estão na nuvem
 * com o tamanho certo: a partir daqui o formato novo é o único lugar onde os
 * dados estão. A cópia é feita no servidor, sem baixar o arquivo.
 */
async function blockLegacyFile(userId) {
  const missing = findMissingPartFiles(await listPartFiles(userId), knownManifest);
  if (missing.length > 0) {
    throw new Error(
      `Migração: ${missing.length} parte(s) do índice não estão na nuvem; o arquivo antigo foi mantido.`,
    );
  }

  const legacyPath = getUserStorageObjectPath(userId);
  const { error: copyError } = await storage().copy(
    legacyPath,
    `${userId}/${LEGACY_ARCHIVE_NAME}`,
  );
  // "Já existe" = uma tentativa anterior fez a cópia e parou depois. A que
  // vale é aquela: copiar de novo levaria o aviso por cima do arquivo.
  if (copyError && !isAlreadyExistsError(copyError)) {
    throw copyError;
  }

  const blockedAt = new Date().toISOString();
  const legacy = { archivedAs: LEGACY_ARCHIVE_NAME, blockedAt };

  // Mesmo tipo do índice, de propósito: se o armazenamento restringir tipos
  // de arquivo, o índice já teria sido recusado antes de chegar aqui — e o
  // aviso não corre o risco de ser o único recusado, deixando o arquivo
  // antigo de pé. A versão antiga lê o texto sem olhar o tipo.
  await uploadObject(
    legacyPath,
    new Blob([buildLegacyTombstoneText(legacy)], { type: "application/json" }),
    { contentType: "application/json", cacheControl: "0" },
  );

  // O índice registra que o bloqueio foi feito, para nenhum computador
  // tentar de novo.
  const manifest = { ...knownManifest, legacy };
  await uploadManifest(userId, manifest);
  knownManifest = manifest;
}

/** Uma vez por sessão: apaga arquivos de parte que nenhum índice cita. */
async function sweepOrphanParts(userId) {
  const orphans = selectOrphanFiles(await listPartFiles(userId), knownManifest);
  if (orphans.length === 0) return;

  const { error } = await storage().remove(
    orphans.map((file) => partPath(userId, file)),
  );
  if (error) throw error;
}

// The actual upload, without the conflict gate. Split out so
// `flushBeforeUnload` can skip straight to it — a `beforeunload` handler has
// very little time budget, and spending part of it on a
// `checkForRemoteChanges()` round-trip (network) would only shrink the
// already-slim chance the upload lands before the page is gone.
async function performUpload(userId) {
  isUploading = true;
  status = "syncing";
  lastError = null;
  notifyListeners();

  pendingPromise = (async () => {
    // Anotada ANTES de ler o banco: o que for gravado daqui em diante pode
    // não estar nas partes enviadas, e precisa de outro envio.
    const revisionAtSnapshot = localRevision;

    try {
      await uploadChangedParts(userId);

      lastSyncedAt = new Date().toISOString();
      status = "idle";
      uploadedRevision = Math.max(uploadedRevision, revisionAtSnapshot);
      consecutiveUploadFailures = 0;
      cancelRetryTimer();

      // O que vem depois é arrumação: os dados já estão na nuvem. Uma falha
      // aqui é registrada e tentada de novo no próximo envio, sem marcar a
      // sincronização como falha.
      if (
        legacyFileExists &&
        knownManifest &&
        !knownManifest.legacy &&
        !legacyBlockAttempted
      ) {
        legacyBlockAttempted = true;
        try {
          await blockLegacyFile(userId);
        } catch (blockError) {
          logError("cloudStorage.blockLegacyFile", blockError);
        }
      }

      if (!orphanSweepDone) {
        orphanSweepDone = true;
        sweepOrphanParts(userId).catch((sweepError) =>
          logError("cloudStorage.sweepOrphanParts", sweepError),
        );
      }

      // Refresh our anchor of the server-side version so we won't trip the
      // conflict detector on our own upload. Best-effort — if the metadata
      // fetch fails, we just leave the previous anchor and accept the
      // (small) risk of a false positive on next focus.
      try {
        const serverVersion = await fetchServerVersion(userId);
        if (serverVersion) {
          lastKnownServerVersion = serverVersion;
        }
      } catch (versionError) {
        logError("cloudStorage.refreshServerVersion", versionError);
      }
    } catch (uploadError) {
      status = "error";
      lastError = uploadError;
      consecutiveUploadFailures += 1;
      // `logError` grava no histórico SEM agendar sincronização — é isso que
      // impede esta falha de disparar o próximo upload por conta própria. A
      // nova tentativa é a de baixo, com espera crescente e limite.
      logError("cloudStorage.upload", uploadError, {
        consecutiveFailures: consecutiveUploadFailures,
      });
      scheduleUploadRetry();
    } finally {
      isUploading = false;
      pendingPromise = null;
      // Houve gravação enquanto este envio estava no ar: ela pode não estar
      // nas partes que acabaram de subir. Só depois de um envio que DEU CERTO
      // — quando falha, quem decide a próxima tentativa é o
      // `scheduleUploadRetry`.
      if (
        status === "idle" &&
        !pendingTimer &&
        hasUnsyncedRevision(localRevision, uploadedRevision)
      ) {
        armFlushTimer();
      }
      notifyListeners();
    }
  })();

  return pendingPromise;
}

// Used only from the `beforeunload` handler: a última tentativa, sem
// garantia. O navegador pode cortar o envio quando a página fecha — por isso
// o `beforeunload` também avisa o usuário antes, em vez de supor que esta
// função torna a perda impossível. O trabalho de verdade é feito mais cedo,
// em `visibilitychange`/`pagehide`, com a página ainda viva.
//
// Não checa conflito de propósito — ver o comentário de `performUpload`.
async function flushBeforeUnload(userId) {
  if (!isSupabaseConfigured || !userId) return;
  cancelPendingTimer();
  cancelRetryTimer();
  await performUpload(userId);
}

// Chamado a cada gravação no banco (ver `setOnAfterTransaction`).
export function scheduleCloudFlush() {
  if (!isSupabaseConfigured || !activeUserId) {
    return;
  }
  localRevision += 1;
  armFlushTimer();
}

function armFlushTimer() {
  cancelPendingTimer();
  // Uma alteração nova já vai tentar subir daqui a pouco; a nova tentativa
  // que estava esperando perdeu o sentido. O contador de falhas NÃO zera
  // aqui — só um upload bem-sucedido o zera —, senão cada alteração
  // recomeçaria a série inteira de tentativas contra uma falha permanente.
  cancelRetryTimer();
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    uploadSnapshotImmediate(activeUserId);
  }, FLUSH_DEBOUNCE_MS);
}

export async function flushPendingCloudSync() {
  if (!isSupabaseConfigured || !activeUserId) return;
  cancelPendingTimer();
  cancelRetryTimer();
  if (isUploading && pendingPromise) {
    await pendingPromise;
  }
  await uploadSnapshotImmediate(activeUserId);
}

/** Monta o banco a partir do índice e das partes baixadas. */
async function restoreFromManifest(manifest, blobs, onProgress) {
  const tables = SNAPSHOT_SOURCES.map((source) => ({
    key: source.key,
    columns: manifest.columns?.[source.key],
    files: manifest.parts
      .filter((part) => part.key === source.key)
      .map((part) => ({
        rowCount: Number(part.rows ?? 0),
        loadText: () => readSnapshotBlob(blobs.get(part.file)),
      })),
  }));

  await restoreDatabaseFromParts(tables, {
    emitChange: false,
    onProgress: (progress) => onProgress?.({ step: "restore", ...progress }),
  });
}

/**
 * Abre pelo formato em partes. Devolve `false` se a conta não tem índice.
 *
 * Se um arquivo citado pelo índice não existir mais — outro computador
 * gravou enquanto este baixava, e o prazo de guarda passou —, o índice é
 * lido de novo e o download recomeça, aproveitando o que já veio.
 */
async function hydrateFromParts(userId, onProgress) {
  let manifest = await downloadManifest(userId);
  if (!manifest) return false;

  const report = (progress) => onProgress?.({ step: "download", ...progress });
  let blobs;
  try {
    blobs = await downloadParts(userId, manifest, { onProgress: report });
  } catch (error) {
    if (!error?.isMissingPart) throw error;
    manifest = await downloadManifest(userId);
    if (!manifest) throw error;
    blobs = await downloadParts(userId, manifest, {
      reuse: error.partialBlobs,
      onProgress: report,
    });
  }

  onProgress?.("restore");
  await restoreFromManifest(manifest, blobs, onProgress);
  knownManifest = manifest;
  // Índice sem o registro do bloqueio e arquivo antigo ainda na pasta: a
  // migração parou antes do último passo. Um envio conclui.
  uploadNeededAfterHydration = legacyFileExists && !manifest.legacy;

  return { hadData: manifest.parts.some((part) => Number(part.rows) > 0) };
}

/** Abre pelo arquivo único antigo — conta que ainda não migrou, ou nova. */
async function hydrateFromLegacyFile(userId, onProgress) {
  const snapshot = await downloadLegacySnapshot(userId);

  // Always replay the remote snapshot — even when it's empty — so
  // DuckDB ends up matching the cloud exactly. If we skip this for
  // first-time users, stale rows from a previous session (e.g., a
  // different account signing in on the same browser) would leak
  // into the next upload.
  onProgress?.("restore");
  await restoreDatabaseSnapshot(snapshot ?? createEmptySnapshot(), {
    allowEmpty: true,
    emitChange: false,
    // Forward per-table progress to the same callback so the
    // CloudSyncGate can show "Restaurando donation_notes (8.500 /
    // 30.000)" instead of a flat "Restaurando…". String key keeps
    // the public API back-compatible for callers that only care
    // about the phase.
    onProgress: (progress) => onProgress?.({ step: "restore", ...progress }),
  });

  knownManifest = null;
  const hadData = Boolean(snapshot && snapshotHasData(snapshot));
  // Conta com dados no formato antigo: o primeiro envio leva tudo para o
  // formato em partes, sem esperar uma gravação do usuário.
  uploadNeededAfterHydration = hadData;

  return { hadData };
}

export async function hydrateFromCloud(userId, { onProgress } = {}) {
  if (!isSupabaseConfigured) {
    return { hydrated: false, hadData: false };
  }
  if (!userId) {
    throw new Error("Usuário não autenticado.");
  }

  // Coalesce concurrent calls (e.g., React StrictMode firing the effect
  // twice in dev). If a hydrate for this user is already in flight, share
  // the promise. If it already completed, skip — DuckDB already matches
  // the cloud, so re-running would just race two DELETE+INSERT passes and
  // trip the PRIMARY KEY constraint.
  if (hydrationPromise && hydratedUserId === userId) {
    return hydrationPromise;
  }
  if (hydratedUserId === userId && !hydrationPromise) {
    return { hydrated: true, hadData: false, fromCache: true };
  }

  hydratedUserId = userId;
  hydrationPromise = (async () => {
    try {
      onProgress?.("db");
      await initDB();
      onProgress?.("download");

      // A versão é lida ANTES do conteúdo: se outro computador gravar no
      // meio do download, a âncora fica mais antiga que o que foi baixado e
      // a primeira checagem acusa o conflito — o erro para o lado seguro.
      try {
        lastKnownServerVersion = await fetchServerVersion(userId);
      } catch (versionError) {
        logError("cloudStorage.fetchServerVersion", versionError);
        lastKnownServerVersion = null;
      }

      const result =
        (await hydrateFromParts(userId, onProgress)) ||
        (await hydrateFromLegacyFile(userId, onProgress));

      return { hydrated: true, hadData: result.hadData };
    } catch (error) {
      // Reset so a retry actually runs again.
      hydratedUserId = null;
      throw localizeHydrationError(error);
    } finally {
      hydrationPromise = null;
    }
  })();

  return hydrationPromise;
}

export function resetHydrationCache() {
  hydrationPromise = null;
  hydratedUserId = null;
}

// Register the post-transaction hook so every commit/execute schedules a
// debounced upload to the user's bucket. `connection.js` calls this after
// each `execute`/`executePrepared`/`runInTransaction` once the depth is 0.
setOnAfterTransaction(scheduleCloudFlush);

// "Há trabalho que ainda não chegou à nuvem?"
//
// Além do envio agendado, em andamento ou esperando nova tentativa, conta
// qualquer gravação que nenhum upload bem-sucedido levou. É essa última
// parte que cobre os casos em que não há nada agendado e ainda assim há
// trabalho por subir: tentativas automáticas esgotadas, sincronização
// pausada por conflito. Sem ela a aba fechava sem aviso.
export function hasPendingCloudWork() {
  return (
    Boolean(pendingTimer) ||
    Boolean(retryTimer) ||
    isUploading ||
    hasUnsyncedRevision(localRevision, uploadedRevision)
  );
}

// Flush while the page is still alive. `visibilitychange → hidden` and
// `pagehide` both fire BEFORE the browser starts tearing the page down, so a
// normal upload works here. Covers the cases that actually dominate in
// practice: switching tabs, switching apps, and mobile backgrounding (where
// `beforeunload` often never fires at all).
function flushIfPending(scope) {
  const shouldFlush = shouldFlushOnHide({
    isConfigured: isSupabaseConfigured,
    activeUserId,
    hasPendingWork: hasPendingCloudWork(),
  });
  if (!shouldFlush) return;
  flushPendingCloudSync().catch((error) => logError(scope, error));
}

// Flush on tab close so the user doesn't lose changes that were sitting in
// the debounce window. Layered, because no single hook is reliable:
//   1. `visibilitychange`/`pagehide` above — the page is still alive. This is
//      the one that does the real work.
//   2. `flushBeforeUnload` starts one last upload, which the browser may or
//      may not let finish.
//   3. The native "leave site?" prompt gives the user an actual choice to
//      stay and let the sync finish, instead of silently losing work when
//      neither of the above completes in time.
if (typeof window !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushIfPending("cloudStorage.flushOnHide");
    }
  });

  window.addEventListener("pagehide", () => {
    flushIfPending("cloudStorage.flushOnPageHide");
  });

  window.addEventListener("beforeunload", (event) => {
    if (!hasPendingCloudWork()) return;

    event.preventDefault();
    event.returnValue = "";

    // Com conflito pendente NÃO se envia ao sair: `flushBeforeUnload` pula
    // a checagem de conflito, e subir aqui sobrescreveria o que o outro
    // dispositivo gravou sem o usuário ter escolhido. O aviso do navegador
    // acima continua valendo — há trabalho que não subiu.
    if (!isUploading && !remoteConflict) {
      flushBeforeUnload(activeUserId);
    }
  });

  // A rede voltou: é o melhor momento para tentar de novo, e não custa
  // nada quando não há o que enviar.
  window.addEventListener("online", () => {
    flushIfPending("cloudStorage.flushOnOnline");
  });

  // When the tab regains focus, ask Supabase whether another device has
  // overwritten the snapshot in the meantime. We don't poll on a timer to
  // avoid burning quota — the user only cares right after they come back
  // to the tab.
  const triggerRemoteCheck = () => {
    if (document.visibilityState === "visible") {
      checkForRemoteChanges();
    }
  };
  window.addEventListener("focus", triggerRemoteCheck);
  document.addEventListener("visibilitychange", triggerRemoteCheck);
}

// Initialize the storage info display once the module loads.
notifyListeners();
