import Button from "../../../components/ui/Button";
import CopyableValue from "../../../components/ui/CopyableValue";
import EmptyState from "../../../components/ui/EmptyState";
import SectionCard from "../../../components/ui/SectionCard";
import StatusBadge from "../../../components/ui/StatusBadge";
import { CheckIcon } from "../../../components/ui/icons";
import { formatCpf } from "../../../utils/cpf";
import { formatMonthYear } from "../../../utils/date";
import { formatCurrency, formatInteger } from "../../../utils/format";

function getMonthButtonClassName(isApplied) {
  if (isApplied) {
    return "border-[var(--success-line)] bg-[color:var(--success-soft)] text-[var(--success)]";
  }

  return "border-[var(--warning-line)] bg-[color:var(--warning-soft)] text-[var(--warning)] hover:border-[var(--line-strong)]";
}

export default function ConsolidatedPendingDonors({
  donors,
  onCatchUp,
  onDeleteAdjustment,
  onOpenDonor,
  onStatusChange,
  selectedMonthsLabel = "",
  updatingDonorId = "",
}) {
  return (
    <SectionCard
      title="Abatimentos por doador"
      description={
        selectedMonthsLabel
          ? `Valores somados de ${selectedMonthsLabel}, com o detalhe de cada mês.`
          : "Histórico consolidado dos meses com doação."
      }
      className="mb-5"
    >
      {donors.length === 0 ? (
        <EmptyState
          title="Nenhum abatimento encontrado"
          description="Não há meses com doação para os filtros aplicados."
        />
      ) : (
        <div className="space-y-3">
          {donors.map((donor) => {
            const isUpdating = updatingDonorId === donor.donorId;
            const pendingMonths = donor.months.filter(
              (month) => month.abatementStatus !== "applied" && !month.isSubsumed,
            );

            return (
              <article
                key={donor.donorId}
                className="rounded-md border border-[var(--line)] bg-[var(--surface-elevated)] p-4"
              >
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(280px,320px)] xl:items-start">
                  <div className="min-w-0 space-y-3">
                    <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <CopyableValue
                            copyLabel="Copiar nome"
                            value={donor.donorName}
                          >
                            <button
                              type="button"
                              onClick={() => onOpenDonor?.(donor.donorId)}
                              className="text-left font-semibold text-[var(--text-main)] underline-offset-4 transition hover:text-[var(--accent)] hover:underline"
                            >
                              {donor.donorName}
                            </button>
                          </CopyableValue>
                          <StatusBadge status={donor.donorType} />
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-[var(--muted)]">
                          <span className="inline-flex items-center gap-1.5">
                            CPF:
                            <CopyableValue
                              copyLabel="Copiar CPF"
                              value={formatCpf(donor.cpf)}
                            >
                              <span>{formatCpf(donor.cpf)}</span>
                            </CopyableValue>
                          </span>
                          <span>Demanda: {donor.demand || "Não informada"}</span>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-1.5 text-[11px] font-medium">
                        <span className="rounded-md border border-[var(--success-line)] bg-[color:var(--success-soft)] px-2 py-1 text-[var(--success)]">
                          Realizado
                        </span>
                        <span className="rounded-md border border-[var(--warning-line)] bg-[color:var(--warning-soft)] px-2 py-1 text-[var(--warning)]">
                          Pendente
                        </span>
                        <span className="rounded-md border border-[var(--line)] bg-[var(--surface-strong)] px-2 py-1 text-[var(--muted)]">
                          Via acumulado
                        </span>
                      </div>
                    </div>

                    {donor.donorType === "auxiliary" && donor.holderName ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-md border border-[var(--line)] bg-[var(--surface-strong)] px-2 py-1 text-xs font-medium text-[var(--text-soft)]">
                          Vinculado a:{" "}
                          <CopyableValue
                            copyLabel="Copiar nome"
                            value={donor.holderName}
                          >
                            <span>{donor.holderName}</span>
                          </CopyableValue>
                        </span>
                      </div>
                    ) : null}

                    {donor.invalidNotesCount > 0 ? (
                      <p className="text-sm text-[var(--warning)]">
                        {formatInteger(donor.invalidNotesCount)} nota(s)
                        descartada(s) por status do pedido inválido.
                      </p>
                    ) : null}

                    <div className="rounded-md border border-[var(--line)] bg-[var(--surface-strong)] p-3">
                      <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-sm font-semibold text-[var(--text-main)]">
                          Meses com doação
                        </p>
                        <p className="text-xs text-[var(--muted)]">
                          Clique para alternar entre realizado e pendente
                        </p>
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        {donor.months.map((month) => {
                          if (month.isSubsumed) {
                            const subsumedLabel = month.subsumedByReferenceMonth
                              ? `Incluído no acumulado de ${formatMonthYear(month.subsumedByReferenceMonth)}`
                              : "Incluído em um acumulado";
                            return (
                              <span
                                key={month.id}
                                title={`${formatMonthYear(month.referenceMonth)} • ${formatCurrency(month.abatementAmount)} • ${subsumedLabel}`}
                                className="cursor-default rounded-md border border-[var(--line)] bg-[var(--surface-strong)] px-2.5 py-1.5 text-xs font-medium text-[var(--muted)]"
                              >
                                {formatMonthYear(month.referenceMonth)}
                              </span>
                            );
                          }

                          const isApplied = month.abatementStatus === "applied";
                          const tooltip = `${formatMonthYear(month.referenceMonth)} • ${formatCurrency(month.abatementAmount)} • Clique para ${
                            isApplied ? "desmarcar" : "realizar"
                          }`;

                          return (
                            <button
                              key={month.id}
                              type="button"
                              disabled={isUpdating}
                              title={tooltip}
                              aria-label={`${formatMonthYear(month.referenceMonth)}, ${formatCurrency(month.abatementAmount)}, status ${isApplied ? "realizado" : "pendente"}. Clique para ${isApplied ? "marcar como pendente" : "marcar como realizado"}.`}
                              onClick={() =>
                                onStatusChange?.(
                                  donor,
                                  isApplied ? "pending" : "applied",
                                  {
                                    operation: isApplied
                                      ? "undo-applied"
                                      : "manual",
                                    summaryIds: month.ids ?? [month.id],
                                  },
                                )
                              }
                              className={`rounded-md border px-2.5 py-1.5 text-xs font-medium transition ${getMonthButtonClassName(
                                isApplied,
                              )} ${
                                isUpdating ? "cursor-not-allowed opacity-75" : ""
                              }`.trim()}
                            >
                              {formatMonthYear(month.referenceMonth)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  <aside className="space-y-3 rounded-md border border-[var(--line)] bg-[var(--surface-strong)] p-3">
                    <div>
                      <p className="text-sm font-semibold text-[var(--text-main)]">
                        Resumo
                      </p>
                      <p className="text-xs text-[var(--muted)]">
                        Valores do histórico exibido para este doador.
                      </p>
                    </div>

                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                      <div className="rounded-md border border-[var(--line)] bg-[var(--surface-elevated)] p-3">
                        <p className="text-xs text-[var(--muted)]">Pendente</p>
                        <p className="font-semibold text-[var(--warning)]">
                          {formatCurrency(donor.totalPending)}
                        </p>
                        <p className="text-xs text-[var(--muted)]">
                          {formatInteger(pendingMonths.length)} mês(es)
                        </p>
                      </div>
                      <div className="rounded-md border border-[var(--line)] bg-[var(--surface-elevated)] p-3">
                        <p className="text-xs text-[var(--muted)]">Realizado</p>
                        <p className="font-semibold text-[var(--success)]">
                          {formatCurrency(donor.totalApplied)}
                        </p>
                      </div>
                    </div>

                    {pendingMonths.length > 1 ? (
                      <Button
                        variant="subtle"
                        className="w-full"
                        disabled={isUpdating}
                        onClick={() => onCatchUp?.(donor)}
                        title="Agrupa meses pendentes em um único lançamento de acumulado, ideal para doadores que não doaram por um período e retomaram."
                      >
                        Lançar acumulado
                      </Button>
                    ) : null}

                    {onDeleteAdjustment
                      ? (donor.adjustments ?? []).map((adjustment) => (
                          <Button
                            key={adjustment.id}
                            variant="subtle"
                            className="w-full"
                            disabled={isUpdating}
                            onClick={() => onDeleteAdjustment(donor, adjustment)}
                            title="Apaga o lançamento de acumulado. Os meses que ele cobria voltam a ser pendentes, um a um."
                          >
                            Deslançar acumulado de{" "}
                            {formatMonthYear(adjustment.referenceMonth)}
                          </Button>
                        ))
                      : null}

                    {pendingMonths.length > 0 ? (
                      <Button
                        className="w-full"
                        disabled={isUpdating}
                        isLoading={isUpdating}
                        loadingLabel="Abatendo..."
                        onClick={() =>
                          onStatusChange?.(donor, "applied", {
                            operation: "all",
                            summaryIds: pendingMonths.flatMap(
                              (month) => month.ids ?? [month.id],
                            ),
                          })
                        }
                        leftIcon={<CheckIcon className="h-4 w-4" />}
                      >
                        Abater todas as pendências
                      </Button>
                    ) : (
                      <div className="rounded-md border border-[var(--success-line)] bg-[color:var(--success-soft)] px-3 py-2 text-center text-sm font-semibold text-[var(--success)]">
                        Todas as pendências abatidas
                      </div>
                    )}
                  </aside>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}
