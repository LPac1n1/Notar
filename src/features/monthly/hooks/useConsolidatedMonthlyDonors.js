import { useMemo } from "react";

export function useConsolidatedMonthlyDonors({
  abatementStatus = "all",
  summaries = [],
} = {}) {
  const donationSummaries = useMemo(
    () => summaries.filter((summary) => summary.hasDonationsInMonth),
    [summaries],
  );

  // Subsumed rows belong to a catch-up in a different reference month — exclude
  // them from amount totals to avoid double-counting.
  const activeDonationSummaries = useMemo(
    () => donationSummaries.filter((summary) => !summary.isSubsumed),
    [donationSummaries],
  );

  const totalAbatement = useMemo(
    () =>
      activeDonationSummaries.reduce(
        (accumulator, item) => accumulator + Number(item.abatementAmount ?? 0),
        0,
      ),
    [activeDonationSummaries],
  );

  const pendingSummaries = useMemo(
    () =>
      activeDonationSummaries.filter(
        (summary) => summary.abatementStatus !== "applied",
      ),
    [activeDonationSummaries],
  );

  const totalPendingAbatement = useMemo(
    () =>
      pendingSummaries.reduce(
        (accumulator, item) => accumulator + Number(item.abatementAmount ?? 0),
        0,
      ),
    [pendingSummaries],
  );

  const totalAppliedAbatement = useMemo(
    () =>
      activeDonationSummaries.reduce(
        (accumulator, item) =>
          item.abatementStatus === "applied"
            ? accumulator + Number(item.abatementAmount ?? 0)
            : accumulator,
        0,
      ),
    [activeDonationSummaries],
  );

  const consolidatedDonors = useMemo(() => {
    const donorsById = new Map();

    // Include ALL donation months (including subsumed) in the months display,
    // but skip subsumed amounts when accumulating per-donor totals. Within a
    // donor, duplicate rows for the same reference month (multiple imports
    // for the same month) are collapsed into a single month entry — that
    // way toggling the month operates on every underlying row at once and
    // the user sees one button per month.
    for (const summary of donationSummaries) {
      const current = donorsById.get(summary.donorId) ?? {
        donorId: summary.donorId,
        donorName: summary.donorName,
        donorType: summary.donorType,
        holderName: summary.holderName,
        holderIsActiveDonor: summary.holderIsActiveDonor,
        cpf: summary.cpf,
        demand: summary.demand,
        donationStartDate: summary.donationStartDate ?? "",
        monthsByRef: new Map(),
        totalPending: 0,
        totalApplied: 0,
        invalidNotesCount: 0,
      };

      const monthKey = summary.referenceMonth;
      const month = current.monthsByRef.get(monthKey) ?? {
        id: summary.id,
        referenceMonth: monthKey,
        abatementAmount: 0,
        abatementStatus: "applied",
        ids: [],
        adjustmentIds: [],
        adjustments: [],
        isSubsumed: false,
        subsumedByReferenceMonth: "",
      };

      month.ids.push(summary.id);
      const adjustmentId = summary.adjustment?.id ?? "";
      if (adjustmentId && !month.adjustmentIds.includes(adjustmentId)) {
        month.adjustmentIds.push(adjustmentId);
        month.adjustments.push(summary.adjustment);
      }
      month.abatementAmount += Number(summary.abatementAmount ?? 0);
      // Any pending row keeps the month pending; subsumption from any row
      // wins so the button stays non-actionable.
      if (summary.abatementStatus !== "applied") {
        month.abatementStatus = "pending";
      }
      if (summary.isSubsumed) {
        month.isSubsumed = true;
        if (!month.subsumedByReferenceMonth) {
          month.subsumedByReferenceMonth =
            summary.subsumedByReferenceMonth ?? "";
        }
      }
      current.monthsByRef.set(monthKey, month);

      current.invalidNotesCount += Number(summary.invalidNotesCount ?? 0);
      if (!summary.isSubsumed) {
        if (summary.abatementStatus === "applied") {
          current.totalApplied += Number(summary.abatementAmount ?? 0);
        } else {
          current.totalPending += Number(summary.abatementAmount ?? 0);
        }
      }
      donorsById.set(summary.donorId, current);
    }

    return Array.from(donorsById.values())
      .map((donor) => {
        const { monthsByRef, ...rest } = donor;
        const months = Array.from(monthsByRef.values()).sort((left, right) =>
          left.referenceMonth.localeCompare(right.referenceMonth),
        );

        return {
          ...rest,
          months,
          // Os acumulados que este doador tem no recorte exibido. O card usa
          // para oferecer "Deslançar": o lançamento vive em tabela própria, e
          // desfazê-lo é apagar a linha, não mudar status de mês.
          adjustments: months.flatMap((month) => month.adjustments ?? []),
        };
      })
      .sort(
        (left, right) =>
          right.totalPending - left.totalPending ||
          right.totalApplied - left.totalApplied ||
          left.donorName.localeCompare(right.donorName, "pt-BR"),
      );
  }, [donationSummaries]);

  const filteredConsolidatedDonors = useMemo(() => {
    if (abatementStatus === "pending") {
      return consolidatedDonors.filter((donor) => donor.totalPending > 0);
    }

    if (abatementStatus === "applied") {
      return consolidatedDonors.filter((donor) => donor.totalPending === 0);
    }

    return consolidatedDonors;
  }, [abatementStatus, consolidatedDonors]);

  return {
    consolidatedDonors,
    donationSummaries,
    donatedCount: donationSummaries.length,
    filteredConsolidatedDonors,
    notDonatedCount: summaries.length - donationSummaries.length,
    pendingSummaries,
    totalAbatement,
    totalAppliedAbatement,
    totalPendingAbatement,
  };
}
