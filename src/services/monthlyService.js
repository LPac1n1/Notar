import { listMonthlySummariesByMonth } from "./monthly/listByMonth";
import { listHistoricalMonthlySummaries } from "./monthly/listHistorical";

/**
 * Barrel re-exporter for the monthly summaries domain. Phase 6 split the
 * 939-line `monthlyService.js` into four cohesive modules:
 *
 *   - `monthly/sharedFragments.js`   — SQL constants + row mappers + filters
 *   - `monthly/listByMonth.js`       — by-month listing (synthesizes "no
 *                                       donation" rows for active donors)
 *   - `monthly/listHistorical.js`    — long-form listing across all months
 *   - `monthly/abatementUpdates.js`  — single + bulk status mutations
 *
 * Existing callers continue to import from `services/monthlyService` and
 * don't need to know about the internal layout.
 */

export {
  updateAbatementStatus,
  updateAbatementStatusWithHistory,
  updateAbatementStatuses,
  updateAbatementStatusesWithHistory,
} from "./monthly/abatementUpdates";

/**
 * Top-level dispatcher. Picks the by-month variant when UM mês é escolhido
 * (a UX da página) e a variante histórica nos outros dois casos: nenhum mês
 * (visão consolidada de sempre) e VÁRIOS meses, que é a mesma visão
 * consolidada recortada pelo conjunto escolhido.
 *
 * Optional `limit`/`offset` apply AFTER the post-processing pass (filters,
 * adjustment merge, sort) because the merge synthesizes rows for active
 * donors that don't appear in `monthly_donor_summary`; pushing LIMIT into SQL
 * would skip those. Default = no pagination, matching the historical contract.
 */
export async function listMonthlySummaries({
  referenceMonth = "",
  referenceMonths = [],
  donorId = "",
  donorType = "all",
  cpf = "",
  demand = "",
  abatementStatus = "all",
  donationActivity = "all",
  abatementSort = "",
  donationStartDate = "all",
  donorActiveStatus = "active",
  search = "",
  limit,
  offset = 0,
} = {}) {
  // Este dispatcher repassa uma lista EXPLÍCITA de filtros — o que não estiver
  // aqui é descartado em silêncio antes de chegar na query. Ao adicionar um
  // filtro novo, inclua-o nos dois ramos.
  const monthList = (referenceMonths ?? []).filter(Boolean);
  const rows = referenceMonth && monthList.length <= 1
    ? await listMonthlySummariesByMonth({
        referenceMonth,
        donorId,
        donorType,
        cpf,
        demand,
        abatementStatus,
        donationActivity,
        abatementSort,
        donationStartDate,
        donorActiveStatus,
        search,
      })
    : await listHistoricalMonthlySummaries({
        referenceMonth,
        referenceMonths: monthList,
        donorId,
        donorType,
        cpf,
        demand,
        abatementStatus,
        donationActivity,
        abatementSort,
        donationStartDate,
        donorActiveStatus,
        search,
      });

  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) {
    return rows;
  }

  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  return rows.slice(safeOffset, safeOffset + safeLimit);
}

