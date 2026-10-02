import { normalizeCpfSqlExpression } from "./sql.js";
import {
  BACKFILL_ASSIGNMENTS_SQL,
  BACKFILL_DEMAND_PROJECT_SQL,
  BACKFILL_NOTE_PROJECT_SQL,
  BACKFILL_PERSON_PROJECT_SQL,
  BACKFILL_PROJECT_ORDER_SQL,
  ENSURE_DEFAULT_PROJECT_SQL,
} from "../project/projectAssignmentSql.js";
import { DEFAULT_DEMAND_COLOR } from "../../utils/demandColor.js";
import { INSERT_MISSING_MONTHLY_SUMMARIES_SQL } from "../import/reconcileSql.js";
import { runMigrations } from "./migrations.js";

/**
 * Data normalizations that run on every bootstrap (and after every restore from
 * backup). They are idempotent and exist to fix legacy data shapes.
 */
async function applyDataNormalizations(conn) {
  await conn.query(`
    INSERT INTO demands (id, name, is_active, created_at, updated_at)
    SELECT
      lower(replace(trim(demand), ' ', '-')),
      trim(demand),
      TRUE,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM donors
    WHERE demand IS NOT NULL
      AND trim(demand) <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM demands
        WHERE lower(trim(demands.name)) = lower(trim(donors.demand))
      )
    GROUP BY trim(demand)
  `);

  const recordsNeedingCpfNormalizationRows = await conn.query(`
    SELECT
      (
        SELECT count(*)
        FROM donors
        WHERE cpf IS NOT NULL
          AND cpf <> ${normalizeCpfSqlExpression("cpf")}
      ) +
      (
        SELECT count(*)
        FROM donor_cpf_links
        WHERE cpf IS NOT NULL
          AND cpf <> ${normalizeCpfSqlExpression("cpf")}
      ) AS total
  `);
  const shouldRebuildSummariesAfterCpfNormalization =
    Number(recordsNeedingCpfNormalizationRows.toArray()[0]?.total ?? 0) > 0;

  await conn.query(`
    UPDATE demands
    SET
      color = coalesce(nullif(trim(color), ''), '${DEFAULT_DEMAND_COLOR}'),
      updated_at = coalesce(updated_at, CURRENT_TIMESTAMP)
  `);

  await conn.query(`
    UPDATE people
    SET
      name = upper(trim(name)),
      cpf = ${normalizeCpfSqlExpression("cpf")},
      is_active = coalesce(is_active, TRUE),
      updated_at = coalesce(updated_at, CURRENT_TIMESTAMP)
  `);

  await conn.query(`
    UPDATE donors
    SET
      name = upper(trim(name)),
      cpf = ${normalizeCpfSqlExpression("cpf")},
      donor_type = coalesce(nullif(trim(donor_type), ''), 'holder'),
      is_active = coalesce(is_active, TRUE),
      updated_at = coalesce(updated_at, CURRENT_TIMESTAMP)
  `);

  await conn.query(`
    UPDATE donor_cpf_links
    SET
      name = upper(trim(name)),
      cpf = ${normalizeCpfSqlExpression("cpf")},
      link_type = CASE
        WHEN lower(trim(coalesce(link_type, ''))) IN ('holder', 'titular') THEN 'holder'
        WHEN lower(trim(coalesce(link_type, ''))) IN ('auxiliary', 'auxiliar') THEN 'auxiliary'
        ELSE coalesce(nullif(lower(trim(link_type)), ''), 'auxiliary')
      END,
      is_active = coalesce(is_active, TRUE),
      updated_at = coalesce(updated_at, CURRENT_TIMESTAMP)
  `);

  const legacyAuxiliaryLinkRows = await conn.query(`
    SELECT count(*) AS total
    FROM donor_cpf_links
    INNER JOIN donors
      ON donors.id = donor_cpf_links.donor_id
    WHERE donor_cpf_links.link_type = 'auxiliary'
      AND donors.donor_type = 'holder'
      AND donor_cpf_links.cpf IS NOT NULL
      AND trim(donor_cpf_links.cpf) <> ''
  `);
  const shouldRebuildSummariesAfterAuxiliaryMigration =
    Number(legacyAuxiliaryLinkRows.toArray()[0]?.total ?? 0) > 0;
  const shouldRebuildMonthlySummaries =
    shouldRebuildSummariesAfterAuxiliaryMigration ||
    shouldRebuildSummariesAfterCpfNormalization;

  await conn.query(`
    INSERT INTO donors (
      id,
      name,
      cpf,
      demand,
      donor_type,
      holder_donor_id,
      donation_start_date,
      is_active,
      created_at,
      updated_at
    )
    SELECT
      donor_cpf_links.id || '-donor',
      upper(trim(donor_cpf_links.name)),
      donor_cpf_links.cpf,
      donors.demand,
      'auxiliary',
      donor_cpf_links.donor_id,
      donor_cpf_links.donation_start_date,
      coalesce(donor_cpf_links.is_active, TRUE),
      coalesce(donor_cpf_links.created_at, CURRENT_TIMESTAMP),
      CURRENT_TIMESTAMP
    FROM donor_cpf_links
    INNER JOIN donors
      ON donors.id = donor_cpf_links.donor_id
    WHERE donor_cpf_links.link_type = 'auxiliary'
      AND donors.donor_type = 'holder'
      AND donor_cpf_links.cpf IS NOT NULL
      AND trim(donor_cpf_links.cpf) <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM donors AS existing_donors
        WHERE existing_donors.cpf = donor_cpf_links.cpf
      )
  `);

  await conn.query(`
    UPDATE donor_cpf_links
    SET
      donor_id = (
        SELECT migrated_donors.id
        FROM donors AS migrated_donors
        WHERE migrated_donors.cpf = donor_cpf_links.cpf
          AND migrated_donors.id <> donor_cpf_links.donor_id
        ORDER BY
          CASE WHEN migrated_donors.donor_type = 'auxiliary' THEN 0 ELSE 1 END,
          migrated_donors.created_at ASC
        LIMIT 1
      ),
      link_type = 'holder',
      updated_at = CURRENT_TIMESTAMP
    WHERE link_type = 'auxiliary'
      AND EXISTS (
        SELECT 1
        FROM donors AS migrated_donors
        WHERE migrated_donors.cpf = donor_cpf_links.cpf
          AND migrated_donors.id <> donor_cpf_links.donor_id
      )
  `);

  await conn.query(`
    INSERT INTO donor_cpf_links (
      id,
      donor_id,
      name,
      cpf,
      donation_start_date,
      link_type,
      is_active,
      created_at,
      updated_at
    )
    SELECT
      donors.id || '-titular',
      donors.id,
      donors.name,
      donors.cpf,
      donors.donation_start_date,
      'holder',
      coalesce(donors.is_active, TRUE),
      coalesce(donors.created_at, CURRENT_TIMESTAMP),
      CURRENT_TIMESTAMP
    FROM donors
    WHERE donors.cpf IS NOT NULL
      AND trim(donors.cpf) <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM donor_cpf_links
        WHERE donor_cpf_links.cpf = donors.cpf
      )
      AND NOT EXISTS (
        SELECT 1
        FROM donor_cpf_links
        WHERE donor_cpf_links.donor_id = donors.id
          AND donor_cpf_links.link_type = 'holder'
      )
  `);

  await conn.query(`
    INSERT INTO people (
      id,
      name,
      cpf,
      is_active,
      created_at,
      updated_at
    )
    SELECT
      donors.id || '-person',
      donors.name,
      donors.cpf,
      coalesce(donors.is_active, TRUE),
      coalesce(donors.created_at, CURRENT_TIMESTAMP),
      CURRENT_TIMESTAMP
    FROM donors
    WHERE donors.cpf IS NOT NULL
      AND trim(donors.cpf) <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM people
        WHERE people.cpf = donors.cpf
      )
  `);

  await conn.query(`
    UPDATE donors
    SET
      person_id = (
        SELECT people.id
        FROM people
        WHERE people.cpf = donors.cpf
        ORDER BY people.created_at ASC, people.id ASC
        LIMIT 1
      ),
      updated_at = CURRENT_TIMESTAMP
    WHERE coalesce(trim(person_id), '') = ''
      AND donors.cpf IS NOT NULL
      AND trim(donors.cpf) <> ''
  `);

  await conn.query(`
    UPDATE donors
    SET
      name = coalesce((
        SELECT people.name
        FROM people
        WHERE people.id = donors.person_id
        LIMIT 1
      ), donors.name),
      cpf = coalesce((
        SELECT people.cpf
        FROM people
        WHERE people.id = donors.person_id
        LIMIT 1
      ), donors.cpf),
      updated_at = CURRENT_TIMESTAMP
    WHERE coalesce(trim(person_id), '') <> ''
  `);

  await conn.query(`
    UPDATE donors
    SET
      holder_person_id = (
        SELECT holder_donors.person_id
        FROM donors AS holder_donors
        WHERE holder_donors.id = donors.holder_donor_id
        LIMIT 1
      ),
      updated_at = CURRENT_TIMESTAMP
    WHERE donor_type = 'auxiliary'
      AND coalesce(trim(holder_person_id), '') = ''
      AND coalesce(trim(holder_donor_id), '') <> ''
  `);

  await conn.query(`
    UPDATE donors
    SET
      holder_donor_id = (
        SELECT holder_donors.id
        FROM donors AS holder_donors
        WHERE holder_donors.person_id = donors.holder_person_id
          AND holder_donors.donor_type = 'holder'
          AND holder_donors.is_active = TRUE
        ORDER BY holder_donors.created_at ASC, holder_donors.id ASC
        LIMIT 1
      ),
      updated_at = CURRENT_TIMESTAMP
    WHERE donor_type = 'auxiliary'
      AND coalesce(trim(holder_person_id), '') <> ''
  `);

  await conn.query(`
    UPDATE imports
    SET
      value_per_note = coalesce((
        SELECT max(monthly_donor_summary.value_per_note)
        FROM monthly_donor_summary
        WHERE monthly_donor_summary.import_id = imports.id
      ), value_per_note, 0),
      updated_at = coalesce(updated_at, CURRENT_TIMESTAMP)
  `);

  // Legacy `import_items` was renamed to `import_cpf_summary` long ago. Some
  // very old databases still carry the original table; new installs don't.
  // Check before running the migration insert so DuckDB-WASM doesn't log a
  // Catalog Error on every boot of a fresh DB (the surrounding `.catch` only
  // swallows the JS rejection, not the engine-level log).
  const legacyImportItemsRows = (
    await conn.query(`
      SELECT count(*) AS total
      FROM information_schema.tables
      WHERE table_name = 'import_items'
    `)
  ).toArray();
  const hasLegacyImportItems = Number(legacyImportItemsRows[0]?.total ?? 0) > 0;

  if (hasLegacyImportItems) {
    await conn.query(`
      INSERT INTO import_cpf_summary (
        id,
        import_id,
        reference_month,
        cpf,
        notes_count,
        is_registered_donor,
        created_at,
        updated_at
      )
      SELECT
        import_items.id,
        import_items.import_id,
        imports.reference_month,
        import_items.cpf,
        import_items.notes_count,
        FALSE,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      FROM import_items
      INNER JOIN imports
        ON imports.id = import_items.import_id
      WHERE NOT EXISTS (
        SELECT 1
        FROM import_cpf_summary
        WHERE import_cpf_summary.id = import_items.id
      )
    `).catch(() => null);
  }

  await conn.query(`
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
  `);

  if (shouldRebuildMonthlySummaries) {
    await conn.query(`
      CREATE TEMP TABLE notar_monthly_status_backup AS
      SELECT
        import_id,
        donor_id,
        abatement_status,
        abatement_marked_at
      FROM monthly_donor_summary
    `);

    await conn.query(`
      DELETE FROM monthly_donor_summary
    `);

    await conn.query(`
      INSERT INTO monthly_donor_summary (
        id,
        import_id,
        donor_id,
        reference_month,
        cpf,
        donor_name,
        demand,
        notes_count,
        value_per_note,
        abatement_amount,
        abatement_status,
        abatement_marked_at,
        created_at,
        updated_at
      )
      SELECT
        import_cpf_summary.import_id || '-' || donors.id,
        import_cpf_summary.import_id,
        donors.id,
        import_cpf_summary.reference_month,
        donors.cpf,
        donors.name,
        donors.demand,
        sum(import_cpf_summary.notes_count),
        imports.value_per_note,
        sum(import_cpf_summary.notes_count) * imports.value_per_note,
        coalesce(notar_monthly_status_backup.abatement_status, 'pending'),
        notar_monthly_status_backup.abatement_marked_at,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      FROM import_cpf_summary
      INNER JOIN donor_cpf_links
        ON donor_cpf_links.id = import_cpf_summary.matched_source_id
      INNER JOIN donors
        ON donors.id = donor_cpf_links.donor_id
      INNER JOIN imports
        ON imports.id = import_cpf_summary.import_id
      LEFT JOIN notar_monthly_status_backup
        ON notar_monthly_status_backup.import_id = import_cpf_summary.import_id
        AND notar_monthly_status_backup.donor_id = donors.id
      WHERE imports.status = 'processed'
        AND donor_cpf_links.is_active = TRUE
      GROUP BY
        import_cpf_summary.import_id,
        import_cpf_summary.reference_month,
        imports.value_per_note,
        donors.id,
        donors.cpf,
        donors.name,
        donors.demand,
        notar_monthly_status_backup.abatement_status,
        notar_monthly_status_backup.abatement_marked_at
    `);

    await conn.query(`
      UPDATE imports
      SET
        matched_rows = coalesce((
          SELECT sum(notes_count)
          FROM import_cpf_summary
          WHERE import_id = imports.id
            AND is_registered_donor = TRUE
        ), 0),
        matched_donors = coalesce((
          SELECT count(DISTINCT matched_donor_id)
          FROM import_cpf_summary
          WHERE import_id = imports.id
            AND is_registered_donor = TRUE
            AND matched_donor_id IS NOT NULL
        ), 0),
        updated_at = CURRENT_TIMESTAMP
      WHERE status = 'processed'
    `);

    await conn.query(`
      DROP TABLE IF EXISTS notar_monthly_status_backup
    `).catch(() => null);
  }

  // Resumo mensal que falta (ver o comentário da consulta). Vem depois do
  // UPDATE de `matched_source_id` acima, do qual depende.
  await conn.query(INSERT_MISSING_MONTHLY_SUMMARIES_SQL);

  // Idempotent backfill of the v9 reconciliation key columns. Migration v9
  // populated `match_key` / `valor_cents` for the rows that existed at the
  // time it ran, but imports done before the parser was taught to write
  // those columns at INSERT time leave them NULL. Re-running here on every
  // boot mops up any row whose key is missing without forcing a re-import.
  // Cheap because the WHERE clause hits the column directly.
  // Fallback also uses `ltrim('0')` on numero_nota so the rebuilt match_key
  // matches whatever migration v10 produced for older rows. Keeps insert,
  // backfill and fallback in lockstep.
  await conn.query(`
    UPDATE donation_notes
    SET
      match_key = coalesce(cnpj_estabelecimento, '') || '|' || ltrim(coalesce(numero_nota, ''), '0'),
      valor_cents = cast(round(coalesce(valor_nota, 0) * 100) AS BIGINT)
    WHERE match_key IS NULL
       OR match_key = ''
       OR valor_cents IS NULL
  `).catch(() => null);

  await conn.query(`
    UPDATE credit_notes
    SET
      match_key = coalesce(cnpj_estabelecimento, '') || '|' || ltrim(coalesce(numero_nota, ''), '0'),
      valor_cents = cast(round(coalesce(valor_nf, 0) * 100) AS BIGINT)
    WHERE match_key IS NULL
       OR match_key = ''
       OR valor_cents IS NULL
  `).catch(() => null);
}

