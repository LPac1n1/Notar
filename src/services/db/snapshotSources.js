/**
 * SQL do snapshot, isolado de qualquer import de banco.
 *
 * Mora à parte para o teste de integração rodar exatamente estas consultas
 * contra o DuckDB — mesmo padrão de `inactivityStreaksSql.js`. Um teste que
 * reescrevesse o SQL provaria só que a cópia dele funciona.
 *
 * Node ESM não resolve import sem extensão, ao contrário do Vite: os arquivos
 * deste tipo usam `.js` explícito em quem os importa.
 */

/**
 * As 17 tabelas do snapshot, cada uma com o SELECT que a materializa.
 *
 * `credit_reconciliation` NÃO está aqui de propósito: é derivada das notas
 * e refeita ao restaurar — ver `DERIVED_SNAPSHOT_KEYS` em `utils/backup.js`.
 *
 * É uma tabela de dados, e não 18 blocos soltos dentro da função, porque a
 * lista precisa ser percorrida — o snapshot é montado tabela a tabela — e
 * porque o teste de integração exercita cada SELECT individualmente para
 * apontar QUAL deles quebrou quando uma coluna muda de nome.
 *
 * Toda data sai como VARCHAR por CAST: JSON não tem tipo de data, e deixar
 * o serializador escolher o formato faria o valor voltar diferente do que
 * entrou.
 */
