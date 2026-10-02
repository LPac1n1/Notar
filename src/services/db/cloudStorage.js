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
  supabaseAnonKey,
  supabaseUrl,
} from "../supabaseClient.js";
import { exportSnapshotText, restoreDatabaseSnapshot } from "./backup.js";
import {
  initDB,
  setOnAfterTransaction,
} from "./connection.js";
import { updateStorageInfo } from "./events.js";
import { localizeHydrationError } from "./cloudSyncUtils.js";
import {
  fitsKeepaliveBudget,
  hasRemoteVersionChanged,
  hasUnsyncedRevision,
  isObjectNotFoundError,
  nextUploadRetryDelay,
  pickSnapshotVersion,
  shouldFlushOnHide,
} from "./cloudSyncDecisions.js";
import {
  compressSnapshot,
  readSnapshotBlob,
} from "./snapshotCodec.js";
import { logError } from "../logger.js";

/**
 * Cloud-backed persistence: every write triggers a debounced upload of the
 * full snapshot to Supabase Storage. On startup, after the user authenticates,
 * the latest snapshot is pulled down and replayed into the in-memory DuckDB.
 *
 * Why a single blob (not per-table writes)? The dataset is small (<2k rows
 * across all tables for the foreseeable future) and the existing
 * import/export JSON pipeline already handles serialization. Trading
 * granularity for code simplicity is the right call here.
 *
 * Flow:
 *   - boot (after auth) → `hydrateFromCloud(userId)` → download + restore
 *   - on every transaction end → `scheduleCloudFlush()` (debounced ~2s)
 *   - on tab close → `flushPendingCloudSync()` via `beforeunload`
 */

const FLUSH_DEBOUNCE_MS = 2000;

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
let lastKnownServerVersion = null; // Supabase `updated_at` of the snapshot we've seen
let remoteConflict = false;

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

async function fetchServerVersion(userId) {
  if (!isSupabaseConfigured || !userId) return null;

  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .list(userId, { limit: 100 });

  if (error) {
    throw error;
  }

  return pickSnapshotVersion(data, STORAGE_OBJECT_NAME);
}

