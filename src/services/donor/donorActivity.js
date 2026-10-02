import { nanoid } from "nanoid";
import {
  executePrepared,
  queryPrepared,
  runInTransaction,
} from "../db";
import { createActionHistoryEntry } from "../actionHistoryService";
import { reconcileImportsForCpfs } from "../importService";

/**
 * Activity tracking for the donors domain — all the activate/deactivate
 * choreography that writes to `donor_activity_history` and toggles
 * `donors.is_active`. Kept separate from CRUD writes (donorWriter.js) and
 * pure reads (donorProfile.js) so the domain rules around chronology stay
 * isolated and unit-testable.
 *
 * Desativar NÃO apaga nada: tira o doador da apuração, e isso é decidido na
 * leitura (`summaryDonorIsActive`). O resumo mensal dele — com o status de
 * abatimento de cada mês — fica guardado, e é por isso que reativar o traz de
 * volta exatamente como estava.
 */

async function listDonorCpfs(donorId) {
  const rows = await queryPrepared(
    `
    SELECT cpf
    FROM donor_cpf_links
    WHERE donor_id = ?
      AND is_active = TRUE
  `,
    [donorId],
  );

  return rows.map((row) => row.cpf).filter(Boolean);
}

function normalizeMonthValue(value) {
  if (!value) {
    return null;
  }

  const text = String(value).slice(0, 7);
  return /^\d{4}-\d{2}$/.test(text) ? `${text}-01` : null;
}

function formatMonthLabel(monthIso) {
  if (!monthIso || !/^\d{4}-\d{2}/.test(monthIso)) {
    return monthIso ?? "";
  }

  const [year, month] = monthIso.slice(0, 7).split("-");
  return `${month}/${year}`;
}

async function getDonorActivityContext(donorId) {
  const donorRows = await queryPrepared(
    `
    SELECT
      id,
      name,
      is_active,
      strftime(donation_start_date, '%Y-%m-01') AS donation_start_date
    FROM donors
    WHERE id = ?
    LIMIT 1
  `,
    [donorId],
  );

  if (donorRows.length === 0) {
    throw new Error("Doador não encontrado.");
  }

  const activityRows = await queryPrepared(
    `
    SELECT
      event_type,
      strftime(reference_month, '%Y-%m-01') AS reference_month
    FROM donor_activity_history
    WHERE donor_id = ?
    ORDER BY reference_month DESC, created_at DESC
  `,
    [donorId],
  );

  return {
    donor: donorRows[0],
    activityHistory: activityRows,
    latestEvent: activityRows[0] ?? null,
  };
}

export async function deactivateDonor(donorId, referenceMonth) {
  const normalizedMonth = normalizeMonthValue(referenceMonth);

  if (!normalizedMonth) {
    throw new Error("Informe um mês válido para a desativação.");
  }

  const { donor, latestEvent } = await getDonorActivityContext(donorId);

  if (!donor.is_active) {
    throw new Error("O doador já está inativo.");
  }

  if (donor.donation_start_date && normalizedMonth < donor.donation_start_date) {
    throw new Error(
      `A desativação não pode ser anterior ao início das doações (${formatMonthLabel(donor.donation_start_date)}).`,
    );
  }

  if (latestEvent && normalizedMonth <= latestEvent.reference_month) {
    const eventLabel =
      latestEvent.event_type === "activated" ? "reativação" : "desativação";
    throw new Error(
      `A desativação precisa ser posterior à última ${eventLabel} registrada (${formatMonthLabel(latestEvent.reference_month)}).`,
    );
  }

  await runInTransaction(async () => {
    await executePrepared(
      `
      UPDATE donors
      SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
      [donorId],
    );

    await executePrepared(
      `
      INSERT INTO donor_activity_history (id, donor_id, event_type, reference_month, created_at)
      VALUES (?, ?, 'deactivated', ?, CURRENT_TIMESTAMP)
    `,
      [nanoid(), donorId, normalizedMonth],
    );
  });

  await createActionHistoryEntry({
    actionType: "update",
    entityType: "donor",
    entityId: donorId,
    label: donor.name,
    description: `Doador ${donor.name} desativado a partir de ${formatMonthLabel(normalizedMonth)}.`,
    payload: { referenceMonth: normalizedMonth.slice(0, 7) },
  });
}

export async function reactivateDonor(donorId, referenceMonth) {
  const normalizedMonth = normalizeMonthValue(referenceMonth);

  if (!normalizedMonth) {
    throw new Error("Informe um mês válido para a reativação.");
  }

  const { donor, latestEvent } = await getDonorActivityContext(donorId);

  if (donor.is_active) {
    throw new Error("O doador já está ativo.");
  }

  if (donor.donation_start_date && normalizedMonth < donor.donation_start_date) {
    throw new Error(
      `A reativação não pode ser anterior ao início das doações (${formatMonthLabel(donor.donation_start_date)}).`,
    );
  }

  if (latestEvent && normalizedMonth <= latestEvent.reference_month) {
    const eventLabel =
      latestEvent.event_type === "deactivated" ? "desativação" : "reativação";
    throw new Error(
      `A reativação precisa ser posterior à última ${eventLabel} registrada (${formatMonthLabel(latestEvent.reference_month)}).`,
    );
  }

  await runInTransaction(async () => {
    await executePrepared(
      `
      UPDATE donors
      SET is_active = TRUE, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
      [donorId],
    );

    await executePrepared(
      `
      INSERT INTO donor_activity_history (id, donor_id, event_type, reference_month, created_at)
      VALUES (?, ?, 'activated', ?, CURRENT_TIMESTAMP)
    `,
      [nanoid(), donorId, normalizedMonth],
    );
  });

  await createActionHistoryEntry({
    actionType: "update",
    entityType: "donor",
    entityId: donorId,
    label: donor.name,
    description: `Doador ${donor.name} reativado a partir de ${formatMonthLabel(normalizedMonth)}.`,
    payload: { referenceMonth: normalizedMonth.slice(0, 7) },
  });

  // Refaz o resumo das importações em que os CPFs do doador aparecem. Hoje o
  // resumo de um doador inativo é preservado, mas nem sempre foi: até esta
  // regra existir, reconciliar uma importação apagava as linhas de quem
  // estava inativo. Sem isto, um doador desativado naquela época voltaria a
  // ser ativo sem os meses que tinham sumido. As linhas que já existem
  // mantêm o status; as recriadas nascem pendentes.
  await reconcileImportsForCpfs(await listDonorCpfs(donorId));
}

export async function getDonorActivityConstraints(donorId) {
  const { donor, latestEvent } = await getDonorActivityContext(donorId);
  const startDate = donor.donation_start_date
    ? String(donor.donation_start_date).slice(0, 7)
    : "";
  const latestEventMonth = latestEvent
    ? String(latestEvent.reference_month).slice(0, 7)
    : "";

  return {
    donationStartMonth: startDate,
    latestEventMonth,
    latestEventType: latestEvent?.event_type ?? "",
    isActive: Boolean(donor.is_active),
  };
}
