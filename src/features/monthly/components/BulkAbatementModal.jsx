import { useMemo, useState } from "react";
import Button from "../../../components/ui/Button";
import Modal from "../../../components/ui/Modal";
import { CheckIcon, MonthlyIcon } from "../../../components/ui/icons";
import { formatMonthYear } from "../../../utils/date";
import { formatCurrency, formatInteger } from "../../../utils/format";

/**
 * Os dois sentidos da operação em massa. A chave é o status que o modal
 * GRAVA: "applied" abate as linhas pendentes, "pending" desabate as
 * realizadas.
 *
 * O tom acompanha o status de destino, com as cores do seletor de cada linha
 * (verde para realizado, âmbar para pendente): o operador reconhece pela cor o
 * que vai acontecer antes de ler o botão.
 */
const MODES = {
  applied: {
    sourceStatus: "pending",
    title: "Abatimento em massa",
    description:
      "Selecione os meses que serão marcados como realizados para todos os doadores com doação pendente.",
    emptyDescription:
      "Nenhum abatimento pendente encontrado para os filtros atuais.",
    selectAllLabel: "Abater todas as doações pendentes",
    confirmLabel: "Abater",
    loadingLabel: "Abatendo...",
    confirmVariant: "primary",
    selectedRow: "border-[var(--success-line)] bg-[color:var(--success-soft)]",
    selectedBox: "border-[var(--success)] bg-[var(--success)]",
    summary:
      "border-[var(--success-line)] bg-[color:var(--success-soft)] text-[var(--success)]",
  },
  pending: {
    sourceStatus: "applied",
    title: "Desabatimento em massa",
    description:
      "Selecione os meses cujos abatimentos realizados voltarão a ficar pendentes para os doadores filtrados.",
    emptyDescription:
      "Nenhum abatimento realizado encontrado para os filtros atuais.",
    selectAllLabel: "Desabater todos os abatimentos realizados",
    confirmLabel: "Desabater",
    loadingLabel: "Desabatendo...",
    confirmVariant: "danger",
    selectedRow: "border-[var(--warning-line)] bg-[color:var(--warning-soft)]",
    selectedBox: "border-[var(--warning)] bg-[var(--warning)]",
    summary:
      "border-[var(--warning-line)] bg-[color:var(--warning-soft)] text-[var(--warning)]",
  },
};

/**
 * Agrupa por mês as linhas que o modal pode mudar.
 *
 * Linhas "Via acumulado" (`isSubsumed`) ficam de fora nos dois sentidos: o
 * status delas pertence ao mês em que o acumulado foi lançado. O serviço
 * também as recusa — o filtro aqui é para a contagem mostrada bater com o que
 * de fato muda.
 */
function buildMonthGroups(summaries, sourceStatus) {
  const eligible = summaries.filter(
    (s) =>
      s.hasDonationsInMonth &&
      s.abatementStatus === sourceStatus &&
      !s.isSubsumed,
  );
  const byMonth = new Map();

  for (const summary of eligible) {
    const key = summary.referenceMonth;
    const group = byMonth.get(key) ?? {
      referenceMonth: key,
      summaryIds: [],
      donorIds: new Set(),
      totalAmount: 0,
    };

    group.summaryIds.push(summary.id);
    group.donorIds.add(summary.donorId);
    group.totalAmount += Number(summary.abatementAmount ?? 0);
    byMonth.set(key, group);
  }

  return Array.from(byMonth.values())
    .map((group) => ({ ...group, donorCount: group.donorIds.size }))
    .sort((a, b) => b.referenceMonth.localeCompare(a.referenceMonth));
}

function MonthRow({ group, isSelected, mode, onToggle }) {
  return (
    <button
      type="button"
      onClick={() => onToggle(group.referenceMonth)}
      className={`flex w-full items-center gap-3 rounded-md border p-3 text-left transition ${
        isSelected
          ? mode.selectedRow
          : "border-[var(--line)] bg-[var(--surface-elevated)] hover:border-[var(--line-strong)]"
      }`}
    >
      <div
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
          isSelected ? mode.selectedBox : "border-[var(--line-strong)] bg-transparent"
        }`}
      >
        {isSelected ? (
          <CheckIcon className="h-3 w-3 text-[var(--surface)]" />
        ) : null}
      </div>
      <span className="min-w-0 flex-1 font-medium text-[var(--text-main)]">
        {formatMonthYear(group.referenceMonth)}
      </span>
      <span className="shrink-0 text-sm text-[var(--muted)]">
        {formatInteger(group.donorCount)} doador(es)
      </span>
      <span className="shrink-0 text-sm font-medium text-[var(--text-soft)]">
        {formatCurrency(group.totalAmount)}
      </span>
    </button>
  );
}

function SelectAllRow({ allSelected, someSelected, mode, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`flex w-full items-center gap-3 rounded-md border p-3 text-left transition ${
        allSelected
          ? mode.selectedRow
          : "border-[var(--line)] bg-[var(--surface-strong)] hover:border-[var(--line-strong)]"
      }`}
    >
      <div
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
          allSelected
            ? mode.selectedBox
            : someSelected
              ? "border-[var(--line-strong)] bg-[var(--line-strong)]"
              : "border-[var(--line-strong)] bg-transparent"
        }`}
      >
        {allSelected ? (
          <CheckIcon className="h-3 w-3 text-[var(--surface)]" />
        ) : someSelected ? (
          <span className="block h-0.5 w-2 rounded-full bg-[var(--text-main)]" />
        ) : null}
      </div>
      <span className="font-semibold text-[var(--text-main)]">
        {mode.selectAllLabel}
      </span>
    </button>
  );
}

