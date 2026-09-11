import { nanoid } from "nanoid";
import {
  executePrepared,
  query,
  queryPrepared,
  runInTransaction,
  startOfMonth,
} from "./db";
import { reconcileImportsForCpfs } from "./import/importReconcile";
import { createActionHistoryEntry } from "./actionHistoryService";
import { createTrashItem } from "./trashService";
import { buildSlug } from "../utils/slug";
import {
  ASSIGNMENT_OPEN_END,
  ASSIGNMENT_OPEN_START,
  COUNT_DONORS_WITHOUT_PROJECT_SQL,
  DONORS_WITHOUT_PROJECT_SQL,
  CREDIT_BY_PROJECT_SQL,
  DEFAULT_PROJECT_COLOR,
  DEFAULT_PROJECT_ID,
  MODULE_DEPENDENCIES,
  NEW_PROJECT_MODULES,
} from "./project/projectAssignmentSql.js";

/**
 * Projetos e o vínculo doador → projeto.
 *
 * O projeto não parte os dados: importação, conciliação e base de doações
 * continuam sendo uma só. O que existe aqui é a DIMENSÃO DE ATRIBUIÇÃO — a
 * regra que decide para qual projeto o crédito de cada nota vai, a partir do
 * vínculo vigente no mês DA NOTA.
 */

function parseModules(value) {
  if (!value) return { ...NEW_PROJECT_MODULES };

  try {
    return { ...NEW_PROJECT_MODULES, ...JSON.parse(String(value)) };
  } catch {
    // Um JSON corrompido não pode derrubar a listagem de projetos — cair no
    // conjunto mínimo mantém o projeto acessível para o usuário corrigi-lo.
    return { ...NEW_PROJECT_MODULES };
  }
}

function mapProjectRow(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    modules: parseModules(row.modules),
    color: row.color ?? "",
    displayOrder: Number(row.display_order ?? 0),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at ?? "",
  };
}

// As sentinelas de vigência nunca chegam à interface: viram null aqui, e a UI
// mostra "desde o início" / "vigente".
function mapAssignmentRow(row) {
  const validFrom = String(row.valid_from ?? "").slice(0, 10);
  const validTo = String(row.valid_to ?? "").slice(0, 10);

  return {
    id: row.id,
    donorId: row.donor_id,
    projectId: row.project_id,
    projectName: row.project_name ?? "",
    validFrom: validFrom === ASSIGNMENT_OPEN_START ? null : validFrom,
    validTo: validTo === ASSIGNMENT_OPEN_END ? null : validTo,
    isOpen: validTo === ASSIGNMENT_OPEN_END,
    reason: row.reason ?? "",
  };
}

/**
 * Slug a partir do nome. Serve de identificador na URL, então precisa ser
 * estável e legível — e único, garantido por índice.
 */
function buildProjectSlug(name) {
  return buildSlug(name) || "projeto";
}

