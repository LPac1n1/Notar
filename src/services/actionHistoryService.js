import { nanoid } from "nanoid";
import { executePrepared, queryPrepared } from "./db";

function parsePayload(value) {
  if (!value) {
    return {};
  }

  try {
    const parsedPayload = JSON.parse(value);
    return parsedPayload && typeof parsedPayload === "object"
      ? parsedPayload
      : {};
  } catch {
    return {};
  }
}

function mapActionHistoryRow(row) {
  return {
    id: row.id,
    actionType: row.action_type ?? "",
    entityType: row.entity_type ?? "",
    entityId: row.entity_id ?? "",
    label: row.label ?? "",
    description: row.description ?? "",
    payload: parsePayload(row.payload_json),
    createdAt: row.created_at ?? "",
  };
}

export async function createActionHistoryEntry({
  id = nanoid(),
  actionType,
  entityType,
  entityId = "",
  label = "",
  description = "",
  payload = {},
}, { scheduleSync = true } = {}) {
  if (!actionType || !entityType) {
    return "";
  }

  // `label`, `description`, and the JSON payload include user-derived strings
  // (donor names, demand titles, error messages, etc.). Bind everything via
  // prepared parameters so the SQL boundary is air-tight.
  await executePrepared(
    `
      INSERT INTO action_history (
        id,
        action_type,
        entity_type,
        entity_id,
        label,
        description,
        payload_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `,
    [
      id,
      actionType,
      entityType,
      entityId,
      label,
      description,
      JSON.stringify(payload ?? {}),
    ],
    { source: "history", domains: ["history"], scheduleSync },
  );

  return id;
}

/**
 * Shared WHERE-clause builder for `listActionHistory`/`countActionHistory`.
 * The label search matches against user-typed free text in the History
 * page, so it's bound as a parameter — including any literal `%`/`_` the
 * user types, which is treated as plain text rather than a LIKE wildcard.
 */
function buildActionHistoryFilters({ actionType = "", entityType = "", label = "" }) {
  const conditions = [];
  const params = [];

  if (actionType.trim()) {
    conditions.push("action_type = ?");
    params.push(actionType.trim());
  }

  if (entityType.trim()) {
    conditions.push("entity_type = ?");
    params.push(entityType.trim());
  }

  if (label.trim()) {
    conditions.push("(lower(label) LIKE lower(?) OR lower(description) LIKE lower(?))");
    const labelPattern = `%${label.trim()}%`;
    params.push(labelPattern, labelPattern);
  }

  return { conditions, params };
}

/**
 * Paginated action history. `limit`/`offset` used to be a single hardcoded
 * `limit: 100` with client-side pagination on top — searching for something
 * older than the 100 most recent actions would silently find nothing, with
 * no way to page further back. Now a real server-side page: the WHERE
 * clause (including the free-text search) is evaluated before LIMIT/OFFSET,
 * so a search can reach the full history, not just the most recent slice.
 */
export async function listActionHistory({
  actionType = "",
  entityType = "",
  label = "",
  limit = 25,
  offset = 0,
} = {}) {
  const { conditions, params } = buildActionHistoryFilters({
    actionType,
    entityType,
    label,
  });
  const normalizedLimit = Math.min(Math.max(Number(limit) || 25, 1), 200);
  const normalizedOffset = Math.max(Number(offset) || 0, 0);

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // `LIMIT`/`OFFSET` are integer literals here, not user-supplied —
  // both are clamped above.
  const rows = await queryPrepared(
    `
      SELECT
        id,
        action_type,
        entity_type,
        entity_id,
        label,
        description,
        payload_json,
        strftime(created_at, '%Y-%m-%d %H:%M:%S') AS created_at
      FROM action_history
      ${whereClause}
      ORDER BY created_at DESC, id DESC
      LIMIT ${normalizedLimit} OFFSET ${normalizedOffset}
    `,
    params,
  );

  return rows.map(mapActionHistoryRow);
}

export async function countActionHistory({
  actionType = "",
  entityType = "",
  label = "",
} = {}) {
  const { conditions, params } = buildActionHistoryFilters({
    actionType,
    entityType,
    label,
  });
  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await queryPrepared(
    `SELECT count(*) AS total FROM action_history ${whereClause}`,
    params,
  );

  return Number(rows[0]?.total ?? 0);
}
