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
