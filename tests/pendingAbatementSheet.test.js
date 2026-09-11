import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestConnection } from "./helpers/duckdbHelper.js";
import { runMigrations } from "../src/services/db/migrations.js";
import { buildPendingAbatementSheetSql } from "../src/services/monthly/abatementSheetSql.js";
import { buildAbatementDescription } from "../src/services/monthly/abatementSheetDescription.js";
import {
  ASSIGNMENT_OPEN_END,
  ASSIGNMENT_OPEN_START,
  DEFAULT_PROJECT_ID,
} from "../src/services/project/projectAssignmentSql.js";

/**
 * Planilha de todos os meses pendentes, contra o DuckDB real.
 *
 * O que ela não pode fazer é mandar para o sistema de baixa um mês que já foi
 * abatido — marcado como realizado ou coberto por um acumulado lançado em
 * outro mês. Nos dois casos o destino registraria a mesma doação duas vezes.
 *
 * Cenário, em notas por mês (P = pendente, R = realizado):
 *
 *   MARIA  (titular com auxiliar)  jan 10 P · fev 20 R · mar 5 P* · abr 7 P
 *   JOAO   (auxiliar da Maria)     jan 3 P  · fev 4 P
 *   CARLOS (titular sozinho)       jan 6 P  · fev 2 P  · mar 8 P · abr 0 P
 *   EVA    (em dia)                jan 9 R
 *   DORA   (outro projeto)         jan 11 P
 *
 *   * março da Maria está coberto por um acumulado lançado em abril.
 */
