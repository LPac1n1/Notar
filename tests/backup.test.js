import test from "node:test";
import assert from "node:assert/strict";
import {
  DERIVED_SNAPSHOT_KEYS,
  SNAPSHOT_TABLE_KEYS,
  buildSnapshotStats,
  createSnapshotPayload,
  normalizeSnapshotPayload,
  snapshotHasData,
} from "../src/utils/backup.js";

test("normalizeSnapshotPayload accepts wrapped backup payloads", () => {
  const snapshot = normalizeSnapshotPayload({
    version: 1,
    exportedAt: "2026-04-14T10:00:00.000Z",
    data: {
      demands: [{ id: "1" }],
      people: [],
      donors: [],
      donorCpfLinks: [],
      imports: [],
      importCpfSummary: [],
      monthlyDonorSummary: [],
      notes: [],
      actionHistory: [],
      trashItems: [],
    },
  });

  assert.deepEqual(snapshot.demands, [{ id: "1" }]);
  assert.deepEqual(snapshot.people, []);
  assert.deepEqual(snapshot.donors, []);
});

test("normalizeSnapshotPayload rejects invalid table structures", () => {
  assert.equal(
    normalizeSnapshotPayload({
      data: {
        demands: "invalido",
      },
    }),
    null,
  );
});

test("snapshot helpers detect data and count rows correctly", () => {
  const snapshot = normalizeSnapshotPayload({
    demands: [{ id: "1" }, { id: "2" }],
    donors: [{ id: "3" }],
  });

  assert.equal(snapshotHasData(snapshot), true);
  assert.deepEqual(buildSnapshotStats(snapshot), {
    projects: 0,
    donorProjectAssignments: 0,
    demands: 2,
    people: 0,
    donors: 1,
    donorCpfLinks: 0,
    imports: 0,
    importCpfSummary: 0,
    monthlyDonorSummary: 0,
    notes: 0,
    actionHistory: 0,
    donorActivityHistory: 0,
    abatementAdjustments: 0,
    trashItems: 0,
    donationNotes: 0,
    creditImports: 0,
    creditNotes: 0,
  });
});

test("createSnapshotPayload wraps normalized data", () => {
  const payload = createSnapshotPayload({
    donors: [{ id: "10" }],
  }, "2026-04-14T12:00:00.000Z");

  assert.equal(payload.version, 1);
  assert.equal(payload.exportedAt, "2026-04-14T12:00:00.000Z");
  assert.deepEqual(payload.data.donors, [{ id: "10" }]);
  assert.deepEqual(payload.data.demands, []);
  assert.deepEqual(payload.data.people, []);
  assert.deepEqual(payload.data.notes, []);
  assert.deepEqual(payload.data.actionHistory, []);
  assert.deepEqual(payload.data.trashItems, []);
});

// A conciliação é DERIVADA das notas de doação e de crédito. Ela saiu do
// snapshot (era 38% do arquivo comprimido no banco real) e é refeita ao
// restaurar. Os arquivos gravados antes disso continuam trazendo a tabela.
test("a conciliação não é uma tabela do snapshot", () => {
  assert.equal(SNAPSHOT_TABLE_KEYS.includes("creditReconciliation"), false);
  assert.deepEqual(DERIVED_SNAPSHOT_KEYS, ["creditReconciliation"]);
});

test("arquivo antigo, com a conciliação gravada, continua sendo aceito", () => {
  const snapshot = normalizeSnapshotPayload({
    version: 1,
    data: {
      donationNotes: [{ id: "d1" }],
      creditNotes: [{ id: "c1" }],
      creditReconciliation: [{ id: "r1", match_status: "matched" }],
    },
  });

  assert.notEqual(snapshot, null);
  assert.deepEqual(snapshot.donationNotes, [{ id: "d1" }]);
  // Ignorada de propósito: restaurar as linhas gravadas congelaria a regra
  // de conciliação que valia quando o arquivo foi salvo.
  assert.equal("creditReconciliation" in snapshot, false);
});

test("só a conciliação no arquivo não conta como dado", () => {
  const snapshot = normalizeSnapshotPayload({
    creditReconciliation: [{ id: "r1" }],
  });

  assert.equal(snapshotHasData(snapshot), false);
});
