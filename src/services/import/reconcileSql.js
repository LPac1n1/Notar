/**
 * SQL que monta o resumo mensal de UMA importação, isolado de import de
 * banco para o teste de integração rodar a consulta de produção.
 *
 * Uma linha por doador com CPF na planilha. Parâmetro: o id da importação.
 *
 * SEM filtro de doador ativo, de propósito. O resumo é o registro do que foi
 * doado; se o doador conta ou não na apuração é decidido na leitura
 * (`summaryDonorCounts`, em `monthly/summaryScopeSql.js`). Com o filtro
 * aqui, reconciliar uma importação apagava as linhas de quem estava inativo —
 * junto com o status de abatimento delas —, e reativar o doador trazia os
 * meses de volta como pendentes, prontos para serem abatidos de novo.
 *
 * O filtro do VÍNCULO de CPF continua: CPF desvinculado não é mais do doador.
 */
export const RECONCILE_MATCHED_DONORS_SQL = `
        SELECT
          import_cpf_summary.import_id,
          strftime(import_cpf_summary.reference_month, '%Y-%m-01') AS reference_month,
          donors.id AS donor_id,
          donors.cpf AS donor_cpf,
          donors.name AS donor_name,
          donors.demand AS demand,
          sum(import_cpf_summary.notes_count) AS notes_count,
          sum(coalesce(import_cpf_summary.invalid_notes_count, 0)) AS invalid_notes_count
        FROM import_cpf_summary
        INNER JOIN donor_cpf_links
          ON donor_cpf_links.id = import_cpf_summary.matched_source_id
        INNER JOIN donors
          ON donors.id = donor_cpf_links.donor_id
        WHERE import_cpf_summary.import_id = ?
          AND donor_cpf_links.is_active = TRUE
        GROUP BY
          import_cpf_summary.import_id,
          import_cpf_summary.reference_month,
          donors.id,
          donors.cpf,
          donors.name,
          donors.demand
      `;

/**
 * Refaz a contagem de notas INVÁLIDAS por CPF a partir das próprias notas.
 *
 * A contagem era gravada na importação e nunca ia para o arquivo da nuvem
 * (a coluna não estava no SELECT do snapshot), então voltava zerada a cada
 * abertura do sistema. As notas, com `is_valid`, sempre viajaram: é delas
 * que o número sai de volta — a mesma conta da pré-visualização da
 * importação (`count(*) FILTER (WHERE is_valid = FALSE)`).
 *
 * Só toca a linha cujo número está diferente, então depois da primeira vez
 * não faz nada. Importação sem nota gravada (anterior às notas por linha)
 * não é tocada: não há de onde tirar o número.
 */
export const BACKFILL_CPF_INVALID_NOTES_SQL = `
  UPDATE import_cpf_summary
  SET invalid_notes_count = invalid_by_cpf.total
  FROM (
    SELECT import_id, cpf, count(*) AS total
    FROM donation_notes
    WHERE is_valid = FALSE
    GROUP BY import_id, cpf
  ) AS invalid_by_cpf
  WHERE invalid_by_cpf.import_id = import_cpf_summary.import_id
    AND invalid_by_cpf.cpf = import_cpf_summary.cpf
    AND coalesce(import_cpf_summary.invalid_notes_count, 0) <> invalid_by_cpf.total
`;

/**
 * Leva a contagem de inválidas do CPF para o resumo do doador, com as mesmas
 * junções de `RECONCILE_MATCHED_DONORS_SQL`. Roda depois da de cima.
 */
export const BACKFILL_SUMMARY_INVALID_NOTES_SQL = `
  UPDATE monthly_donor_summary
  SET invalid_notes_count = invalid_by_donor.total
  FROM (
    SELECT
      import_cpf_summary.import_id AS import_id,
      donor_cpf_links.donor_id AS donor_id,
      sum(coalesce(import_cpf_summary.invalid_notes_count, 0)) AS total
    FROM import_cpf_summary
    INNER JOIN donor_cpf_links
      ON donor_cpf_links.id = import_cpf_summary.matched_source_id
      AND donor_cpf_links.is_active = TRUE
    GROUP BY import_cpf_summary.import_id, donor_cpf_links.donor_id
  ) AS invalid_by_donor
  WHERE invalid_by_donor.import_id = monthly_donor_summary.import_id
    AND invalid_by_donor.donor_id = monthly_donor_summary.donor_id
    AND coalesce(monthly_donor_summary.invalid_notes_count, 0) <> invalid_by_donor.total
`;

/**
 * Cria o resumo mensal que FALTA: todo doador com CPF numa planilha
 * processada tem uma linha de resumo daquela importação.
 *
 * Existe por causa de um defeito antigo. Até o commit 312, reconciliar uma
 * importação apagava o resumo de quem estava inativo. Com a regra por mês
 * (o desativado conta nos meses anteriores à desativação) esses meses voltam
 * à apuração, mas a linha não existe mais — a Gestão Mensal mostraria "Sem
 * doações no mês" onde houve doação, e a linha reapareceria sozinha, sem
 * aviso, na primeira reconciliação que tocasse aquela importação.
 *
 * A linha nasce `pending`: o status que ela tinha se perdeu quando foi
 * apagada, e marcar como realizado sem saber seria esconder uma pendência.
 * Quem sabe se o mês já foi abatido é o usuário.
 *
 * Só INSERE o que falta. Linha existente não é tocada — nem contagem, nem
 * status —, então rodar de novo não faz nada (roda a cada abertura do app).
 *
 * O id é derivado de importação + doador para dois computadores que abram o
 * mesmo arquivo da nuvem criarem a MESMA linha, e não duas.
 *
 * Mesmas junções de `RECONCILE_MATCHED_DONORS_SQL`. Depende de
 * `import_cpf_summary.matched_source_id` em dia.
 */
export const INSERT_MISSING_MONTHLY_SUMMARIES_SQL = `
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
    created_at,
    updated_at
  )
  SELECT
    import_cpf_summary.import_id || '-' || donors.id,
    import_cpf_summary.import_id,
    donors.id,
    CAST(strftime(min(import_cpf_summary.reference_month), '%Y-%m-01') AS DATE),
    donors.cpf,
    donors.name,
    coalesce(donors.demand, ''),
    sum(import_cpf_summary.notes_count),
    sum(coalesce(import_cpf_summary.invalid_notes_count, 0)),
    coalesce(imports.value_per_note, 0),
    sum(import_cpf_summary.notes_count) * coalesce(imports.value_per_note, 0),
    'pending',
    NULL,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  FROM import_cpf_summary
  INNER JOIN donor_cpf_links
    ON donor_cpf_links.id = import_cpf_summary.matched_source_id
  INNER JOIN donors
    ON donors.id = donor_cpf_links.donor_id
  INNER JOIN imports
    ON imports.id = import_cpf_summary.import_id
  WHERE imports.status = 'processed'
    AND donor_cpf_links.is_active = TRUE
    AND NOT EXISTS (
      SELECT 1
      FROM monthly_donor_summary AS existing_summary
      WHERE existing_summary.import_id = import_cpf_summary.import_id
        AND existing_summary.donor_id = donors.id
    )
  GROUP BY
    import_cpf_summary.import_id,
    imports.value_per_note,
    donors.id,
    donors.cpf,
    donors.name,
    donors.demand
`;
