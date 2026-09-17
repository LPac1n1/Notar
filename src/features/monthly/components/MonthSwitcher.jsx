import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "../../../components/ui/icons";
import { formatMonthYear } from "../../../utils/date";
import { formatCurrency, formatInteger } from "../../../utils/format";

/**
 * Persistent month anchor for the Monthly page. Renders the currently
 * selected month as a clickable chip — click opens a vertical menu of
 * all imported months. Closing on outside-click + Escape, focus
 * trapped to the menu while open.
 *
 * Replaces the previous full-width carousel as the *primary* picker:
 * the carousel can still live below the action bar as a secondary
 * "browse the months" affordance, but the switcher is what the
 * operator reaches for on every month-jump.
 */
export default function MonthSwitcher({
  selectedReferenceMonth,
  selectedMonthsCount = 0,
  availableImports,
  onSelectMonth,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;

    function handleClickOutside(event) {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    function handleEscape(event) {
      if (event.key === "Escape") setIsOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  if (!availableImports || availableImports.length === 0) {
    return null;
  }

  const selectedImport = availableImports.find(
    (item) => item.referenceMonth === selectedReferenceMonth,
  );
  // Com vários meses marcados no carrossel não existe "o mês" para mostrar
  // aqui; o chip passa a dizer quantos são. Escolher um mês por este menu
  // continua sendo seleção única e substitui a marcação.
  const triggerLabel = selectedReferenceMonth
    ? formatMonthYear(selectedReferenceMonth)
    : selectedMonthsCount > 1
      ? `${selectedMonthsCount} meses`
      : "Selecionar mês";

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setIsOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        className="inline-flex min-h-10 items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--surface-elevated)] px-3 py-2 text-sm font-semibold text-[var(--text-main)] transition-colors hover:border-[var(--line-strong)] hover:bg-[var(--surface-muted)]"
      >
        <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">
          Mês
        </span>
        <span className="font-display text-base font-bold">
          {triggerLabel}
        </span>
        <ChevronDownIcon
          className={`h-4 w-4 text-[var(--muted)] transition-transform ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {isOpen ? (
        <div
          role="listbox"
          aria-label="Meses importados"
          className="absolute left-0 top-full z-40 mt-2 max-h-80 w-72 overflow-y-auto rounded-md border border-[var(--line)] bg-[var(--surface)] py-1 shadow-lg"
        >
          {availableImports.map((item) => {
            const isSelected = item.referenceMonth === selectedReferenceMonth;
            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onSelectMonth(item.referenceMonth);
                  setIsOpen(false);
                }}
                className={`flex w-full items-start gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-[var(--surface-muted)] ${
                  isSelected
                    ? "bg-[var(--surface-strong)] text-[var(--accent)]"
                    : "text-[var(--text-soft)]"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <p
                    className={`truncate font-semibold ${
                      isSelected
                        ? "text-[var(--accent)]"
                        : "text-[var(--text-main)]"
                    }`}
                  >
                    {formatMonthYear(item.referenceMonth)}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-[var(--muted)]">
                    {formatInteger(item.totalRows ?? 0)} nota(s) ·{" "}
                    {formatCurrency(item.valuePerNote ?? 0)}/nota
                  </p>
                </div>
                {isSelected ? (
                  <span
                    aria-hidden="true"
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]"
                  />
                ) : null}
              </button>
            );
          })}
          {!selectedImport && selectedReferenceMonth ? (
            <p className="border-t border-[var(--line)] px-3 py-2 text-xs text-[var(--muted)]">
              Mês selecionado não está mais nas importações processadas.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
