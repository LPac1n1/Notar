import { createActionHistoryEntry } from "./actionHistoryService";
import {
  appendLogEntry,
  clearLogBuffer,
  exportLogBuffer,
  getLogBufferSnapshot,
} from "./loggerBuffer";
import { getErrorMessage } from "../utils/error";

// Prevents recursive logging when the persistence path itself raises.
let isPersisting = false;

// Re-export the buffer surface so callers keep their existing imports
// (`from "../services/logger"`) while the actual circular-buffer logic
// lives in a dependency-free module that's safe to import from tests.
export { clearLogBuffer, exportLogBuffer, getLogBufferSnapshot };

function buildPayload(scope, error, context) {
  return {
    scope,
    message: getErrorMessage(error, ""),
    name: error instanceof Error ? error.name : typeof error,
    stack: error instanceof Error ? error.stack ?? "" : "",
    context: context && typeof context === "object" ? context : {},
  };
}

/**
 * Centralized error logger. Always writes to the browser console (dev visibility)
 * and best-effort persists the error to `action_history` so it survives the
 * session and can be inspected later in the History page.
 *
 * Never throws: persistence failures are swallowed because losing logs is worse
 * than crashing the original error path.
 */
export function logError(scope, error, context = {}) {
  const message = getErrorMessage(error, "Erro desconhecido.");

  // Console first — keeps dev experience identical.
  if (typeof console !== "undefined") {
    console.error(`[${scope}]`, message, error);
  }

  // Buffer-then-persist so the in-memory dump always reflects what was
  // observed even if the action_history insert fails.
  appendLogEntry({
    timestamp: new Date().toISOString(),
    ...buildPayload(scope, error, context),
  });

  if (isPersisting) {
    return;
  }

  isPersisting = true;

  Promise.resolve()
    .then(() =>
      createActionHistoryEntry(
        {
          actionType: "error",
          entityType: "log",
          entityId: scope,
          label: `Erro em ${scope}`,
          description: message,
          payload: buildPayload(scope, error, context),
        },
        // O registro de um erro NÃO agenda sincronização. Toda gravação
        // comum agenda um upload do banco inteiro; se esta também agendasse,
        // uma falha de upload registraria um erro, que agendaria outro
        // upload, que falharia de novo — sem parar. Foi o que aconteceu
        // quando o arquivo passou do limite do armazenamento: uma alteração
        // virava uma tentativa a cada 2 s, cada uma exportando o banco todo.
        // A linha sobe junto com a próxima alteração de verdade.
        { scheduleSync: false },
      ),
    )
    .catch(() => {
      // Swallow — by design, a logger must never fail noisily.
    })
    .finally(() => {
      isPersisting = false;
    });
}

/**
 * Installs window-level error handlers. Call once at application startup.
 *
 * Captures errors that escaped local try/catch blocks (uncaught exceptions
 * and unhandled promise rejections) so they show up in the action history
 * instead of disappearing into the browser console only.
 */
export function installGlobalErrorHandlers() {
  if (typeof window === "undefined") {
    return;
  }

  window.addEventListener("error", (event) => {
    logError("window.error", event.error ?? new Error(event.message ?? "Erro não tratado"), {
      filename: event.filename ?? "",
      lineno: event.lineno ?? 0,
      colno: event.colno ?? 0,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    logError(
      "unhandledrejection",
      event.reason instanceof Error ? event.reason : new Error(String(event.reason ?? "Promise rejeitada sem motivo")),
    );
  });
}