/**
 * Compares the server-side `updated_at` of the snapshot with what we last
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
// isso a âncora é atualizada ANTES do upload. Se outro dispositivo gravar de
// novo nesse intervalo, a checagem do upload pega e o aviso reaparece — o
// que é o comportamento certo.
export async function acknowledgeRemoteConflict() {
  if (!remoteConflict) return;

  const userId = activeUserId;
  if (userId) {
    try {
      const serverVersion = await fetchServerVersion(userId);
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
    // Invalidate the hydration cache so a new account on the same tab
    // forces a fresh download instead of trusting whatever happens to be
    // sitting in DuckDB right now.
    if (previousUserId) {
      resetHydrationCache();
    }
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

export async function downloadSnapshotFromCloud(userId) {
  if (!isSupabaseConfigured) return null;
  if (!userId) return null;

  const path = getUserStorageObjectPath(userId);
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(path);

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

// The actual upload, without the conflict gate. Split out so
// `flushBeforeUnload`'s fallback can skip straight to it — a `beforeunload`
// handler has very little time budget, and spending part of it on a
// `checkForRemoteChanges()` round-trip (network) would only shrink the
// already-slim chance the fallback fetch lands before the page is gone.
async function performUpload(userId) {
  isUploading = true;
  status = "syncing";
  lastError = null;
  notifyListeners();

  pendingPromise = (async () => {
    // Anotada ANTES de montar o snapshot: o que for gravado daqui em diante
    // pode não estar nele, e precisa de outro envio.
    const revisionAtSnapshot = localRevision;

    try {
      // O texto vem pronto do DuckDB. Montá-lo em JavaScript travava a
      // interface por meio segundo a cada gravação — ver `exportSnapshotText`.
      const snapshot = await exportSnapshotText();

      if (!snapshot) {
        throw new Error("O banco de dados ainda não está disponível.");
      }

      const path = getUserStorageObjectPath(userId);
      const { blob: body, contentType } = await compressSnapshot(snapshot.text);
      const { error } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(path, body, {
          upsert: true,
          contentType,
          cacheControl: "0",
        });
      if (error) throw error;
      lastSyncedAt = new Date().toISOString();
      status = "idle";
      uploadedRevision = Math.max(uploadedRevision, revisionAtSnapshot);
      consecutiveUploadFailures = 0;
      cancelRetryTimer();
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
      // Houve gravação enquanto este envio estava no ar: ela não está no
      // snapshot que acabou de subir. Só depois de um envio que DEU CERTO —
      // quando falha, quem decide a próxima tentativa é o `scheduleUploadRetry`.
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

// Best-effort delivery for the tab-close case. The Supabase storage-js SDK
// (verified against the installed version) never sets `keepalive` on its
// underlying fetch, so a normal `.upload()` call gets aborted the instant
// the page unloads. This bypasses the SDK for just this one call and talks
// to the Storage REST endpoint directly with `keepalive: true`, which lets
// the browser finish the request after the page is gone — but only works
// under the ~64KB body cap enforced by the browser itself (see
// KEEPALIVE_BODY_LIMIT_BYTES). Mirrors the exact request shape the SDK uses
// for `.upload(path, blob, { upsert: true })` (FormData with a `cacheControl`
// field and the blob under an empty-string field name) so the server sees
// an identical request.
async function tryKeepaliveUpload(userId, blob) {
  if (!supabaseUrl || !supabaseAnonKey) return false;
  if (!fitsKeepaliveBudget(blob.size)) return false;

  try {
    const { data } = await supabase.auth.getSession();
    const accessToken = data?.session?.access_token;
    if (!accessToken) return false;

    const path = getUserStorageObjectPath(userId);
    const form = new FormData();
    form.append("cacheControl", "0");
    form.append("", blob);

    const response = await fetch(
      `${supabaseUrl}/storage/v1/object/${STORAGE_BUCKET}/${path}`,
      {
        method: "POST",
        keepalive: true,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          apikey: supabaseAnonKey,
          "x-upsert": "true",
        },
        body: form,
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

// Used only from the `beforeunload` handler. Tries the keepalive-backed
// path first; if the payload is too large for it (or anything about it
// fails), falls back to the normal SDK upload, which the browser may still
// abort mid-flight — that residual risk is exactly why `beforeunload` also
// warns the user before this runs, instead of assuming this function makes
// the loss impossible.
async function flushBeforeUnload(userId) {
  if (!isSupabaseConfigured || !userId) return;
  cancelPendingTimer();
  cancelRetryTimer();
  try {
    const snapshot = await exportSnapshotText();
    if (!snapshot) return;
    const { blob } = await compressSnapshot(snapshot.text);
    const delivered = await tryKeepaliveUpload(userId, blob);
    if (delivered) return;
  } catch (error) {
    logError("cloudStorage.flushBeforeUnload", error);
  }
  // Skip the conflict gate here on purpose — see the comment on
  // `performUpload`. Every millisecond spent checking is a millisecond not
  // spent trying to get the user's own work saved before the tab closes.
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
      const snapshot = await downloadSnapshotFromCloud(userId);
      try {
        lastKnownServerVersion = await fetchServerVersion(userId);
      } catch (versionError) {
        logError("cloudStorage.fetchServerVersion", versionError);
        lastKnownServerVersion = null;
      }

      // Always replay the remote snapshot — even when it's empty — so
      // DuckDB ends up matching the cloud exactly. If we skip this for
      // first-time users, stale rows from a previous session (e.g., a
      // different account signing in on the same browser) would leak
      // into the next upload.
      onProgress?.("restore");
      const effectiveSnapshot = snapshot ?? createEmptySnapshot();
      await restoreDatabaseSnapshot(effectiveSnapshot, {
        allowEmpty: true,
        emitChange: false,
        // Forward per-table progress to the same callback so the
        // CloudSyncGate can show "Restaurando donation_notes (8.500 /
        // 30.000)" instead of a flat "Restaurando…". String key keeps
        // the public API back-compatible for callers that only care
        // about the phase.
        onProgress: (progress) =>
          onProgress?.({ step: "restore", ...progress }),
      });
      return {
        hydrated: true,
        hadData: Boolean(snapshot && snapshotHasData(snapshot)),
      };
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
// normal (unrestricted) upload works here — unlike `beforeunload`, whose
// keepalive path caps the body at ~60KB, a threshold the compressed snapshot
// crosses after roughly two months of real use. Covers the cases that
// actually dominate in practice: switching tabs, switching apps, and mobile
// backgrounding (where `beforeunload` often never fires at all).
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
//   1. `visibilitychange`/`pagehide` above — the page is still alive, so the
//      upload has no size limit. This is the one that does the real work.
//   2. `flushBeforeUnload` tries a keepalive-backed request that can survive
//      the page actually closing (see its comment for the size caveat).
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
