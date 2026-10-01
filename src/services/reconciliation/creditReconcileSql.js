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
 * "Nem este crédito nem esta doação já foram classificados."
 *
 * São DOIS `NOT EXISTS` ligados por `AND`, e não um só com `OR` dentro.
 * As duas formas dizem a mesma coisa — `não (A ou B)` é `(não A) e (não B)` —
 * mas o banco só consegue resolver por junção de igualdade a segunda. Com o
 * `OR`, cada par candidato era comparado contra a tabela inteira: no banco
 * real (304 mil doações, 115 mil linhas já em "repetidas") a conciliação
 * levava 707 s. Com a forma abaixo, 9,7 s, com o mesmo resultado nos seis
 * status.
 *
 * Um fragmento só, usado nos dois passos que precisam dele, para as duas
 * cópias não divergirem.
 */
const NEITHER_NOTE_IS_RECONCILED = `
          NOT EXISTS (
            SELECT 1
            FROM credit_reconciliation
            WHERE credit_reconciliation.credit_note_id = credit_notes.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM credit_reconciliation
            WHERE credit_reconciliation.donation_note_id = donation_notes.id
          )`;

/**
 * Os passos da reconstrução, NA ORDEM em que precisam rodar.
 *
 * A ordem é a regra: cada passo só pega o que os anteriores deixaram, então
 * trocar dois de lugar muda o resultado. Só entram notas com
 * `is_valid = TRUE` dos dois lados.
 *
 * O resultado é uma linha por nota de origem, nunca duplicada:
 *
 *   duplicate_donation — a mesma chave COM O MESMO VALOR aparece mais de uma
 *                        vez nas doações.
 *   duplicate_credit   — idem, nos créditos.
 *   matched            — crédito ↔ doação por chave E valor em centavos.
 *   divergent          — uma única nota de cada lado com aquela chave, e o
 *                        valor não bate.
 *   credit_only        — crédito sem doação correspondente.
 *   donation_only      — doação sem crédito correspondente.
 *
 * As repetidas vêm primeiro porque duas linhas iguais em chave e valor são
 * ambíguas: pareá-las com uma contraparte específica seria arbitrário e
 * esconderia um problema do dado.
 *
 * ── Por que o valor entra na repetição ──────────────────────────────────
 * CNPJ + número NÃO identifica uma nota: o mesmo estabelecimento emite o
 * mesmo número em séries diferentes. No banco real, 24.040 dos 24.066 grupos
 * de "chave repetida" tinham valores DIFERENTES entre si — eram notas
 * distintas, e 57 mil delas (R$ 28,7 mil de crédito) ficavam fora da
 * conciliação. Com o valor na comparação, cada uma encontra o próprio par.
 *
 * ── Por que `divergent` exige uma nota só de cada lado ──────────────────
 * Com várias notas sob a mesma chave, "mesma chave, valor diferente" deixa
 * de apontar para UM par: duas doações e dois créditos sem par gerariam
 * quatro linhas, e cada nota apareceria duas vezes — crédito contado em
 * dobro em toda soma que passa por esta tabela. Sobrando mais de uma, as
 * notas seguem para `credit_only` / `donation_only`.
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
          SELECT match_key, valor_cents
          FROM donation_notes
          WHERE is_valid = TRUE AND ${completeKeyCondition("donation_notes")}
          GROUP BY match_key, valor_cents
          HAVING count(*) > 1
        ) AS donation_duplicates
          ON donation_duplicates.match_key = donation_notes.match_key
          AND donation_duplicates.valor_cents IS NOT DISTINCT FROM donation_notes.valor_cents
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
          SELECT match_key, valor_cents
          FROM credit_notes
          WHERE is_valid = TRUE AND ${completeKeyCondition("credit_notes")}
          GROUP BY match_key, valor_cents
          HAVING count(*) > 1
        ) AS credit_duplicates
          ON credit_duplicates.match_key = credit_notes.match_key
          AND credit_duplicates.valor_cents IS NOT DISTINCT FROM credit_notes.valor_cents
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
          AND ${NEITHER_NOTE_IS_RECONCILED}
      `,
  },
  {
    // "Mesma nota, valor declarado diferente": aparece para o usuário poder
    // investigar sem perder a ligação entre as duas linhas. As duas junções
    // com `lone_*` são o que garante UMA nota de cada lado sob a chave — ver
    // o comentário do cabeçalho.
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
        INNER JOIN (
          SELECT match_key
          FROM credit_notes
          WHERE is_valid = TRUE
          GROUP BY match_key
          HAVING count(*) = 1
        ) AS lone_credits
          ON lone_credits.match_key = credit_notes.match_key
        INNER JOIN (
          SELECT match_key
          FROM donation_notes
          WHERE is_valid = TRUE
          GROUP BY match_key
          HAVING count(*) = 1
        ) AS lone_donations
          ON lone_donations.match_key = donation_notes.match_key
        WHERE credit_notes.is_valid = TRUE
          AND donation_notes.is_valid = TRUE
          AND ${completeKeyCondition("credit_notes")}
          AND ${NEITHER_NOTE_IS_RECONCILED}
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
