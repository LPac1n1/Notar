import { nanoid } from "nanoid";
import {
  executePrepared,
  normalizeCpf,
  notifyDatabaseChanged,
  queryPrepared,
  runInTransaction,
} from "../db";
import { RECONCILE_MATCHED_DONORS_SQL } from "./reconcileSql.js";

/**
 * Reconciliation flows tying imports to donors. Three entry points share the
 * same per-import worker (`reconcileImport`):
 *
 *   - `reconcileImport` — recomputes `import_cpf_summary.matched_*` and
 *     rebuilds `monthly_donor_summary` for a single import.
 *   - `reconcileAllImports` — settings-page action that re-runs every import.
 *   - `reconcileImportsForCpfs` — narrow re-reconcile triggered after donor
 *     create/update/delete so the affected CPFs flow into the right summary
 *     rows without re-running every historical import.
 */

export async function reconcileImport(importId, { emitChange = true } = {}) {
  const importRows = await queryPrepared(
    `
    SELECT
      id,
      strftime(reference_month, '%Y-%m-01') AS reference_month,
      value_per_note
    FROM imports
    WHERE id = ?
    LIMIT 1
  `,
    [importId],
  );

  if (importRows.length === 0) {
    return;
  }

  const importValuePerNote = Number(importRows[0].value_per_note ?? 0);

  await runInTransaction(
    async () => {
      const existingSummaries = await queryPrepared(
        `
        SELECT
          donor_id,
          abatement_status,
          strftime(abatement_marked_at, '%Y-%m-%d %H:%M:%S') AS abatement_marked_at
        FROM monthly_donor_summary
        WHERE import_id = ?
      `,
        [importId],
      );

      const summaryStatusByDonorId = new Map(
        existingSummaries.map((row) => [
          row.donor_id,
          {
            abatementStatus: row.abatement_status ?? "pending",
            abatementMarkedAt: row.abatement_marked_at ?? "",
          },
        ]),
      );

      await executePrepared(
        `
        UPDATE import_cpf_summary
        SET
          matched_source_id = (
            SELECT donor_cpf_links.id
            FROM donor_cpf_links
            WHERE donor_cpf_links.cpf = import_cpf_summary.cpf
              AND donor_cpf_links.is_active = TRUE
            LIMIT 1
          ),
          matched_donor_id = (
            SELECT donor_cpf_links.donor_id
            FROM donor_cpf_links
            WHERE donor_cpf_links.cpf = import_cpf_summary.cpf
              AND donor_cpf_links.is_active = TRUE
            LIMIT 1
          ),
          is_registered_donor = EXISTS (
            SELECT 1
            FROM donor_cpf_links
            WHERE donor_cpf_links.cpf = import_cpf_summary.cpf
              AND donor_cpf_links.is_active = TRUE
          ),
          updated_at = CURRENT_TIMESTAMP
        WHERE import_id = ?
      `,
        [importId],
      );

      await executePrepared(
        `
        DELETE FROM monthly_donor_summary
        WHERE import_id = ?
      `,
        [importId],
      );

      const matchedRows = await queryPrepared(RECONCILE_MATCHED_DONORS_SQL, [
        importId,
      ]);

      if (matchedRows.length > 0) {
        // Bulk insert in chunks to avoid running 1k+ statements one-by-one
        // through DuckDB-WASM's single-threaded executor. The chunk size keeps
        // each SQL string under a comfortable limit even for the largest
        // historical imports we have observed.
        const BULK_INSERT_CHUNK_SIZE = 200;
        const ROW_PLACEHOLDER = "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)";
        const buildRowValues = (row) => {
          const notesCount = Number(row.notes_count ?? 0);
          const invalidNotesCount = Number(row.invalid_notes_count ?? 0);
          const valuePerNote = importValuePerNote;
          const abatementAmount = notesCount * valuePerNote;
          const existingSummary = summaryStatusByDonorId.get(row.donor_id);
          const abatementStatus = existingSummary?.abatementStatus ?? "pending";
          const abatementMarkedAt = existingSummary?.abatementMarkedAt ?? "";

          return [
            nanoid(),
            row.import_id,
            row.donor_id,
            row.reference_month,
            row.donor_cpf,
            row.donor_name,
            row.demand ?? "",
            notesCount,
            invalidNotesCount,
            valuePerNote,
            abatementAmount,
            abatementStatus,
            abatementMarkedAt || null,
          ];
        };

        for (
          let chunkStart = 0;
          chunkStart < matchedRows.length;
          chunkStart += BULK_INSERT_CHUNK_SIZE
        ) {
          const chunk = matchedRows.slice(
            chunkStart,
            chunkStart + BULK_INSERT_CHUNK_SIZE,
          );
          const valuesSql = chunk.map(() => ROW_PLACEHOLDER).join(",\n");
          const params = chunk.flatMap(buildRowValues);

          await executePrepared(
            `
            INSERT INTO monthly_donor_summary (
              id,
              import_id,
              donor_id,
              reference_month,
              cpf,
              donor_name,
              demand,
              notes_count,
              invalid_notes_count,
              value_per_note,
              abatement_amount,
              abatement_status,
              abatement_marked_at,
              updated_at
            )
            VALUES ${valuesSql}
          `,
            params,
          );
        }
      }

      await executePrepared(
        `
        UPDATE imports
        SET
          matched_rows = coalesce((
            SELECT sum(notes_count)
            FROM import_cpf_summary
            WHERE import_id = ?
              AND is_registered_donor = TRUE
          ), 0),
          matched_donors = coalesce((
            SELECT count(DISTINCT matched_donor_id)
            FROM import_cpf_summary
            WHERE import_id = ?
              AND is_registered_donor = TRUE
              AND matched_donor_id IS NOT NULL
          ), 0),
          status = 'processed',
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
        [importId, importId, importId],
      );
    },
    { emitChange, changeSource: "reconcile-import" },
  );
}

export async function reconcileAllImports({ emitChange = true } = {}) {
  const imports = await queryPrepared(`
    SELECT id
    FROM imports
    ORDER BY reference_month ASC, imported_at ASC
  `);

  for (const importRow of imports) {
    await reconcileImport(importRow.id, { emitChange: false });
  }

  if (emitChange && imports.length > 0) {
    notifyDatabaseChanged({ source: "reconcile-all-imports" });
  }
}

export async function reconcileImportsForCpfs(cpfs = []) {
  const normalizedCpfs = Array.from(
    new Set(
      cpfs
        .map((cpf) => normalizeCpf(cpf))
        .filter((cpf) => cpf.length === 11),
    ),
  );

  if (normalizedCpfs.length === 0) {
    return;
  }

  const cpfPlaceholders = normalizedCpfs.map(() => "?").join(", ");
  const imports = await queryPrepared(
    `
    SELECT DISTINCT import_id AS id
    FROM import_cpf_summary
    WHERE cpf IN (${cpfPlaceholders})
    ORDER BY import_id ASC
  `,
    normalizedCpfs,
  );

  for (const importRow of imports) {
    await reconcileImport(importRow.id, { emitChange: false });
  }

  if (imports.length > 0) {
    notifyDatabaseChanged({ source: "cpf-reconcile" });
  }
}
