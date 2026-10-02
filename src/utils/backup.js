export const SNAPSHOT_TABLE_KEYS = [
  // Plataforma multiprojeto: sem estas chaves, todo projeto e todo vínculo
  // desapareceriam a cada hidratação da nuvem.
  "projects",
  "donorProjectAssignments",
  "demands",
  "people",
  "donors",
  "donorCpfLinks",
  "imports",
  "importCpfSummary",
  "monthlyDonorSummary",
  "notes",
  "actionHistory",
  "donorActivityHistory",
  "abatementAdjustments",
  "trashItems",
  // Reconciliation feature (Fases 1–3): per-note storage on the donations
  // side and the full credits domain. Without these keys here the cloud
  // snapshot loses every credit/donation detail on reload — the user's most
  // recent import effectively "disappears".
  "donationNotes",
  "creditImports",
  "creditNotes",
];

/**
 * Chaves que arquivos ANTIGOS trazem e o sistema não grava mais.
 *
 * `creditReconciliation` é dado derivado: sai inteiro das notas de doação e
 * de crédito, e é refeito ao restaurar (`restoreDatabaseSnapshot`). Gravá-lo
 * custava caro — três UUIDs aleatórios por linha, que não comprimem: no
 * banco real era 21% do JSON e 38% do arquivo comprimido, o bastante para
 * encostar no limite de 50 MB por arquivo do armazenamento.
 *
 * A chave fica listada aqui, em vez de simplesmente sumir, para deixar
 * escrito que um arquivo que a contém é válido — só que ela é ignorada.
 * Restaurar as linhas gravadas congelaria a regra de conciliação que valia
 * no dia em que o arquivo foi salvo.
 */
export const DERIVED_SNAPSHOT_KEYS = ["creditReconciliation"];

export function createEmptySnapshot() {
  return {
    projects: [],
    donorProjectAssignments: [],
    demands: [],
    people: [],
    donors: [],
    donorCpfLinks: [],
    imports: [],
    importCpfSummary: [],
    monthlyDonorSummary: [],
    notes: [],
    actionHistory: [],
    donorActivityHistory: [],
    abatementAdjustments: [],
    trashItems: [],
    donationNotes: [],
    creditImports: [],
    creditNotes: [],
  };
}

export function normalizeSnapshotPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate =
    "data" in payload && payload.data && typeof payload.data === "object"
      ? payload.data
      : payload;

  const normalizedSnapshot = createEmptySnapshot();

  for (const key of SNAPSHOT_TABLE_KEYS) {
    const value = candidate[key];

    if (value === undefined) {
      continue;
    }

    if (!Array.isArray(value)) {
      return null;
    }

    normalizedSnapshot[key] = value;
  }

  return normalizedSnapshot;
}

export function snapshotHasData(snapshot) {
  if (!snapshot) {
    return false;
  }

  return SNAPSHOT_TABLE_KEYS.some(
    (key) => Array.isArray(snapshot[key]) && snapshot[key].length > 0,
  );
}

export function buildSnapshotStats(snapshot) {
  const normalizedSnapshot = normalizeSnapshotPayload(snapshot) ?? createEmptySnapshot();

  return SNAPSHOT_TABLE_KEYS.reduce((stats, key) => {
    stats[key] = normalizedSnapshot[key].length;
    return stats;
  }, {});
}

/**
 * Versão do envelope do backup. Exportada porque o snapshot da nuvem monta
 * o mesmo envelope por concatenação de texto, sem passar por aqui — e um
 * número solto nos dois lugares acabaria divergindo.
 */
export const SNAPSHOT_PAYLOAD_VERSION = 1;

export function createSnapshotPayload(snapshot, exportedAt = new Date().toISOString()) {
  const normalizedSnapshot = normalizeSnapshotPayload(snapshot) ?? createEmptySnapshot();

  return {
    version: SNAPSHOT_PAYLOAD_VERSION,
    exportedAt,
    data: normalizedSnapshot,
  };
}
