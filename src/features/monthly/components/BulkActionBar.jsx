import Button from "../../../components/ui/Button";
import { CheckIcon } from "../../../components/ui/icons";
import { formatInteger } from "../../../utils/format";

/**
 * Sticky-ish action bar that appears at the top of the Monthly list when
 * the user has at least one summary row selected via the row checkbox.
 *
 * Patterned after Gmail / Linear / GitHub: hides until there's a
 * selection, gives the user exactly the actions that make sense for the
 * current selection (with counts of what will actually change), and a
 * "limpar" escape hatch.
 *
 * Each action only operates on the selected rows it can actually change:
 * abater takes the pending ones, desabater the realized ones (both also
 * require `canUpdateAbatement`). The bar surfaces the counts so the operator
 * knows exactly what'll happen:
 *
 *   "3 selecionados · 2 pendente(s) para abater · 1 realizado(s) para desabater"
 *
 * Before desabater existed, selecting only realized rows was a dead end: the
 * bar said nothing was pending and offered a disabled button.
 *
 * Padding/margins keep it visible at the top of the SectionCard without
 * clobbering the existing toolbar — it lives ABOVE the filters bar and
 * scrolls with the page (no `position: sticky` because the parent grid
 * is the page itself).
 */
export default function BulkActionBar({
  selectedCount,
  eligibleCount,
  revertibleCount = 0,
  onApplyBulk,
  onRevertBulk,
  onClear,
  isApplying = false,
  isReverting = false,
}) {
  if (selectedCount === 0) return null;

  const isBusy = isApplying || isReverting;
  const detail =
    [
      eligibleCount > 0
        ? `${formatInteger(eligibleCount)} pendente(s) para abater`
        : "",
      revertibleCount > 0
        ? `${formatInteger(revertibleCount)} realizado(s) para desabater`
        : "",
    ]
      .filter(Boolean)
      .join(" · ") || "Nenhuma das linhas selecionadas pode mudar de status";

  return (
    <div
      role="region"
      aria-label="Ações em lote"
      className="mb-4 flex flex-col gap-3 rounded-md border border-[var(--accent)] bg-[var(--surface-elevated)] p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-center gap-3">
        <div
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--accent)] text-[var(--on-accent)]"
        >
          <CheckIcon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--text-main)]">
            {formatInteger(selectedCount)} selecionado(s)
          </p>
          <p className="text-xs text-[var(--muted)]">{detail}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="primary"
          onClick={onApplyBulk}
          disabled={eligibleCount === 0 || isBusy}
          isLoading={isApplying}
          loadingLabel="Abatendo..."
          className="min-h-9 px-3 py-1.5 text-xs"
        >
          Abater {formatInteger(eligibleCount)} pendente(s)
        </Button>
        {onRevertBulk ? (
          <Button
            variant="subtle"
            onClick={onRevertBulk}
            disabled={revertibleCount === 0 || isBusy}
            isLoading={isReverting}
            loadingLabel="Desabatendo..."
            className="min-h-9 px-3 py-1.5 text-xs"
          >
            Desabater {formatInteger(revertibleCount)} realizado(s)
          </Button>
        ) : null}
        <Button
          variant="subtle"
          onClick={onClear}
          disabled={isBusy}
          className="min-h-9 px-3 py-1.5 text-xs"
        >
          Limpar seleção
        </Button>
      </div>
    </div>
  );
}
