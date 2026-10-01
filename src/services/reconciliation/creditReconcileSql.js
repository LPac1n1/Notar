/**
 * SQL da reconstrução de `credit_reconciliation`, isolado de qualquer import
 * de banco.
 *
 * Mora à parte para o teste de integração rodar exatamente estas instruções
 * contra o DuckDB — mesmo padrão de `inactivityStreaksSql.js`. Antes disto a
 * suíte mantinha uma cópia à mão do SQL, e um teste que roda a cópia só prova
 * que a cópia funciona.
 *
 * Node ESM não resolve import sem extensão, ao contrário do Vite: quem
 * importa este arquivo usa `.js` explícito.
 */

/**
 * A chave de conciliação está completa quando as duas metades de
 * `<cnpj>|<numero>` estão preenchidas. Metade vazia tira a linha dos passos
 * de repetidas, conciliadas e valor diferente.
 *
 * É função, e não um trecho fixo, para cada chamada qualificar a coluna com
 * o alias certo — sem isso `match_key` fica ambíguo nas junções entre as duas
 * tabelas de notas.
 */
export function completeKeyCondition(alias) {
  return `
    ${alias}.match_key IS NOT NULL
    AND ${alias}.match_key <> ''
    AND ${alias}.match_key NOT LIKE '%|'
    AND ${alias}.match_key NOT LIKE '|%'
  `;
}

/**
 * Os passos da reconstrução, NA ORDEM em que precisam rodar.
 *
 * A ordem é a regra: cada passo só pega o que os anteriores deixaram, então
 * trocar dois de lugar muda o resultado. Só entram notas com
 * `is_valid = TRUE` dos dois lados.
 *
 * O resultado é uma linha por nota de origem, nunca duplicada:
 *
 *   duplicate_donation — a mesma chave aparece mais de uma vez nas doações.
 *   duplicate_credit   — idem, nos créditos.
 *   matched            — crédito ↔ doação por chave E valor em centavos.
 *   divergent          — mesma chave dos dois lados, valor diferente.
 *   credit_only        — crédito sem doação correspondente.
 *   donation_only      — doação sem crédito correspondente.
 *
 * As repetidas vêm primeiro porque uma nota cuja chave colide é ambígua:
 * pareá-la com uma contraparte específica seria arbitrário e esconderia um
 * problema do dado.
 */
export const CREDIT_RECONCILE_STEPS = [
  {
    status: "duplicate_donation",
    sql: `
        INSERT INTO credit_reconciliation (
          id, credit_note_id, donation_note_id, match_status, created_at
        )
        SELECT
          CAST(uuid() AS VARCHAR),
          NULL,
          donation_notes.id,
          'duplicate_donation',
          CURRENT_TIMESTAMP
        FROM donation_notes
        INNER JOIN (
          SELECT match_key
          FROM donation_notes
          WHERE is_valid = TRUE AND ${completeKeyCondition("donation_notes")}
          GROUP BY match_key
          HAVING count(*) > 1
        ) AS donation_duplicates
          ON donation_duplicates.match_key = donation_notes.match_key
        WHERE donation_notes.is_valid = TRUE
      `,
  },
  {
    status: "duplicate_credit",
    sql: `
        INSERT INTO credit_reconciliation (
          id, credit_note_id, donation_note_id, match_status, created_at
        )
        SELECT
          CAST(uuid() AS VARCHAR),
          credit_notes.id,
          NULL,
          'duplicate_credit',
          CURRENT_TIMESTAMP
        FROM credit_notes
        INNER JOIN (
          SELECT match_key
          FROM credit_notes
          WHERE is_valid = TRUE AND ${completeKeyCondition("credit_notes")}
          GROUP BY match_key
          HAVING count(*) > 1
        ) AS credit_duplicates
          ON credit_duplicates.match_key = credit_notes.match_key
        WHERE credit_notes.is_valid = TRUE
      `,
  },
  {
    // O NOT EXISTS mantém a reconstrução idempotente mesmo quando a nota já
    // caiu num dos grupos de repetidas acima.
    status: "matched",
    sql: `
        INSERT INTO credit_reconciliation (
          id, credit_note_id, donation_note_id, match_status, created_at
        )
        SELECT
          CAST(uuid() AS VARCHAR),
          credit_notes.id,
          donation_notes.id,
          'matched',
          CURRENT_TIMESTAMP
        FROM credit_notes
        INNER JOIN donation_notes
          ON donation_notes.match_key = credit_notes.match_key
          AND donation_notes.valor_cents = credit_notes.valor_cents
        WHERE credit_notes.is_valid = TRUE
          AND donation_notes.is_valid = TRUE
          AND ${completeKeyCondition("credit_notes")}
          AND NOT EXISTS (
            SELECT 1
            FROM credit_reconciliation
            WHERE credit_reconciliation.credit_note_id = credit_notes.id
              OR credit_reconciliation.donation_note_id = donation_notes.id
          )
      `,
  },
  {
    // "Mesma nota, valor declarado diferente": aparece para o usuário poder
    // investigar sem perder a ligação entre as duas linhas.
    status: "divergent",
    sql: `
        INSERT INTO credit_reconciliation (
          id, credit_note_id, donation_note_id, match_status, created_at
        )
        SELECT
          CAST(uuid() AS VARCHAR),
          credit_notes.id,
          donation_notes.id,
          'divergent',
          CURRENT_TIMESTAMP
        FROM credit_notes
        INNER JOIN donation_notes
          ON donation_notes.match_key = credit_notes.match_key
          AND donation_notes.valor_cents <> credit_notes.valor_cents
        WHERE credit_notes.is_valid = TRUE
          AND donation_notes.is_valid = TRUE
          AND ${completeKeyCondition("credit_notes")}
          AND NOT EXISTS (
            SELECT 1
            FROM credit_reconciliation
            WHERE credit_reconciliation.credit_note_id = credit_notes.id
              OR credit_reconciliation.donation_note_id = donation_notes.id
          )
      `,
  },
  {
    status: "credit_only",
    sql: `
        INSERT INTO credit_reconciliation (
          id, credit_note_id, donation_note_id, match_status, created_at
        )
        SELECT
          CAST(uuid() AS VARCHAR),
          credit_notes.id,
          NULL,
          'credit_only',
          CURRENT_TIMESTAMP
        FROM credit_notes
        WHERE credit_notes.is_valid = TRUE
          AND NOT EXISTS (
            SELECT 1
            FROM credit_reconciliation
            WHERE credit_reconciliation.credit_note_id = credit_notes.id
          )
      `,
  },
  {
    status: "donation_only",
    sql: `
        INSERT INTO credit_reconciliation (
          id, credit_note_id, donation_note_id, match_status, created_at
        )
        SELECT
          CAST(uuid() AS VARCHAR),
          NULL,
          donation_notes.id,
          'donation_only',
          CURRENT_TIMESTAMP
        FROM donation_notes
        WHERE donation_notes.is_valid = TRUE
          AND NOT EXISTS (
            SELECT 1
            FROM credit_reconciliation
            WHERE credit_reconciliation.donation_note_id = donation_notes.id
          )
      `,
  },
];

/**
 * A reconstrução inteira: limpa a tabela e roda os passos na ordem.
 *
 * `credit_reconciliation` é dado derivado — nunca editado pelo usuário —,
 * então apagar e refazer é seguro e deixa o resultado dependente só das duas
 * tabelas de notas.
 */
export const CREDIT_RECONCILE_STATEMENTS = [
  `DELETE FROM credit_reconciliation`,
  ...CREDIT_RECONCILE_STEPS.map((step) => step.sql),
];
