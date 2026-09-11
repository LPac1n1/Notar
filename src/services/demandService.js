import { nanoid } from "nanoid";
import {
  buildTextSearchCondition,
  executePrepared,
  queryPrepared,
} from "./db";
import { getActiveProjectId } from "./activeProject.js";
import { createActionHistoryEntry } from "./actionHistoryService";
import { reconcileAllImports } from "./importService";
import { createTrashItem } from "./trashService";
import { withCache } from "./queryCache.js";
import {
  DEFAULT_DEMAND_COLOR,
  normalizeDemandColor,
} from "../utils/demandColor";
import { normalizeDemandName } from "../utils/normalize";

// 30s TTL — demands rarely change, but Donors / People / DonorProfile
// each call listDemands() on mount to build dropdown options. The cache
// avoids re-querying the same 5-15 row table across navigation. Every
// write through executePrepared invalidates the cache globally, so the
// dropdowns refresh immediately when the user creates / edits / deletes
// a demand.
const LIST_DEMANDS_TTL_MS = 30_000;

async function _listDemandsUncached(filters = {}) {
  const { demandId = "", search = "" } = filters;
  // Demanda subdivide projeto: a lista é sempre a do projeto ativo. Um
  // doador de Capoeira não pode receber uma demanda de Moradia, e a forma
  // mais simples de garantir isso é a demanda de outro projeto nunca ser
  // oferecida.
  const conditions = ["demands.project_id = ?"];
  const params = [getActiveProjectId()];

  if (demandId.trim()) {
    conditions.push("id = ?");
    params.push(demandId.trim());
  }

  const searchCondition = buildTextSearchCondition(search, [
    { expression: "demands.name" },
  ]);

  if (searchCondition) {
    conditions.push(searchCondition.condition);
    params.push(...searchCondition.params);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const rows = await queryPrepared(
    `
      SELECT
        demands.id,
        demands.name,
        demands.color,
        demands.is_active,
        coalesce((
          SELECT count(*)
          FROM donors
          WHERE lower(trim(donors.demand)) = lower(trim(demands.name))
            AND donors.is_active = TRUE
        ), 0) AS active_donor_count,
        coalesce((
          SELECT count(*)
          FROM donors
          WHERE lower(trim(donors.demand)) = lower(trim(demands.name))
            AND donors.is_active = FALSE
        ), 0) AS inactive_donor_count
      FROM demands
      ${whereClause}
      ORDER BY demands.name ASC
    `,
    params,
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    color: normalizeDemandColor(row.color || DEFAULT_DEMAND_COLOR),
    isActive: Boolean(row.is_active),
    activeDonorCount: Number(row.active_donor_count ?? 0),
    inactiveDonorCount: Number(row.inactive_donor_count ?? 0),
  }));
}

/**
 * Demandas ativas de um projeto específico, que não precisa ser o aberto.
 *
 * `listDemands` é sempre do projeto ativo — é o que impede oferecer a um
 * doador a demanda de outro projeto. A transferência é o único lugar em que a
 * pergunta é sobre o projeto de DESTINO, que por definição não é o que está
 * aberto. Sem cache: é chamada uma vez, ao escolher o destino no modal.
 */
export async function listProjectDemands(projectId) {
  if (!projectId) {
    return [];
  }

  const rows = await queryPrepared(
    `
      SELECT id, name
      FROM demands
      WHERE project_id = ?
        AND is_active = TRUE
      ORDER BY name ASC
    `,
    [projectId],
  );

  return rows.map((row) => ({ id: row.id, name: row.name }));
}

export const listDemands = withCache(
  // A chave PRECISA cobrir todo filtro que muda o resultado. Com só o
  // `demandId`, buscas de texto diferentes colidiriam na mesma entrada e
  // devolveriam a lista de outra busca.
  //
  // O projeto ativo entra na chave pelo mesmo motivo, com uma consequência
  // pior: sem ele, trocar de projeto serviria a lista de demandas do projeto
  // anterior a partir do cache — dado de um projeto aparecendo em outro.
  (filters = {}) =>
    `listDemands:${getActiveProjectId()}:${filters?.demandId ?? ""}:${filters?.search ?? ""}`,
  _listDemandsUncached,
  LIST_DEMANDS_TTL_MS,
);