export default function BulkAbatementModal({
  status = "applied",
  summaries,
  onApply,
  onClose,
  isApplying,
}) {
  const mode = MODES[status] ?? MODES.applied;
  const monthGroups = useMemo(
    () => buildMonthGroups(summaries, mode.sourceStatus),
    [summaries, mode.sourceStatus],
  );
  const [selectedMonths, setSelectedMonths] = useState(() => new Set());

  const allSelected =
    monthGroups.length > 0 && selectedMonths.size === monthGroups.length;
  const someSelected = selectedMonths.size > 0 && !allSelected;

  const selectedGroups = monthGroups.filter((g) =>
    selectedMonths.has(g.referenceMonth),
  );
  const selectedSummaryIds = selectedGroups.flatMap((g) => g.summaryIds);
  const totalDonors = new Set(
    selectedGroups.flatMap((g) => Array.from(g.donorIds ?? [])),
  ).size;
  const totalAmount = selectedGroups.reduce((sum, g) => sum + g.totalAmount, 0);

  function toggleMonth(referenceMonth) {
    setSelectedMonths((prev) => {
      const next = new Set(prev);
      if (next.has(referenceMonth)) {
        next.delete(referenceMonth);
      } else {
        next.add(referenceMonth);
      }
      return next;
    });
  }

  function toggleAll() {
    if (allSelected) {
      setSelectedMonths(new Set());
    } else {
      setSelectedMonths(new Set(monthGroups.map((g) => g.referenceMonth)));
    }
  }

  if (monthGroups.length === 0) {
    return (
      <Modal
        title={mode.title}
        description={mode.emptyDescription}
        icon={<MonthlyIcon className="h-5 w-5" />}
        onClose={onClose}
        size="sm"
      >
        <div className="flex justify-end pt-2">
          <Button variant="subtle" onClick={onClose}>
            Fechar
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={mode.title}
      description={mode.description}
      icon={<MonthlyIcon className="h-5 w-5" />}
      onClose={onClose}
      size="md"
    >
      <div className="space-y-2">
        <SelectAllRow
          allSelected={allSelected}
          someSelected={someSelected}
          mode={mode}
          onToggle={toggleAll}
        />

        <div className="space-y-1.5">
          {monthGroups.map((group) => (
            <MonthRow
              key={group.referenceMonth}
              group={group}
              isSelected={selectedMonths.has(group.referenceMonth)}
              mode={mode}
              onToggle={toggleMonth}
            />
          ))}
        </div>
      </div>

      {selectedSummaryIds.length > 0 ? (
        <div className={`mt-4 rounded-md border px-4 py-3 text-sm ${mode.summary}`}>
          <span className="font-semibold">
            {formatInteger(selectedMonths.size)} mês(es) selecionado(s)
          </span>
          {" · "}
          {formatInteger(totalDonors)} doador(es)
          {" · "}
          {formatCurrency(totalAmount)} total
        </div>
      ) : null}

      <div className="mt-5 flex justify-end gap-3">
        <Button variant="subtle" onClick={onClose} disabled={isApplying}>
          Cancelar
        </Button>
        <Button
          variant={mode.confirmVariant}
          onClick={() => onApply(selectedSummaryIds)}
          disabled={selectedSummaryIds.length === 0 || isApplying}
          isLoading={isApplying}
          loadingLabel={mode.loadingLabel}
        >
          {mode.confirmLabel}{" "}
          {selectedSummaryIds.length > 0
            ? formatInteger(selectedSummaryIds.length)
            : ""}{" "}
          selecionado(s)
        </Button>
      </div>
    </Modal>
  );
}