async function seed(conn) {
  await runMigrations(conn);

  await conn.query(`
    INSERT INTO projects (id, name, slug, modules, color, is_active, created_at, updated_at)
    VALUES ('prj-capoeira', 'Capoeira', 'capoeira', '{}', '#059669', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);

  await conn.query(`
    INSERT INTO people (id, name, cpf, is_active)
    VALUES
      ('p-maria',  'MARIA SILVA',    '11111111111', TRUE),
      ('p-joao',   'JOAO AUXILIAR',  '22222222222', TRUE),
      ('p-carlos', 'CARLOS SOZINHO', '33333333333', TRUE)
  `);

  await conn.query(`
    INSERT INTO donors (id, person_id, name, cpf, demand, donor_type, holder_person_id, is_active)
    VALUES
      ('d-maria',  'p-maria',  'MARIA SILVA',    '11111111111', 'CESTAS',   'holder',    NULL,      TRUE),
      ('d-joao',   'p-joao',   'JOAO AUXILIAR',  '22222222222', 'CESTAS',   'auxiliary', 'p-maria', TRUE),
      ('d-carlos', 'p-carlos', 'CARLOS SOZINHO', '33333333333', 'REMEDIOS', 'holder',    NULL,      TRUE),
      ('d-eva',    'p-eva',    'EVA EM DIA',     '44444444444', 'CESTAS',   'holder',    NULL,      TRUE),
      ('d-dora',   'p-dora',   'DORA CAPOEIRA',  '55555555555', NULL,       'holder',    NULL,      TRUE)
  `);

  await conn.query(`
    INSERT INTO donor_project_assignments
      (id, donor_id, project_id, valid_from, valid_to, reason, created_at)
    VALUES
      ('dpa-maria',  'd-maria',  '${DEFAULT_PROJECT_ID}', DATE '${ASSIGNMENT_OPEN_START}', DATE '${ASSIGNMENT_OPEN_END}', 'inicial', CURRENT_TIMESTAMP),
      ('dpa-joao',   'd-joao',   '${DEFAULT_PROJECT_ID}', DATE '${ASSIGNMENT_OPEN_START}', DATE '${ASSIGNMENT_OPEN_END}', 'inicial', CURRENT_TIMESTAMP),
      ('dpa-carlos', 'd-carlos', '${DEFAULT_PROJECT_ID}', DATE '${ASSIGNMENT_OPEN_START}', DATE '${ASSIGNMENT_OPEN_END}', 'inicial', CURRENT_TIMESTAMP),
      ('dpa-eva',    'd-eva',    '${DEFAULT_PROJECT_ID}', DATE '${ASSIGNMENT_OPEN_START}', DATE '${ASSIGNMENT_OPEN_END}', 'inicial', CURRENT_TIMESTAMP),
      ('dpa-dora',   'd-dora',   'prj-capoeira',          DATE '${ASSIGNMENT_OPEN_START}', DATE '${ASSIGNMENT_OPEN_END}', 'inicial', CURRENT_TIMESTAMP)
  `);

  await conn.query(`
    INSERT INTO donor_cpf_links (id, donor_id, name, cpf, link_type, is_active)
    VALUES
      ('lk-maria',  'd-maria',  'MARIA SILVA',    '11111111111', 'holder', TRUE),
      ('lk-joao',   'd-joao',   'JOAO AUXILIAR',  '22222222222', 'holder', TRUE),
      ('lk-carlos', 'd-carlos', 'CARLOS SOZINHO', '33333333333', 'holder', TRUE),
      ('lk-eva',    'd-eva',    'EVA EM DIA',     '44444444444', 'holder', TRUE),
      ('lk-dora',   'd-dora',   'DORA CAPOEIRA',  '55555555555', 'holder', TRUE)
  `);

  await conn.query(`
    INSERT INTO imports (id, reference_month, file_name, value_per_note, status)
    VALUES
      ('imp-jan', DATE '2026-01-01', 'jan.csv', 10, 'processed'),
      ('imp-fev', DATE '2026-02-01', 'fev.csv', 10, 'processed'),
      ('imp-mar', DATE '2026-03-01', 'mar.csv', 10, 'processed'),
      ('imp-abr', DATE '2026-04-01', 'abr.csv', 10, 'processed')
  `);

  await conn.query(`
    INSERT INTO import_cpf_summary
      (id, import_id, reference_month, cpf, notes_count, invalid_notes_count, matched_donor_id, matched_source_id, is_registered_donor)
    VALUES
      ('i-maria-jan',  'imp-jan', DATE '2026-01-01', '11111111111', 10, 0, 'd-maria',  'lk-maria',  TRUE),
      ('i-maria-fev',  'imp-fev', DATE '2026-02-01', '11111111111', 20, 0, 'd-maria',  'lk-maria',  TRUE),
      ('i-maria-mar',  'imp-mar', DATE '2026-03-01', '11111111111',  5, 0, 'd-maria',  'lk-maria',  TRUE),
      ('i-maria-abr',  'imp-abr', DATE '2026-04-01', '11111111111',  7, 0, 'd-maria',  'lk-maria',  TRUE),
      ('i-joao-jan',   'imp-jan', DATE '2026-01-01', '22222222222',  3, 0, 'd-joao',   'lk-joao',   TRUE),
      ('i-joao-fev',   'imp-fev', DATE '2026-02-01', '22222222222',  4, 0, 'd-joao',   'lk-joao',   TRUE),
      ('i-carlos-jan', 'imp-jan', DATE '2026-01-01', '33333333333',  6, 0, 'd-carlos', 'lk-carlos', TRUE),
      ('i-carlos-fev', 'imp-fev', DATE '2026-02-01', '33333333333',  2, 0, 'd-carlos', 'lk-carlos', TRUE),
      ('i-carlos-mar', 'imp-mar', DATE '2026-03-01', '33333333333',  8, 0, 'd-carlos', 'lk-carlos', TRUE),
      ('i-carlos-abr', 'imp-abr', DATE '2026-04-01', '33333333333',  0, 3, 'd-carlos', 'lk-carlos', TRUE),
      ('i-eva-jan',    'imp-jan', DATE '2026-01-01', '44444444444',  9, 0, 'd-eva',    'lk-eva',    TRUE),
      ('i-dora-jan',   'imp-jan', DATE '2026-01-01', '55555555555', 11, 0, 'd-dora',   'lk-dora',   TRUE)
  `);

  await conn.query(`
    INSERT INTO monthly_donor_summary
      (id, import_id, donor_id, reference_month, cpf, donor_name, demand,
       notes_count, value_per_note, abatement_amount, abatement_status)
    VALUES
      ('s-maria-jan',  'imp-jan', 'd-maria',  DATE '2026-01-01', '11111111111', 'MARIA SILVA',    'CESTAS',   10, 10, 100, 'pending'),
      ('s-maria-fev',  'imp-fev', 'd-maria',  DATE '2026-02-01', '11111111111', 'MARIA SILVA',    'CESTAS',   20, 10, 200, 'applied'),
      ('s-maria-mar',  'imp-mar', 'd-maria',  DATE '2026-03-01', '11111111111', 'MARIA SILVA',    'CESTAS',    5, 10,  50, 'pending'),
      ('s-maria-abr',  'imp-abr', 'd-maria',  DATE '2026-04-01', '11111111111', 'MARIA SILVA',    'CESTAS',    7, 10,  70, 'pending'),
      ('s-joao-jan',   'imp-jan', 'd-joao',   DATE '2026-01-01', '22222222222', 'JOAO AUXILIAR',  'CESTAS',    3, 10,  30, 'pending'),
      ('s-joao-fev',   'imp-fev', 'd-joao',   DATE '2026-02-01', '22222222222', 'JOAO AUXILIAR',  'CESTAS',    4, 10,  40, 'pending'),
      ('s-carlos-jan', 'imp-jan', 'd-carlos', DATE '2026-01-01', '33333333333', 'CARLOS SOZINHO', 'REMEDIOS',  6, 10,  60, 'pending'),
      ('s-carlos-fev', 'imp-fev', 'd-carlos', DATE '2026-02-01', '33333333333', 'CARLOS SOZINHO', 'REMEDIOS',  2, 10,  20, 'pending'),
      ('s-carlos-mar', 'imp-mar', 'd-carlos', DATE '2026-03-01', '33333333333', 'CARLOS SOZINHO', 'REMEDIOS',  8, 10,  80, 'pending'),
      ('s-carlos-abr', 'imp-abr', 'd-carlos', DATE '2026-04-01', '33333333333', 'CARLOS SOZINHO', 'REMEDIOS',  0, 10,   0, 'pending'),
      ('s-eva-jan',    'imp-jan', 'd-eva',    DATE '2026-01-01', '44444444444', 'EVA EM DIA',     'CESTAS',    9, 10,  90, 'applied'),
      ('s-dora-jan',   'imp-jan', 'd-dora',   DATE '2026-01-01', '55555555555', 'DORA CAPOEIRA',  NULL,       11, 10, 110, 'pending')
  `);

  // Acumulado lançado em ABRIL cobrindo MARÇO. Na Gestão Mensal março aparece
  // como "Via acumulado"; o status cru dele segue `pending` no banco.
  await conn.query(`
    INSERT INTO abatement_adjustments
      (id, donor_id, reference_month, range_start_month, range_end_month,
       notes_count, abatement_amount, abatement_status)
    VALUES ('adj-maria', 'd-maria', DATE '2026-04-01', DATE '2026-03-01', DATE '2026-03-01', 5, 50, 'applied')
  `);
}

async function pendingSheet(conn, projectId = DEFAULT_PROJECT_ID) {
  const rows = (await conn.query(buildPendingAbatementSheetSql(projectId))).toArray();

  return rows.map((row) => ({
    cpf: String(row.cpf),
    donorName: String(row.donor_name),
    sheetName: String(row.sheet_name),
    sheetCpf: String(row.sheet_cpf),
    notesCount: Number(row.notes_count),
    referenceMonths: String(row.reference_months).split(",").sort(),
    lastMonth: String(row.last_month),
    groupHasAuxiliaries: Boolean(row.group_has_auxiliaries),
  }));
}

test("a planilha de pendentes soma, por CPF, só os meses que ainda dá para abater", async () => {
  const conn = await createTestConnection();
  try {
    await seed(conn);
    const linhas = await pendingSheet(conn);

    // Eva está em dia e Dora é de outro projeto: nenhuma das duas entra.
    assert.deepEqual(
      linhas.map((linha) => linha.donorName),
      ["CARLOS SOZINHO", "JOAO AUXILIAR", "MARIA SILVA"],
    );

    const porCpf = new Map(linhas.map((linha) => [linha.cpf, linha]));

    // Maria: fevereiro foi realizado e março foi abatido pelo acumulado de
    // abril. Sobram janeiro e abril — com um buraco no meio, então "e", nunca
    // "até".
    const maria = porCpf.get("11111111111");
    assert.equal(maria.notesCount, 17);
    assert.deepEqual(maria.referenceMonths, ["2026-01-01", "2026-04-01"]);
    assert.equal(maria.lastMonth, "2026-04-01");
    assert.equal(
      buildAbatementDescription({
        donorName: maria.donorName,
        referenceMonths: maria.referenceMonths,
        groupHasAuxiliaries: maria.groupHasAuxiliaries,
      }),
      "Doações NFP - MARIA SILVA - Jan/2026 e Abr/2026",
    );

    // Joao continua na linha dele, com a contagem dele — e com o nome e o CPF
    // da titular nas colunas de identidade, como na planilha de um mês.
    const joao = porCpf.get("22222222222");
    assert.equal(joao.notesCount, 7);
    assert.deepEqual(joao.referenceMonths, ["2026-01-01", "2026-02-01"]);
    assert.equal(joao.sheetName, "MARIA SILVA");
    assert.equal(joao.sheetCpf, "11111111111");

    // Carlos: abril não tem nota válida e fica de fora mesmo pendente. Os três
    // meses que sobram são seguidos.
    const carlos = porCpf.get("33333333333");
    assert.equal(carlos.notesCount, 16);
    assert.deepEqual(carlos.referenceMonths, [
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
    ]);
    assert.equal(carlos.lastMonth, "2026-03-01");
    assert.equal(
      buildAbatementDescription({
        donorName: carlos.donorName,
        referenceMonths: carlos.referenceMonths,
        groupHasAuxiliaries: carlos.groupHasAuxiliaries,
      }),
      "Doações NFP - Jan/2026 até Mar/2026",
    );
  } finally {
    await conn.close();
  }
});

test("marcar um mês como realizado tira ele da planilha de pendentes", async () => {
  const conn = await createTestConnection();
  try {
    await seed(conn);

    await conn.query(`
      UPDATE monthly_donor_summary
      SET abatement_status = 'applied'
      WHERE id IN ('s-maria-jan', 's-joao-jan', 's-joao-fev')
    `);

    const linhas = await pendingSheet(conn);
    const porCpf = new Map(linhas.map((linha) => [linha.cpf, linha]));

    // Joao zerou as pendências e some da planilha; Maria fica só com abril.
    assert.equal(porCpf.has("22222222222"), false);
    assert.equal(porCpf.get("11111111111").notesCount, 7);
    assert.deepEqual(porCpf.get("11111111111").referenceMonths, ["2026-04-01"]);
  } finally {
    await conn.close();
  }
});

test("a planilha de pendentes é do projeto que está apurando", async () => {
  const conn = await createTestConnection();
  try {
    await seed(conn);

    // Levar para Moradia a pendência de um doador de Capoeira abateria, no
    // destino, doação que não é daquela apuração.
    const capoeira = await pendingSheet(conn, "prj-capoeira");
    assert.deepEqual(
      capoeira.map((linha) => linha.cpf),
      ["55555555555"],
    );
    assert.equal(capoeira[0].notesCount, 11);
  } finally {
    await conn.close();
  }
});
