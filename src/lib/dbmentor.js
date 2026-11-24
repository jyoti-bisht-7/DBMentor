const API_BASE = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";
export const ACTIVE_SCHEMA_STORAGE_KEY = "dbmentor.schema";
export const PENDING_QUERY_STORAGE_KEY = "dbmentor.pending-query";

export function getPersistedSchema() {
  if (typeof window === "undefined") return null;
  try {
    const schema = JSON.parse(window.localStorage.getItem(ACTIVE_SCHEMA_STORAGE_KEY));
    return schema?.schemaId ? schema : null;
  } catch {
    return null;
  }
}

export function persistSchema(schema) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ACTIVE_SCHEMA_STORAGE_KEY, JSON.stringify(schema));
  } catch {}
}

export function parsePersistedSchema(value) {
  try {
    const schema = JSON.parse(value);
    return schema?.schemaId ? schema : null;
  } catch {
    return null;
  }
}

async function apiRequest(path, payload) {
  const response = await fetch(`${API_BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

async function apiGet(path) {
  const response = await fetch(`${API_BASE}${path}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

export function emptyResult() {
  return { columns: [], rows: [], ms: 0 };
}

export async function generateSchemaFromApi(prompt) {
  return apiRequest("/api/v1/schema/generate", { prompt });
}

export async function importSchemaDdlFromApi(ddl) {
  return apiRequest("/api/v1/schema/import-ddl", { ddl });
}

export async function getActiveSchemaFromApi() {
  return apiGet("/api/v1/schema/active");
}

export async function englishToSqlFromApi(question, schema) {
  return apiRequest("/api/v1/sql/generate", { question, schema });
}

export function explainSqlFromApi(sql, question) {
  return apiRequest("/api/v1/sql/explain", { sql, question });
}

export function executeSqlFromApi(sql, schemaId) {
  return apiRequest("/api/v1/sql/execute", { sql, schemaId });
}

export function schemaToSql(schema) {
  if (!schema?.ddl) return "";
  const schemaId = schema.schemaId;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(schemaId || "")) {
    return schema.ddl;
  }
  const databaseSchema = `dbmentor_${schemaId.replaceAll("-", "")}`;
  return `CREATE SCHEMA IF NOT EXISTS "${databaseSchema}";\nSET search_path TO "${databaseSchema}";\n\n${schema.ddl}`;
}

export function tokenizeSql(line) {
  const keywords = ["SELECT", "FROM", "INNER JOIN", "LEFT JOIN", "JOIN", "ON", "WHERE", "GROUP BY", "HAVING", "ORDER BY", "LIMIT", "AND", "OR", "DESC", "ASC", "AS", "COUNT", "SUM", "AVG", "CREATE TABLE", "PRIMARY KEY", "REFERENCES", "NOT NULL"];
  const pattern = new RegExp(`(${keywords.join("|")})|('[^']*')|(\\b\\d+(?:\\.\\d+)?\\b)|([=<>!*,;()])`, "gi");
  const tokens = [];
  let last = 0;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > last) tokens.push({ text: line.slice(last, match.index), kind: "plain" });
    const kind = match[1] ? "keyword" : match[2] ? "string" : match[3] ? "number" : match[4] ? "operator" : "plain";
    tokens.push({ text: match[0], kind });
    last = match.index + match[0].length;
  }
  if (last < line.length) tokens.push({ text: line.slice(last), kind: "plain" });
  return tokens;
}

export function sqlToEnglish(sql) {
  const match = sql?.match(/\bFROM\s+([\w.]+)/i);
  return match ? [`Querying the ${match[1]} table.`] : ["Generate a schema and query to see an explanation."];
}

function readableName(value) {
  return value.replace(/_/g, " ");
}

function tableNameForms(value) {
  const name = value.toLowerCase();
  const forms = [name];
  if (name.endsWith("ies")) forms.push(`${name.slice(0, -3)}y`);
  else if (name.endsWith("s") && !name.endsWith("ss")) forms.push(name.slice(0, -1));
  return forms;
}

function relationshipTarget(table, column, edges) {
  if (!column.name.toLowerCase().endsWith("_id")) return null;
  const columnTarget = column.name.toLowerCase().slice(0, -3);
  const incomingEdges = edges.filter((edge) => edge.to === table.name);
  return incomingEdges.find((edge) => tableNameForms(edge.from).includes(columnTarget))?.from
    || (incomingEdges.length === 1 ? incomingEdges[0].from : null);
}

function explainCardinality(label) {
  const normalized = label?.toLowerCase().replace(/\s/g, "");
  if (normalized && /^(1(?::|\.\.)n|one[-:]many)$/.test(normalized)) {
    return "One record on the first side can be linked to multiple records on the second side.";
  }
  if (normalized && /^(1(?::|\.\.)1|one[-:]one)$/.test(normalized)) {
    return "Each record on either side is linked to at most one record on the other side.";
  }
  if (normalized && /^([nm](?::|\.\.)[nm]|many[-:]many)$/.test(normalized)) {
    return "Records on either side can be linked to multiple records on the other side.";
  }
  return "The connector shows a relationship recorded between these tables.";
}

export function explainSchema(schema) {
  if (!schema?.tables?.length) return null;
  const edges = schema.edges || [];
  const source = schema.prompt?.trim()
    ? schema.prompt === "Imported from PostgreSQL DDL"
      ? "Imported from your PostgreSQL DDL"
      : `Generated from your requirement: “${schema.prompt.trim()}”`
    : "Based on the active database schema.";
  const typeDescriptions = {
    int: "whole numbers",
    text: "text",
    num: "numeric values, including decimals",
    ts: "a date and time",
    date: "a calendar date",
    fk: "an identifier used to reference another record",
  };
  const tables = schema.tables.map((table) => ({
    name: table.name,
    description: `This table stores records about ${readableName(table.name)}. Each row is one record, and its columns describe that record.`,
    columns: (table.columns || []).map((column) => {
      const key = column.key?.toLowerCase();
      const target = key === "fk" ? relationshipTarget(table, column, edges) : null;
      const keyDescription = key === "pk"
        ? "Primary key: uniquely identifies this row."
        : key === "fk"
          ? `Foreign key: stores a reference to ${target ? `a row in ${readableName(target)}` : "a row in another table"}.`
          : "Regular column: stores a detail about this record.";
      return {
        name: column.name,
        type: typeDescriptions[column.type] || `data of type ${column.type}`,
        description: keyDescription,
      };
    }),
  }));
  const relationships = edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    label: edge.label,
    description: explainCardinality(edge.label),
  }));
  return { source, summary: schema.explanation, tables, relationships };
}