export const SNAPSHOT_SOURCES = [
  {
    key: "projects",
    sql: `
    SELECT
      id,
      display_order,
      name,
      slug,
      modules,
      color,
      is_active,
      CAST(created_at AS VARCHAR) AS created_at,
      CAST(updated_at AS VARCHAR) AS updated_at
    FROM projects
    ORDER BY name ASC, id ASC
  `,
  },
  {
    key: "donorProjectAssignments",
    sql: `
    SELECT
      id,
      donor_id,
      project_id,
      CAST(valid_from AS VARCHAR) AS valid_from,
      CAST(valid_to AS VARCHAR) AS valid_to,
      reason,
      CAST(created_at AS VARCHAR) AS created_at
    FROM donor_project_assignments
    ORDER BY donor_id ASC, valid_from ASC
  `,
  },
  {
    key: "demands",
    sql: `
    SELECT
      id,
      project_id,
      name,
      color,
      is_active,
      CAST(created_at AS VARCHAR) AS created_at,
      CAST(updated_at AS VARCHAR) AS updated_at
    FROM demands
    ORDER BY name ASC, id ASC
  `,
  },
  {
    key: "people",
    sql: `
    SELECT
      id,
      project_id,
      name,
      cpf,
      is_active,
      CAST(created_at AS VARCHAR) AS created_at,
      CAST(updated_at AS VARCHAR) AS updated_at
    FROM people
    ORDER BY name ASC, id ASC
  `,
  },
  {
    key: "donors",
    sql: `
    SELECT
      id,
      person_id,
      name,
      cpf,
      demand,
      donor_type,
      holder_donor_id,
      holder_person_id,
      CAST(donation_start_date AS VARCHAR) AS donation_start_date,
      is_active,
      CAST(created_at AS VARCHAR) AS created_at,
      CAST(updated_at AS VARCHAR) AS updated_at
    FROM donors
    ORDER BY name ASC, id ASC
  `,
  },
  {
    key: "donorCpfLinks",
    sql: `
    SELECT
      id,
      donor_id,
      name,
      cpf,
      CAST(donation_start_date AS VARCHAR) AS donation_start_date,
      link_type,
      is_active,
      CAST(created_at AS VARCHAR) AS created_at,
      CAST(updated_at AS VARCHAR) AS updated_at
    FROM donor_cpf_links
    ORDER BY donor_id ASC, link_type ASC, name ASC, id ASC
  `,
  },
  {
    key: "imports",
    sql: `
    SELECT
      id,
      CAST(reference_month AS VARCHAR) AS reference_month,
      file_name,
      value_per_note,
      total_rows,
      matched_rows,
      matched_donors,
      status,
      notes,
      cnpj_entidade_social,
      CAST(imported_at AS VARCHAR) AS imported_at,
      CAST(updated_at AS VARCHAR) AS updated_at
    FROM imports
    ORDER BY reference_month ASC, id ASC
  `,
  },
  {
    key: "importCpfSummary",
    sql: `
    SELECT
      id,
      import_id,
      CAST(reference_month AS VARCHAR) AS reference_month,
      cpf,
      notes_count,
      matched_donor_id,
      matched_source_id,
      is_registered_donor,
      CAST(created_at AS VARCHAR) AS created_at,
      CAST(updated_at AS VARCHAR) AS updated_at
    FROM import_cpf_summary
    ORDER BY reference_month ASC, cpf ASC, id ASC
  `,
  },
  {
    key: "monthlyDonorSummary",
    sql: `
    SELECT
      id,
      import_id,
      donor_id,
      CAST(reference_month AS VARCHAR) AS reference_month,
      cpf,
      donor_name,
      demand,
      notes_count,
      value_per_note,
      abatement_amount,
      abatement_status,
      CAST(abatement_marked_at AS VARCHAR) AS abatement_marked_at,
      CAST(created_at AS VARCHAR) AS created_at,
      CAST(updated_at AS VARCHAR) AS updated_at
    FROM monthly_donor_summary
    ORDER BY reference_month ASC, donor_name ASC, id ASC
  `,
  },
  {
    key: "trashItems",
    sql: `
    SELECT
      id,
      entity_type,
      entity_id,
      label,
      payload_json,
      CAST(deleted_at AS VARCHAR) AS deleted_at
    FROM trash_items
    ORDER BY deleted_at DESC, id ASC
  `,
  },
  {
    key: "notes",
    sql: `
    SELECT
      id,
      project_id,
      title,
      content,
      color,
      CAST(created_at AS VARCHAR) AS created_at,
      CAST(updated_at AS VARCHAR) AS updated_at
    FROM notes
    ORDER BY updated_at DESC, created_at DESC, id ASC
  `,
  },
  {
    key: "actionHistory",
    sql: `
    SELECT
      id,
      action_type,
      entity_type,
      entity_id,
      label,
      description,
      payload_json,
      CAST(created_at AS VARCHAR) AS created_at
    FROM action_history
    ORDER BY created_at DESC, id ASC
  `,
  },
  {
    key: "donorActivityHistory",
    sql: `
    SELECT
      id,
      donor_id,
      event_type,
      CAST(reference_month AS VARCHAR) AS reference_month,
      CAST(created_at AS VARCHAR) AS created_at
    FROM donor_activity_history
    ORDER BY reference_month ASC, created_at ASC, id ASC
  `,
  },
  {
    key: "abatementAdjustments",
    sql: `
    SELECT
      id,
      donor_id,
      CAST(reference_month AS VARCHAR) AS reference_month,
      CAST(range_start_month AS VARCHAR) AS range_start_month,
      CAST(range_end_month AS VARCHAR) AS range_end_month,
      notes_count,
      abatement_amount,
      description,
      abatement_status,
      CAST(abatement_marked_at AS VARCHAR) AS abatement_marked_at,
      CAST(created_at AS VARCHAR) AS created_at,
      CAST(updated_at AS VARCHAR) AS updated_at
    FROM abatement_adjustments
    ORDER BY reference_month ASC, donor_id ASC, id ASC
  `,
  },
  {
    key: "donationNotes",
    sql: `
    SELECT
      id,
      import_id,
      cpf,
      CAST(reference_month AS VARCHAR) AS reference_month,
      numero_nota,
      valor_nota,
      CAST(data_nota AS VARCHAR) AS data_nota,
      CAST(data_pedido AS VARCHAR) AS data_pedido,
      cnpj_estabelecimento,
      status_pedido,
      tipo_doacao,
      is_valid,
      match_key,
      valor_cents,
      CAST(created_at AS VARCHAR) AS created_at
    FROM donation_notes
    ORDER BY import_id ASC, id ASC
  `,
  },
  {
    key: "creditImports",
    sql: `
    SELECT
      id,
      CAST(reference_month AS VARCHAR) AS reference_month,
      file_name,
      total_rows,
      valid_rows,
      status,
      notes,
      CAST(imported_at AS VARCHAR) AS imported_at,
      CAST(updated_at AS VARCHAR) AS updated_at
    FROM credit_imports
    ORDER BY reference_month ASC, id ASC
  `,
  },
  {
    key: "creditNotes",
    sql: `
    SELECT
      id,
      credit_import_id,
      cnpj_estabelecimento,
      emitente,
      numero_nota,
      CAST(data_emissao AS VARCHAR) AS data_emissao,
      valor_nf,
      CAST(data_registro AS VARCHAR) AS data_registro,
      credito,
      situacao,
      is_valid,
      match_key,
      valor_cents,
      CAST(created_at AS VARCHAR) AS created_at
    FROM credit_notes
    ORDER BY credit_import_id ASC, id ASC
  `,
  },
];

/**
 * Envolve o SELECT de uma tabela para o DuckDB devolver o array JSON pronto,
 * já com a contagem de linhas.
 *
 * O `count(*)` sai daqui, e não de uma segunda consulta, para o número não
 * poder descrever um conteúdo diferente do que foi serializado.
 *
 * `coalesce` cobre a tabela vazia: sem linha nenhuma o agregado devolve NULL,
 * e um NULL concatenado no envelope produziria JSON inválido.
 */
export function buildSnapshotJsonQuery(sql) {
  return `
    SELECT
      coalesce(json_group_array(fonte), '[]') AS json_text,
      count(*) AS total
    FROM (${sql}) AS fonte
  `;
}
