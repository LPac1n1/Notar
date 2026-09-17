import { memo, useState } from "react";
import CopyableValue from "../../../components/ui/CopyableValue";
import StatusBadge from "../../../components/ui/StatusBadge";
import { ChevronDownIcon, WarningIcon } from "../../../components/ui/icons";
import { formatCpf } from "../../../utils/cpf";
import { formatMonthYear, hasDonationStartConflict } from "../../../utils/date";
import { formatCurrency, formatInteger } from "../../../utils/format";
import { describeInactivity } from "../../../services/monthly/inactivityStreaks";
import MetricField from "./MetricField";
import MonthlyRowHistoryPanel from "./MonthlyRowHistoryPanel";
import StatusToggle from "./StatusToggle";

function MonthlySummaryRowBase({
  summary,
  isUpdating = false,
  onNavigate,
  onStatusChange,
  reconciliation,
  inactivity,
  isLatestImportedMonth = false,
  showReferenceMonth = false,
  isSelected = false,
  onToggleSelect,
  onDeleteAdjustment,
}) {
  // The streak is a *current-state* metric: it counts back from the most
  // recently imported month. Rendering it on an older month's row would read
  // as "this donor was N months idle back then", which is not what it means —
  // so it only shows on the latest month.
  const inactivityMonths = Number(inactivity?.monthsWithoutDonating ?? 0);
  const showInactivityBadge =
    isLatestImportedMonth &&
    !summary.hasDonationsInMonth &&
    inactivityMonths >= 1;
  const inactivityDescription = describeInactivity(inactivity ?? {});
  const [expanded, setExpanded] = useState(false);
  // History panel — separate from mobile `expanded` because it loads
  // remote data (last 6 months) and we don't want it firing on every
  // mobile expand. Only fetched the first time the user clicks the
  // history toggle.
  const [historyOpen, setHistoryOpen] = useState(false);

  const hasStartDateConflict =
    summary.hasDonationsInMonth &&
    (summary.sourceStartConflictCount > 0 ||
      hasDonationStartConflict(
        summary.donationStartDate,
        summary.referenceMonth,
      ));

  const compactStatusTone = summary.isSubsumed
    ? "neutral"
    : summary.abatementStatus === "applied"
      ? "success"
      : summary.hasDonationsInMonth
        ? "warning"
        : "neutral";

  const compactStatusLabel = summary.isSubsumed
    ? "Via acumulado"
    : !summary.hasDonationsInMonth
      ? "Sem doação"
      : summary.abatementStatus === "applied"
        ? "Realizado"
        : "Pendente";

  const detailId = `monthly-row-detail-${summary.id}`;

  // Checkbox visible whenever the parent provided a toggle callback. We
  // render it on a dedicated rail so it doesn't shift the existing
  // header layout — `position: absolute` against the article keeps the
  // mobile button row clickable without intercepting taps on the
  // checkbox.
  const checkboxRail = onToggleSelect ? (
    <label
      className={`absolute left-3 top-3 z-10 flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border bg-[var(--surface)] transition-colors hover:border-[var(--accent)] ${
        isSelected ? "border-[var(--accent)]" : "border-[var(--line)]"
      }`}
      onClick={(event) => event.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={isSelected}
        onChange={(event) => onToggleSelect(summary.id, event.target.checked)}
        className="h-3.5 w-3.5 accent-[var(--accent)]"
        aria-label={`Selecionar ${summary.donorName}`}
      />
    </label>
  ) : null;

  return (
    <article
      className={`relative rounded-md border transition-colors ${
        isSelected
          ? // Seleção fica na família do accent (mesmo matiz da borda). Antes o
            // fundo era verde (--accent-2-soft) com borda índigo: dois matizes
            // brigando, e o verde ainda colidia com o significado semântico de
            // "sucesso/realizado" usado nos badges do próprio card.
            "border-[var(--accent)] bg-[var(--accent-selected)]"
          : hasStartDateConflict
            ? "border-[var(--warning-line)] bg-[var(--surface-elevated)]"
            : !summary.hasDonationsInMonth
              ? "border-[var(--line)] bg-[var(--surface-strong)]"
              : "border-[var(--line)] bg-[var(--surface-elevated)]"
      }`}
    >
      {checkboxRail}
      {/* Compact mobile header (≤ md). Tapping toggles the expanded detail.
          Desktop/tablet (md+) skip the header and render the full layout
          directly below. */}
      <button
        type="button"
        className={`flex w-full items-center gap-3 p-4 text-left md:hidden ${onToggleSelect ? "pl-12" : ""}`}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={detailId}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium text-[var(--text-main)]">
              {summary.donorName}
            </span>
            <StatusBadge label={compactStatusLabel} tone={compactStatusTone} />
          </div>
          <div className="mt-1 truncate text-xs text-[var(--muted)]">
            {formatCpf(summary.cpf)}
            {showReferenceMonth
              ? ` · ${formatMonthYear(summary.referenceMonth)}`
              : ""}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <p
            className={`text-right font-semibold ${
              !summary.hasDonationsInMonth
                ? "text-[var(--text-soft)]"
                : summary.abatementStatus === "applied"
                  ? "text-[var(--success)]"
                  : "text-[var(--warning)]"
            }`}
          >
            {formatCurrency(summary.abatementAmount)}
          </p>
          <ChevronDownIcon
            className={`h-4 w-4 text-[var(--muted)] transition-transform ${
              expanded ? "rotate-180" : ""
            }`}
          />
        </div>
      </button>

      {/* Full detail. Mobile: only shown when expanded, with a top divider so
          it visually separates from the compact header. Tablet/desktop:
          always shown with regular padding. */}
      <div
        id={detailId}
        className={`${
          expanded ? "block border-t border-[var(--line)] p-4" : "hidden"
        } md:block md:border-t-0 md:p-4 ${onToggleSelect ? "md:pl-12" : ""}`}
      >
        {/* Identidade e ações lado a lado; as métricas ganham uma faixa
            própria de largura total logo abaixo. Antes as 5-6 métricas eram
            espremidas numa coluna `minmax(0,1fr)` do meio — davam ~55px cada
            e os valores monetários se sobrepunham uns aos outros. */}
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-start">
          <div className="min-w-0">
            <CopyableValue copyLabel="Copiar nome" value={summary.donorName}>
              <button
                type="button"
                onClick={() => onNavigate?.(summary.donorId)}
                className="text-left font-medium text-[var(--text-main)] underline-offset-4 transition hover:text-[var(--accent)] hover:underline"
              >
                {summary.donorName}
              </button>
            </CopyableValue>

            <div className="mt-2 flex flex-wrap gap-2">
              <StatusBadge status={summary.donorType} />
              <StatusBadge
                label={
                  summary.hasDonationsInMonth
                    ? "Doou no mês"
                    : "Não doou no mês"
                }
                tone={summary.hasDonationsInMonth ? "success" : "neutral"}
              />
              {summary.isSubsumed ? (
                <span
                  className="rounded-md border border-[var(--line)] bg-[var(--surface-strong)] px-2 py-1 text-xs font-semibold text-[var(--muted)]"
                  title={
                    summary.subsumedByReferenceMonth
                      ? `Incluído no acumulado de ${formatMonthYear(summary.subsumedByReferenceMonth)}`
                      : "Incluído em um abatimento acumulado"
                  }
                >
                  Via acumulado
                </span>
              ) : summary.hasAdjustment && summary.adjustment ? (
                <span
                  className="rounded-md border border-[var(--warning-line)] bg-[color:var(--warning-soft)] px-2 py-1 text-xs font-semibold text-[var(--warning)]"
                  title={summary.adjustment.description || ""}
                >
                  Acumulado
                </span>
              ) : null}
              {showInactivityBadge ? (
                <span
                  className={`rounded-md border px-2 py-1 text-xs font-semibold ${
                    inactivityDescription.tone === "danger"
                      ? "border-[var(--danger-line)] bg-[var(--danger-soft)] text-[var(--danger)]"
                      : "border-[var(--warning-line)] bg-[color:var(--warning-soft)] text-[var(--warning)]"
                  }`}
                  title={
                    inactivity?.hasNeverDonated
                      ? "Este doador nunca enviou notas desde o início das doações informado no cadastro."
                      : `Última doação em ${formatMonthYear(inactivity.lastDonationMonth)}. Contagem até o mês importado mais recente.`
                  }
                >
                  {inactivityDescription.label}
                </span>
              ) : null}
            </div>

            {summary.donorType === "auxiliary" && summary.holderName ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="rounded-md border border-[var(--line)] bg-[var(--surface-strong)] px-2 py-1 text-xs font-medium text-[var(--text-soft)]">
                  Vinculado a:{" "}
                  <CopyableValue
                    copyLabel="Copiar nome"
                    value={summary.holderName}
                  >
                    <span>{summary.holderName}</span>
                  </CopyableValue>
                </span>
                {!summary.holderIsActiveDonor ? (
                  <StatusBadge label="Pessoa de referência" tone="neutral" />
                ) : null}
              </div>
            ) : null}

            {/* Auxiliares do titular. Só titulares têm auxiliares (um auxiliar
                nunca vira titular de outro — ver `ensurePersonCanBeAuxiliary`),
                então este bloco é o espelho do "Vinculado a:" acima. */}
            {summary.auxiliaries?.length > 0 ? (
              <div className="mt-2 rounded-md border border-[var(--line)] bg-[var(--surface-strong)] px-2.5 py-2">
                <p className="text-xs font-medium text-[var(--muted)]">
                  {formatInteger(summary.auxiliaries.length)} auxiliar(es)
                  vinculado(s)
                </p>
                <ul className="mt-1 space-y-0.5">
                  {summary.auxiliaries.map((auxiliary) => (
                    <li
                      key={auxiliary.cpf || auxiliary.name}
                      className="text-xs break-words text-[var(--text-soft)]"
                      title={
                        auxiliary.cpf
                          ? `${auxiliary.name} • ${formatCpf(auxiliary.cpf)}`
                          : auxiliary.name
                      }
                    >
                      {auxiliary.name}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm text-[var(--muted)]">
              <span className="inline-flex items-center gap-1.5">
                CPF:
                <CopyableValue
                  copyLabel="Copiar CPF"
                  value={formatCpf(summary.cpf)}
                >
                  <span>{formatCpf(summary.cpf)}</span>
                </CopyableValue>
              </span>
              <span>Demanda: {summary.demand || "Não informada"}</span>
            </div>

            {summary.sources.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {summary.sources.map((source) => (
                  <span
                    key={`${summary.id}-${source.cpf}`}
                    className={`rounded-md border px-2 py-1 text-xs ${
                      source.type === "auxiliary"
                        ? "border-[var(--success-line)] bg-[color:var(--success-soft)] text-[var(--success)]"
                        : "border-[var(--line)] bg-[color:var(--surface-muted)] text-[var(--text-soft)]"
                    }`}
                    title={`${source.name} • ${formatCpf(source.cpf)} • ${source.notesCount} nota(s)`}
                  >
                    {source.type === "auxiliary" ? (
                      <>
                        Auxiliar:{" "}
                        <CopyableValue
                          copyLabel="Copiar nome"
                          value={source.name}
                        >
                          <span>{source.name}</span>
                        </CopyableValue>
                      </>
                    ) : (
                      "CPF principal"
                    )}
                  </span>
                ))}
              </div>
            ) : null}

            {hasStartDateConflict ? (
              <p className="mt-2 flex items-start gap-1.5 text-sm text-[var(--warning)]">
                <WarningIcon
                  className="mt-0.5 h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
                <span>
                  Atenção: {summary.sourceStartConflictCount || 1} CPF(s)
                  vinculado(s) apareceram antes do início de doação informado.
                </span>
              </p>
            ) : null}

            {summary.invalidNotesCount > 0 ? (
              <p className="mt-2 flex items-start gap-1.5 text-sm text-[var(--warning)]">
                <WarningIcon
                  className="mt-0.5 h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
                <span>
                  {formatInteger(summary.invalidNotesCount)} nota(s)
                  descartada(s) por status do pedido inválido.
                </span>
              </p>
            ) : null}
          </div>

          <div className="flex w-full flex-col gap-2 xl:w-[220px] xl:items-end">
            {summary.canUpdateAbatement ? (
              <StatusToggle
                value={summary.abatementStatus}
                disabled={isUpdating}
                isLoading={isUpdating}
                onChange={(nextStatus) =>
                  onStatusChange?.(summary.id, nextStatus)
                }
              />
            ) : summary.isSubsumed ? (
              <div
                className="flex min-h-10 w-full items-center rounded-md border border-[var(--line)] bg-[var(--surface-strong)] px-3 text-sm font-medium text-[var(--muted)] xl:w-[220px]"
                title="Este mês faz parte de um abatimento acumulado e não pode ser alterado individualmente"
              >
                Via acumulado
              </div>
            ) : (
              <div className="flex min-h-10 w-full items-center rounded-md border border-[var(--line)] bg-[var(--surface-strong)] px-3 text-sm font-medium text-[var(--muted)] xl:w-[220px]">
                Sem doações no mês
              </div>
            )}

            {summary.hasAdjustment && summary.adjustment && onDeleteAdjustment ? (
              <button
                type="button"
                disabled={isUpdating}
                onClick={() => onDeleteAdjustment(summary)}
                title="Apaga o lançamento de acumulado deste mês. Os meses que ele cobria voltam a ser pendentes, um a um."
                className="w-full rounded-md border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-1.5 text-xs font-medium text-[var(--text-soft)] transition hover:border-[var(--line-strong)] hover:text-[var(--text-main)] disabled:cursor-not-allowed disabled:opacity-60 xl:w-[220px]"
              >
                Deslançar acumulado
              </button>
            ) : null}

            <p className="text-xs text-[var(--muted)] xl:text-right">
              {summary.abatementMarkedAt
                ? `Marcado em ${summary.abatementMarkedAt}`
                : summary.isSubsumed
                  ? summary.subsumedByReferenceMonth
                    ? `Incluído no acumulado de ${formatMonthYear(summary.subsumedByReferenceMonth)}`
                    : "Incluído em um acumulado"
                  : summary.canUpdateAbatement
                    ? "Ainda não marcado"
                    : "Nenhum abatimento gerado"}
            </p>
          </div>
        </div>

        {/* Faixa de métricas em largura total, separada por uma linha. Cada
            coluna recebe ~180px em vez dos ~55px de quando dividia espaço
            com a identidade do doador. */}
        <div
          className={`mt-4 grid gap-x-5 gap-y-3 border-t border-[var(--line)] pt-4 ${
            showReferenceMonth
              ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6"
              : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"
          }`}
        >
          {showReferenceMonth ? (
            <MetricField
              label="Mês"
              value={formatMonthYear(summary.referenceMonth)}
            />
          ) : null}

          <MetricField
            label="Notas"
            value={formatInteger(summary.notesCount)}
            helper={
              summary.hasAdjustment && summary.adjustment
                ? summary.adjustmentSubsumesMonth
                  ? `Acumulado de ${summary.adjustment.rangeStartMonth?.slice(0, 7) ?? ""} a ${summary.adjustment.rangeEndMonth?.slice(0, 7) ?? ""}`
                  : `${formatInteger(summary.monthNotesCount ?? 0)} no mês + ${formatInteger(summary.adjustment.notesCount)} acumuladas`
                : summary.hasDonationsInMonth
                  ? `${formatInteger(summary.sourceCpfCount)} CPF(s) com notas`
                  : `${formatInteger(summary.sourceCpfCount)} CPF(s) cadastrados`
            }
          />

          <MetricField
            label="Valor por nota"
            value={formatCurrency(summary.valuePerNote)}
          />

          <MetricField
            label="Abatimento"
            value={formatCurrency(summary.abatementAmount)}
            valueClassName={
              summary.hasDonationsInMonth
                ? summary.abatementStatus === "applied"
                  ? "text-[var(--success)]"
                  : "text-[var(--warning)]"
                : "text-[var(--text-soft)]"
            }
            helper={
              summary.hasAdjustment && summary.adjustment
                ? summary.adjustmentSubsumesMonth
                  ? "Total acumulado"
                  : `${formatCurrency(summary.monthAbatementAmount ?? 0)} mês + ${formatCurrency(summary.adjustment.abatementAmount)} acumulado`
                : undefined
            }
          />

          {/* Reconciliation columns — scoped to this row's own month (see
                `listDonorMonthReconciliationStatuses`). Show "—" for the
                no-credit case so the column doesn't disappear and pull other
                rows out of grid alignment. */}
          <MetricField
            label="Crédito no mês"
            value={
              reconciliation ? formatCurrency(reconciliation.totalCredit) : "—"
            }
            helper={
              reconciliation && reconciliation.matchedNoteCount > 0
                ? `${formatInteger(reconciliation.matchedNoteCount)} nota(s) casada(s)`
                : undefined
            }
          />

          <MetricField
            label="Saldo"
            value={
              reconciliation ? formatCurrency(-reconciliation.difference) : "—"
            }
            helper={
              // Só descreve o sinal do número. Antes havia um alerta vermelho
              // quando o abatido passava do crédito casado, mas ele acendia
              // sozinho no mês cuja planilha de créditos ainda não foi
              // importada — sinalizando erro onde não havia nenhum.
              reconciliation && reconciliation.difference > 0
                ? "Abatido acima do crédito casado"
                : undefined
            }
          />
        </div>

        {/* Histórico do doador — fica disponível em qualquer linha que
            tenha donorId real (linhas "Via acumulado" / "Sem doação"
            também). Só carrega dados quando o usuário expande. */}
        {summary.donorId ? (
          <div className="mt-4 border-t border-[var(--line)] pt-3">
            <button
              type="button"
              onClick={() => setHistoryOpen((value) => !value)}
              aria-expanded={historyOpen}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--text-soft)] transition-colors hover:text-[var(--accent)]"
            >
              <ChevronDownIcon
                className={`h-3.5 w-3.5 transition-transform ${
                  historyOpen ? "rotate-180" : ""
                }`}
              />
              {historyOpen ? "Ocultar" : "Mostrar"} histórico do doador
            </button>
            {historyOpen ? (
              <MonthlyRowHistoryPanel
                donorId={summary.donorId}
                currentMonthAbatement={summary.abatementAmount ?? 0}
                currentMonthCreditValue={
                  reconciliation ? reconciliation.totalCredit : null
                }
                currentMonthDifference={
                  reconciliation ? reconciliation.difference : null
                }
                onOpenProfile={onNavigate}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

// Memoized so flipping one row's `isUpdating` (during the StatusToggle
// round-trip) doesn't re-render the other 999 rows in a large month.
// Default shallow comparison is enough — every prop here is either a
// primitive or a stable callback/object from the parent's useCallback /
// useMemo chains.
const MonthlySummaryRow = memo(MonthlySummaryRowBase);

export default MonthlySummaryRow;