export async function runSchemaBootstrap(conn, { structural = true } = {}) {
  // Propagates the applied-ids list out to the caller so post-migration side
  // effects (e.g., rebuilding `credit_reconciliation` after v10 changed every
  // match_key) can run exactly once per device.
  let migrationResult = { appliedIds: [] };
  if (structural) {
    migrationResult = (await runMigrations(conn)) ?? { appliedIds: [] };
  }

  await applyDataNormalizations(conn);

  // Invariante da plataforma: existe um projeto padrão, toda demanda pertence
  // a um projeto e todo doador tem vínculo.
  //
  // Roda DEPOIS das normalizações de propósito. Elas podem CRIAR doadores —
  // é o caso da conversão do modelo antigo de auxiliares, que os promove de
  // `donor_cpf_links` para `donors`. Um doador criado ali sem passar por aqui
  // ficaria sem vínculo e sumiria da lista do projeto, que é exatamente o que
  // acontecia ao restaurar um backup do modelo antigo.
  //
  // Como `runSchemaBootstrap` também roda no reload estrutural pós-restore,
  // este é o único lugar que cobre todos os caminhos: boot, migration e
  // restauração de backup.
  await conn.query(ENSURE_DEFAULT_PROJECT_SQL);
  await conn.query(BACKFILL_DEMAND_PROJECT_SQL);
  await conn.query(BACKFILL_NOTE_PROJECT_SQL);
  await conn.query(BACKFILL_PERSON_PROJECT_SQL);
  await conn.query(BACKFILL_PROJECT_ORDER_SQL);
  await conn.query(BACKFILL_ASSIGNMENTS_SQL);

  return migrationResult;
}