export async function createDemand({
  id = nanoid(),
  name,
  color = DEFAULT_DEMAND_COLOR,
}) {
  const trimmedName = normalizeDemandName(name);
  const normalizedColor = normalizeDemandColor(color);

  if (!trimmedName) {
    throw new Error("O nome da demanda é obrigatório.");
  }

  const projectId = getActiveProjectId();

  // A unicidade do nome é POR PROJETO desde a v13: "Cestas Básicas" pode
  // existir em Moradia e em Capoeira ao mesmo tempo sem colidir.
  const existingDemand = await queryPrepared(
    `
      SELECT id
      FROM demands
      WHERE project_id = ?
        AND lower(trim(name)) = lower(trim(?))
      LIMIT 1
    `,
    [projectId, trimmedName],
  );

  if (existingDemand.length > 0) {
    throw new Error("Já existe uma demanda cadastrada com esse nome.");
  }

  // `name` and `color` are user input (color was through a picker but the
  // payload still came from the form). Bind them via prepared parameters so
  // any future input — emojis, special chars, etc. — never touches SQL.
  await executePrepared(
    `
      INSERT INTO demands (id, project_id, name, color, is_active, updated_at)
      VALUES (?, ?, ?, ?, TRUE, CURRENT_TIMESTAMP)
    `,
    [id, projectId, trimmedName, normalizedColor],
    { source: "demands", domains: ["demands"] },
  );

  await createActionHistoryEntry({
    actionType: "create",
    entityType: "demand",
    entityId: id,
    label: trimmedName,
    description: `Demanda ${trimmedName} cadastrada.`,
    payload: {
      color: normalizedColor,
    },
  });
}

export async function updateDemand({
  id,
  name,
  color = DEFAULT_DEMAND_COLOR,
}) {
  const trimmedName = normalizeDemandName(name);
  const normalizedColor = normalizeDemandColor(color);

  if (!id) {
    throw new Error("O identificador da demanda é obrigatório.");
  }

  if (!trimmedName) {
    throw new Error("O nome da demanda é obrigatório.");
  }

  const currentDemandRows = await queryPrepared(
    `
      SELECT name
      FROM demands
      WHERE id = ?
      LIMIT 1
    `,
    [id],
  );

  if (currentDemandRows.length === 0) {
    throw new Error("A demanda selecionada não existe mais.");
  }

  const currentName = String(currentDemandRows[0].name ?? "").trim();

  // Colisão só dentro do mesmo projeto — ver `createDemand`.
  const existingDemand = await queryPrepared(
    `
      SELECT id
      FROM demands
      WHERE project_id = ?
        AND lower(trim(name)) = lower(trim(?))
        AND id <> ?
      LIMIT 1
    `,
    [getActiveProjectId(), trimmedName, id],
  );

  if (existingDemand.length > 0) {
    throw new Error("Já existe outra demanda cadastrada com esse nome.");
  }

  await executePrepared(
    `
      UPDATE demands
      SET
        name = ?,
        color = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    [trimmedName, normalizedColor, id],
    { source: "demands", domains: ["demands"] },
  );

  await executePrepared(
    `
      UPDATE donors
      SET
        demand = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE lower(trim(demand)) = lower(trim(?))
    `,
    [trimmedName, currentName],
    { source: "demands", domains: ["demands", "donors"] },
  );

  await reconcileAllImports();

  await createActionHistoryEntry({
    actionType: "update",
    entityType: "demand",
    entityId: id,
    label: trimmedName,
    description: `Demanda ${currentName} atualizada para ${trimmedName}.`,
    payload: {
      color: normalizedColor,
      previousName: currentName,
    },
  });
}

export async function deleteDemand(id) {
  const demandRows = await queryPrepared(
    `
    SELECT
      id,
      name,
      color,
      is_active,
      CAST(created_at AS VARCHAR) AS created_at,
      CAST(updated_at AS VARCHAR) AS updated_at
    FROM demands
    WHERE id = ?
    LIMIT 1
  `,
    [id],
  );

  if (demandRows.length === 0) {
    return;
  }

  const linkedDonors = await queryPrepared(
    `
    SELECT id
    FROM donors
    WHERE lower(trim(demand)) = lower(trim((
      SELECT name
      FROM demands
      WHERE id = ?
      LIMIT 1
    )))
    LIMIT 1
  `,
    [id],
  );

  if (linkedDonors.length > 0) {
    throw new Error("Não é possível remover uma demanda vinculada a doadores.");
  }

  const trashItemId = await createTrashItem({
    entityType: "demand",
    entityId: id,
    label: demandRows[0].name,
    payload: {
      demands: demandRows,
    },
  });

  await executePrepared(
    `
      DELETE FROM demands
      WHERE id = ?
    `,
    [id],
    { source: "demands", domains: ["demands", "trash"] },
  );

  await createActionHistoryEntry({
    actionType: "delete",
    entityType: "demand",
    entityId: id,
    label: demandRows[0].name,
    description: `Demanda ${demandRows[0].name} enviada para a lixeira.`,
    payload: {
      trashItemId,
    },
  });

  return trashItemId;
}
