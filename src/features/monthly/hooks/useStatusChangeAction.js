import { useCallback } from "react";
import { logError } from "../../../services/logger";
import { getErrorMessage } from "../../../utils/error";

/**
 * Reduces the four near-identical mutation handlers in `Monthly.jsx` (single
 * row toggle, consolidated donor toggle, bulk abate, undo) to a single shared
 * runner. Each call shares the same skeleton:
 *
 *   1. clear error/success/action
 *   2. flag updating donor/summary
 *   3. await the mutation
 *   4. trigger a reload
 *   5. show success + optional Desfazer action
 *   6. on error: log + setError(getErrorMessage(...)) + clear flags
 *
 * The hook returns a function that takes the mutation-specific bits (runner,
 * messages, undo factory) and handles the rest. Returns the truthiness of
 * success so callers can chain follow-up state (e.g. closing a modal only
 * when the action succeeded).
 *
 * @example
 *   const runStatusAction = useStatusChangeAction({
 *     setError, setSuccessMessage, setSuccessAction,
 *     setUpdatingDonorId, setUpdatingSummaryId,
 *     reload: reloadSummaries,
 *   });
 *
 *   await runStatusAction({
 *     scope: "MonthlyPage.bulkAbate",
 *     summaryId,
 *     run: () => updateAbatementStatuses(...),
 *     successMessage: "Abatimentos atualizados.",
 *     undo: { ... },
 *   });
 */
export function useStatusChangeAction({
  setError,
  setSuccessMessage,
  setSuccessAction,
  setUpdatingDonorId,
  setUpdatingSummaryId,
  reload,
}) {
  return useCallback(
    async ({
      scope = "MonthlyPage.statusChange",
      donorId = "",
      summaryId = "",
      run,
      successMessage = "",
      errorMessage = "Não foi possível concluir a operação.",
      undo,
      // Optional: per-call busy flag (e.g. the bulk abate/unabate progress) when the row's
      // updating flag is not the right indicator. Called with `true` at start
      // and `false` in the finally block.
      setBusy,
      // Optional: rollback hook so callers with optimistic UI can undo their
      // local overlay if the server rejected the mutation. Receives the error.
      onError,
      // Optional: hook for callers who need to mutate UI before the round-trip
      // (e.g. seed the optimistic overlay). Runs inside the try block, after
      // flags are cleared but before `run()`.
      onStart,
    }) => {
      setBusy?.(true);
      try {
        setError?.("");
        setSuccessMessage?.("");
        setSuccessAction?.(null);
        setUpdatingDonorId?.(donorId);
        setUpdatingSummaryId?.(summaryId);

        onStart?.();
        await run();
        await reload?.();

        if (successMessage) {
          setSuccessMessage?.(successMessage);
        }

        if (undo) {
          setSuccessAction?.({ label: "Desfazer", onAction: undo });
        }

        return true;
      } catch (err) {
        logError(scope, err);
        onError?.(err);
        setError?.(getErrorMessage(err, errorMessage));
        return false;
      } finally {
        setUpdatingDonorId?.("");
        setUpdatingSummaryId?.("");
        setBusy?.(false);
      }
    },
    [
      setError,
      setSuccessMessage,
      setSuccessAction,
      setUpdatingDonorId,
      setUpdatingSummaryId,
      reload,
    ],
  );
}