async function resolveAvailableSlug(baseSlug, ignoreProjectId = "") {
  const rows = await queryPrepared(
    `SELECT slug FROM projects WHERE slug LIKE ? AND id <> ?`,
    [`${baseSlug}%`, ignoreProjectId],
  );
  const taken = new Set(rows.map((row) => String(row.slug)));

  if (!taken.has(baseSlug)) return baseSlug;

  // Dois projetos podem legitimamente ter nomes que geram o mesmo slug
  // ("Capoeira" e "capoeira"). Sufixo numérico em vez de recusar o nome.
  for (let suffix = 2; suffix < 500; suffix += 1) {
    const candidate = `${baseSlug}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }

  throw new Error("Não foi possível gerar um endereço único para este projeto.");
}

export async function createProject({ name, color = DEFAULT_PROJECT_COLOR }) {
  const trimmedName = String(name ?? "").trim();

  if (!trimmedName) {
    throw new Error("O nome do projeto é obrigatório.");
  }

  const duplicate = await queryPrepared(
    `SELECT id FROM projects WHERE lower(trim(name)) = lower(trim(?)) LIMIT 1`,
    [trimmedName],
  );

  if (duplicate.length > 0) {
    throw new Error("Já existe um projeto com esse nome.");
  }

  const id = nanoid();
  const slug = await resolveAvailableSlug(buildProjectSlug(trimmedName));
  // No fim da lista: inserir no meio moveria os cards que o usuário já tinha
  // posicionado, e ele não pediu isso.
  const orderRows = await query(
    `SELECT coalesce(max(display_order), 0) + 1 AS proxima FROM projects`,
  );
  const displayOrder = Number(orderRows[0]?.proxima ?? 1);

  // Projeto novo nasce com o conjunto mínimo: ver o crédito gerado pelos
  // doadores dele, e ter onde registrar contexto. Os demais módulos são
  // ligados depois, se fizerem falta.
  await executePrepared(
    `
    INSERT INTO projects (id, name, slug, modules, color, display_order, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `,
    [id, trimmedName, slug, JSON.stringify(NEW_PROJECT_MODULES), color, displayOrder],
    { source: "projects", domains: ["projects"] },
  );

  await createActionHistoryEntry({
    actionType: "create",
    entityType: "project",
    entityId: id,
    label: trimmedName,
    description: `Projeto ${trimmedName} criado.`,
    payload: { slug },
  });

  return { id, slug };
}

export async function updateProject({ id, name, color, modules }) {
  if (!id) {
    throw new Error("O identificador do projeto é obrigatório.");
  }

  const trimmedName = String(name ?? "").trim();

  if (!trimmedName) {
    throw new Error("O nome do projeto é obrigatório.");
  }

  const duplicate = await queryPrepared(
    `SELECT id FROM projects WHERE lower(trim(name)) = lower(trim(?)) AND id <> ? LIMIT 1`,
    [trimmedName, id],
  );

  if (duplicate.length > 0) {
    throw new Error("Já existe outro projeto com esse nome.");
  }

  const current = await findProjectById(id);

  if (!current) {
    throw new Error("O projeto selecionado não existe mais.");
  }

  // O slug muda junto com o nome — ele é o endereço, e um endereço que não
  // corresponde ao nome confunde mais do que a quebra de links antigos, que
  // já é tratada pelo redirecionamento da tela de escolha.
  const slug =
    trimmedName === current.name
      ? current.slug
      : await resolveAvailableSlug(buildProjectSlug(trimmedName), id);

  await executePrepared(
    `
    UPDATE projects
    SET name = ?, slug = ?, color = ?, modules = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
    [
      trimmedName,
      slug,
      color ?? current.color,
      JSON.stringify(resolveModuleDependencies(modules ?? current.modules)),
      id,
    ],
    { source: "projects", domains: ["projects"] },
  );

  await createActionHistoryEntry({
    actionType: "update",
    entityType: "project",
    entityId: id,
    label: trimmedName,
    description: `Projeto ${trimmedName} atualizado.`,
    payload: { slug },
  });

  return { id, slug };
}

/**
 * Exclui um projeto.
 *
 * Duas travas, e as duas existem para proteger o histórico:
 *
 * 1. O projeto padrão nunca é excluído. Ele é o destino do backfill e a casa
 *    de todo doador que não foi transferido para lugar nenhum.
 * 2. Projeto com QUALQUER vínculo — inclusive fechado — não pode ser
 *    excluído. Um vínculo fechado é o que mantém o crédito de 2025 somando
 *    para o projeto de 2025; apagar o projeto reescreveria esse passado, que
 *    é exatamente o que a regra de negócio proíbe.
 */
export async function deleteProject(id) {
  if (id === DEFAULT_PROJECT_ID) {
    throw new Error(
      "O projeto principal não pode ser excluído — ele é o destino padrão dos doadores.",
    );
  }

  const project = await findProjectById(id);

  if (!project) return "";

  const assignmentRows = await queryPrepared(
    `SELECT count(*) AS total FROM donor_project_assignments WHERE project_id = ?`,
    [id],
  );
  const assignmentCount = Number(assignmentRows[0]?.total ?? 0);

  if (assignmentCount > 0) {
    throw new Error(
      `Este projeto tem ${assignmentCount} vínculo(s) de doador, inclusive históricos. Transfira os doadores para outro projeto antes de excluir — apagar agora mudaria a atribuição do crédito já registrado.`,
    );
  }

  const demandRows = await queryPrepared(
    `
    SELECT id, project_id, name, color, is_active,
           CAST(created_at AS VARCHAR) AS created_at,
           CAST(updated_at AS VARCHAR) AS updated_at
    FROM demands WHERE project_id = ?
  `,
    [id],
  );
  const projectRows = await queryPrepared(
    `
    SELECT id, name, slug, modules, color, is_active,
           CAST(created_at AS VARCHAR) AS created_at,
           CAST(updated_at AS VARCHAR) AS updated_at
    FROM projects WHERE id = ?
  `,
    [id],
  );
  let trashItemId = "";

  await runInTransaction(
    async () => {
      trashItemId = await createTrashItem({
        entityType: "project",
        entityId: id,
        label: project.name,
        payload: { projects: projectRows, demands: demandRows },
      });

      await executePrepared(`DELETE FROM demands WHERE project_id = ?`, [id]);
      await executePrepared(`DELETE FROM projects WHERE id = ?`, [id]);
    },
    { source: "projects", domains: ["projects", "demands", "trash"] },
  );

  await createActionHistoryEntry({
    actionType: "delete",
    entityType: "project",
    entityId: id,
    label: project.name,
    description: `Projeto ${project.name} enviado para a lixeira.`,
    payload: { trashItemId },
  });

  return trashItemId;
}

export async function listProjects({ activeStatus = "active" } = {}) {
  const conditions = [];
  const params = [];

  if (activeStatus === "active") {
    conditions.push("is_active = TRUE");
  } else if (activeStatus === "archived") {
    conditions.push("is_active = FALSE");
  }

  const rows = await queryPrepared(
    `
    SELECT id, name, slug, modules, color, is_active, display_order,
           CAST(created_at AS VARCHAR) AS created_at
    FROM projects
    ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
    -- Ordem escolhida pelo usuário. O nome entra como desempate para que uma
    -- ordem ausente (projeto recém-criado) não deixe a lista instável entre
    -- carregamentos.
    ORDER BY coalesce(display_order, 999999) ASC, name ASC
  `,
    params,
  );

  return rows.map(mapProjectRow);
}

export async function findProjectById(projectId) {
  const rows = await queryPrepared(
    `
    SELECT id, name, slug, modules, color, is_active,
           CAST(created_at AS VARCHAR) AS created_at
    FROM projects
    WHERE id = ?
    LIMIT 1
  `,
    [projectId],
  );

  return rows.length ? mapProjectRow(rows[0]) : null;
}

/**
 * Resolve as dependências entre módulos antes de gravar.
 *
 * Gestão Mensal sem Demandas seria um estado que a interface não sabe
 * representar (a demanda é obrigatória no cadastro do doador). Em vez de
 * recusar a combinação e obrigar o usuário a descobrir a ordem certa de
 * cliques, as dependências são LIGADAS junto.
 */
export function resolveModuleDependencies(modules) {
  const resolved = { ...NEW_PROJECT_MODULES, ...modules };

  for (const [moduleKey, requiredKeys] of Object.entries(MODULE_DEPENDENCIES)) {
    if (!resolved[moduleKey]) continue;

    for (const requiredKey of requiredKeys) {
      resolved[requiredKey] = true;
    }
  }

  return resolved;
}

export async function listDonorAssignments(donorId) {
  const rows = await queryPrepared(
    `
    SELECT
      dpa.id,
      dpa.donor_id,
      dpa.project_id,
      projects.name AS project_name,
      CAST(dpa.valid_from AS VARCHAR) AS valid_from,
      CAST(dpa.valid_to AS VARCHAR) AS valid_to,
      dpa.reason
    FROM donor_project_assignments AS dpa
    LEFT JOIN projects ON projects.id = dpa.project_id
    WHERE dpa.donor_id = ?
    ORDER BY dpa.valid_from ASC
  `,
    [donorId],
  );

  return rows.map(mapAssignmentRow);
}

// Um vínculo com a vigência já resolvida. Compartilhado pelo cadastro, pela
// transferência e pelo vínculo manual, para os três gravarem a mesma forma.
const INSERT_ASSIGNMENT_SQL = `
    INSERT INTO donor_project_assignments
      (id, donor_id, project_id, valid_from, valid_to, reason, created_at)
    VALUES (?, ?, ?, CAST(? AS DATE), CAST(? AS DATE), ?, CURRENT_TIMESTAMP)
  `;

/**
 * Primeiro vínculo de um doador — usado no cadastro.
 *
 * `valid_from` na sentinela de início por padrão: sem isso, uma planilha
 * retroativa anterior ao cadastro geraria crédito não atribuído para um
 * doador que sempre pertenceu ao projeto.
 */
export async function assignDonorToProject({
  donorId,
  projectId = DEFAULT_PROJECT_ID,
  validFrom = "",
  reason = "inicial",
}) {
  if (!donorId) {
    throw new Error("O doador é obrigatório para criar o vínculo.");
  }

  await executePrepared(
    INSERT_ASSIGNMENT_SQL,
    [
      nanoid(),
      donorId,
      projectId,
      validFrom ? startOfMonth(validFrom) : ASSIGNMENT_OPEN_START,
      ASSIGNMENT_OPEN_END,
      reason,
    ],
    { source: "projects", domains: ["projects", "donors"] },
  );
}

/**
 * A demanda que o doador leva para o projeto de destino.
 *
 * Projeto que classifica por demanda não sabe exibir doador sem uma: a Gestão
 * Mensal agrupa, filtra e gera relatório e planilha por ela, e o doador
 * transferido chegava lá como "Demanda: Não informada". Por isso ela é exigida
 * na própria transferência — e tem de ser uma demanda ativa DO DESTINO, porque
 * a do projeto de origem não existe lá.
 *
 * Devolve `null` quando o destino não usa demandas. Nesse caso a demanda do
 * doador fica como está: os meses que continuam no projeto de origem ainda a
 * exibem, e apagá-la reescreveria o passado de lá.
 */
async function resolveDestinationDemand(project, demand) {
  if (project.modules?.demands === false) {
    return null;
  }

  const trimmedDemand = String(demand ?? "").trim();

  if (!trimmedDemand) {
    throw new Error(`Selecione a demanda do doador em ${project.name}.`);
  }

  const rows = await queryPrepared(
    `
    SELECT name
    FROM demands
    WHERE project_id = ?
      AND is_active = TRUE
      AND lower(trim(name)) = lower(trim(?))
    LIMIT 1
  `,
    [project.id, trimmedDemand],
  );

  if (rows.length === 0) {
    throw new Error(`A demanda selecionada não existe em ${project.name}.`);
  }

  return rows[0].name;
}

async function setDonorDemand(donorId, demandName) {
  await executePrepared(
    `
    UPDATE donors
    SET demand = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
    [demandName, donorId],
  );
}

/**
 * Refaz os resumos mensais do doador depois de trocar a demanda.
 *
 * A Gestão Mensal não lê a demanda da ficha do doador: lê a cópia gravada no
 * resumo mensal quando a importação é reconciliada. Sem refazer, a demanda
 * nova só apareceria na próxima importação — e até lá o doador continuaria
 * como "Não informada", fora do filtro e do relatório da demanda escolhida.
 */
async function refreshDonorMonthlySummaries(donorId) {
  const rows = await queryPrepared(
    `
    SELECT cpf
    FROM donor_cpf_links
    WHERE donor_id = ?
      AND is_active = TRUE
  `,
    [donorId],
  );

  await reconcileImportsForCpfs(rows.map((row) => row.cpf));
}

/**
 * Vincula, pela ficha do doador, quem não tem vínculo nenhum.
 *
 * Mesma abertura de `assignDonorToProject` — desde o início do histórico, para
 * o crédito passado também contar —, mais a demanda do destino, pelo mesmo
 * motivo da transferência. Fica separada porque `assignDonorToProject` roda
 * dentro da transação do cadastro, onde a demanda já foi validada.
 */
export async function assignUnlinkedDonorToProject({
  donorId,
  projectId,
  demand = "",
}) {
  if (!donorId) {
    throw new Error("O doador é obrigatório para criar o vínculo.");
  }

  if (!projectId) {
    throw new Error("Selecione o projeto de destino.");
  }

  const project = await findProjectById(projectId);

  if (!project) {
    throw new Error("O projeto de destino não existe mais.");
  }

  const demandName = await resolveDestinationDemand(project, demand);

  await runInTransaction(
    async () => {
      await executePrepared(INSERT_ASSIGNMENT_SQL, [
        nanoid(),
        donorId,
        projectId,
        ASSIGNMENT_OPEN_START,
        ASSIGNMENT_OPEN_END,
        "vinculo-manual",
      ]);

      if (demandName !== null) {
        await setDonorDemand(donorId, demandName);
      }
    },
    // `runInTransaction` lê `changeSource`/`changeDomains`. Com `source`/
    // `domains` (as chaves do `executePrepared`) as opções eram ignoradas em
    // silêncio e o evento saía como "transaction", sem domínio.
    {
      changeSource: "projects",
      changeDomains: ["projects", "donors", "monthly"],
    },
  );

  if (demandName !== null) {
    await refreshDonorMonthlySummaries(donorId);
  }
}

/**
 * Meses em que o doador teve nota válida, do mais antigo ao mais recente, em
 * `AAAA-MM`.
 *
 * A transferência usa a lista para sugerir o mês e para dizer, antes de
 * confirmar, quais doações mudam de projeto e quais ficam. Mesmos filtros da
 * descoberta do início das doações: importação que não foi processada e linha
 * só com nota inválida não contam.
 */
export async function listDonorDonationMonths(donorId) {
  if (!donorId) {
    return [];
  }

  const rows = await queryPrepared(
    `
    SELECT DISTINCT strftime(import_cpf_summary.reference_month, '%Y-%m') AS month
    FROM import_cpf_summary
    INNER JOIN donor_cpf_links
      ON donor_cpf_links.cpf = import_cpf_summary.cpf
      AND donor_cpf_links.is_active = TRUE
    INNER JOIN imports
      ON imports.id = import_cpf_summary.import_id
    WHERE donor_cpf_links.donor_id = ?
      AND import_cpf_summary.notes_count > 0
      AND imports.status = 'processed'
    ORDER BY month ASC
  `,
    [donorId],
  );

  return rows.map((row) => String(row.month));
}

/**
 * Transfere um doador para outro projeto a partir de um mês.
 *
 * Esta é a operação que protege o histórico: ela FECHA a janela anterior no
 * mês anterior ao efetivo e ABRE uma nova — nunca reescreve o `project_id` do
 * vínculo existente. As doações já consolidadas continuam somando para o
 * projeto antigo porque a janela fechada nunca mais é tocada.
 *
 * Quando o destino classifica por demanda, a demanda é obrigatória e é
 * gravada na mesma transação — ver `resolveDestinationDemand`.
 */
export async function transferDonorToProject({
  donorId,
  projectId,
  effectiveMonth,
  demand = "",
}) {
  const normalizedMonth = startOfMonth(effectiveMonth);

  if (!normalizedMonth) {
    throw new Error("Informe o mês a partir do qual a transferência vale.");
  }

  if (!projectId) {
    throw new Error("Selecione o projeto de destino.");
  }

  const project = await findProjectById(projectId);

  if (!project) {
    throw new Error("O projeto de destino não existe mais.");
  }

  const openRows = await queryPrepared(
    `
    SELECT id, project_id, CAST(valid_from AS VARCHAR) AS valid_from
    FROM donor_project_assignments
    WHERE donor_id = ?
      AND valid_to = CAST(? AS DATE)
    LIMIT 1
  `,
    [donorId, ASSIGNMENT_OPEN_END],
  );

  const current = openRows[0] ?? null;

  if (current && current.project_id === projectId) {
    throw new Error("O doador já pertence a este projeto.");
  }

  if (current && String(current.valid_from).slice(0, 10) >= normalizedMonth) {
    throw new Error(
      "A transferência precisa ser posterior ao início do vínculo atual. Para corrigir o vínculo em si, use a correção retroativa.",
    );
  }

  const demandName = await resolveDestinationDemand(project, demand);

  await runInTransaction(
    async () => {
      if (current) {
        // Fecha no mês ANTERIOR ao efetivo: `valid_to` é inclusivo, então
        // fechar no próprio mês faria o mês da transferência pertencer aos
        // dois projetos — vigência sobreposta, crédito contado em dobro.
        await executePrepared(
          `
          UPDATE donor_project_assignments
          SET valid_to = (CAST(? AS DATE) - INTERVAL 1 MONTH)
          WHERE id = ?
        `,
          [normalizedMonth, current.id],
        );
      }

      await executePrepared(INSERT_ASSIGNMENT_SQL, [
        nanoid(),
        donorId,
        projectId,
        normalizedMonth,
        ASSIGNMENT_OPEN_END,
        "transferencia",
      ]);

      if (demandName !== null) {
        await setDonorDemand(donorId, demandName);
      }
    },
    // `runInTransaction` lê `changeSource`/`changeDomains`. Com `source`/
    // `domains` (as chaves do `executePrepared`) as opções eram ignoradas em
    // silêncio e o evento saía como "transaction", sem domínio.
    {
      changeSource: "projects",
      changeDomains: ["projects", "donors", "monthly"],
    },
  );

  if (demandName !== null) {
    await refreshDonorMonthlySummaries(donorId);
  }
}

/** Crédito conciliado por projeto e mês. `projectId` nulo = não atribuído. */
export async function listCreditByProject() {
  const rows = await query(CREDIT_BY_PROJECT_SQL);

  return rows.map((row) => ({
    projectId: row.project_id ?? null,
    referenceMonth: row.reference_month,
    totalCredit: Number(row.total_credit ?? 0),
  }));
}

/**
 * Um resumo por projeto para a tela de escolha.
 *
 * A tela de abertura é a escolha E o painel: se ela só listasse nomes, seria
 * pedágio. Com os números, abrir o sistema já responde "como estão as coisas"
 * antes de entrar em qualquer lugar.
 */
export async function listProjectSummaries() {
  const [projects, creditRows, donorRows] = await Promise.all([
    listProjects({ activeStatus: "active" }),
    listCreditByProject(),
    queryPrepared(
      `
      SELECT dpa.project_id AS project_id, count(DISTINCT donors.id) AS donor_count
      FROM donor_project_assignments AS dpa
      INNER JOIN donors ON donors.id = dpa.donor_id
      WHERE donors.is_active = TRUE
        AND dpa.valid_to = CAST(? AS DATE)
      GROUP BY dpa.project_id
    `,
      [ASSIGNMENT_OPEN_END],
    ),
  ]);

  const donorCounts = new Map(
    donorRows.map((row) => [row.project_id, Number(row.donor_count ?? 0)]),
  );
  const totals = new Map();
  const latestMonths = new Map();

  for (const row of creditRows) {
    if (!row.projectId) continue;

    totals.set(row.projectId, (totals.get(row.projectId) ?? 0) + row.totalCredit);

    const current = latestMonths.get(row.projectId) ?? "";
    if (row.referenceMonth > current) {
      latestMonths.set(row.projectId, row.referenceMonth);
    }
  }

  const unattributedCredit = creditRows
    .filter((row) => !row.projectId)
    .reduce((sum, row) => sum + row.totalCredit, 0);

  return {
    projects: projects.map((project) => ({
      ...project,
      totalCredit: totals.get(project.id) ?? 0,
      donorCount: donorCounts.get(project.id) ?? 0,
      latestCreditMonth: latestMonths.get(project.id) ?? "",
    })),
    // Crédito de doador sem vínculo vigente. Some da conta de todo projeto,
    // então precisa aparecer aqui ou vira dinheiro invisível.
    unattributedCredit,
  };
}

/**
 * Doadores que não aparecem em projeto nenhum — inclusive os que têm vínculo
 * com um projeto já excluído. Ver DONORS_WITHOUT_PROJECT_SQL.
 */
export async function countDonorsWithoutProject() {
  const rows = await query(COUNT_DONORS_WITHOUT_PROJECT_SQL);

  return Number(rows[0]?.total ?? 0);
}

/**
 * Religa um doador que não pertence a nenhum projeto existente.
 *
 * Não é um INSERT simples. O caso que realmente chega aqui é o do vínculo
 * pendurado — a linha existe e está aberta, só aponta para um projeto que foi
 * excluído. Inserir outra linha aberta esbarra no índice único que garante um
 * vínculo vigente por doador, e a operação falhava com erro de constraint.
 *
 * Por isso as janelas penduradas são REAPONTADAS em vez de recriadas: isso
 * preserva desde quando o doador está vinculado, que é justamente o dado que
 * decide a atribuição do crédito de meses passados.
 */
export async function linkDonorToProject({ donorId, projectId }) {
  if (!donorId) {
    throw new Error(`O doador é obrigatório.`);
  }

  if (!projectId) {
    throw new Error(`Selecione o projeto de destino.`);
  }

  const dangling = await queryPrepared(
    `
    SELECT dpa.id
    FROM donor_project_assignments AS dpa
    LEFT JOIN projects ON projects.id = dpa.project_id
    WHERE dpa.donor_id = ?
      AND projects.id IS NULL
  `,
    [donorId],
  );

  if (dangling.length === 0) {
    // Doador sem vínculo nenhum: abre desde o início do histórico, para que
    // o crédito passado dele também passe a contar para o projeto.
    await assignDonorToProject({
      donorId,
      projectId,
      reason: "vinculo-manual",
    });
    return;
  }

  await executePrepared(
    `
    UPDATE donor_project_assignments
    SET project_id = ?, reason = 'vinculo-manual'
    WHERE donor_id = ?
      AND NOT EXISTS (SELECT 1 FROM projects WHERE projects.id = donor_project_assignments.project_id)
  `,
    [projectId, donorId],
    { source: "projects", domains: ["projects", "donors", "monthly"] },
  );
}
export async function listDonorsWithoutProject() {
  const rows = await query(DONORS_WITHOUT_PROJECT_SQL);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    cpf: row.cpf,
  }));
}

/**
 * Troca de posição um projeto com o vizinho.
 *
 * A troca é de PARES, e não uma renumeração da lista inteira: mexer só nas
 * duas linhas envolvidas mantém a operação barata e evita reescrever a
 * ordem de projetos que o usuário não tocou.
 *
 * As duas escritas vão na mesma transação — se a segunda falhasse sozinha,
 * os dois projetos ficariam com a mesma posição e a lista passaria a
 * depender do desempate por nome, mudando de ordem sem o usuário pedir.
 */
export async function moveProject(projectId, direction) {
  const ordered = await listProjects({ activeStatus: "active" });
  const index = ordered.findIndex((project) => project.id === projectId);

  if (index === -1) return;

  const targetIndex = direction === "up" ? index - 1 : index + 1;

  // Já está na ponta: nada a fazer, e a interface desabilita o botão.
  if (targetIndex < 0 || targetIndex >= ordered.length) return;

  const current = ordered[index];
  const neighbour = ordered[targetIndex];

  await runInTransaction(
    async () => {
      await executePrepared(
        `UPDATE projects SET display_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [targetIndex + 1, current.id],
      );
      await executePrepared(
        `UPDATE projects SET display_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [index + 1, neighbour.id],
      );
    },
    { source: "projects", domains: ["projects"] },
  );
}
