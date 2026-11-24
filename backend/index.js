import cors from "cors";
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { parse as parsePostgresSql, toSql } from "pgsql-ast-parser";
import pg from "pg";

const app = express();
const port = Number(process.env.PORT || 8000);
const nlpUrl = process.env.NLP_URL || "http://127.0.0.1:8001";
const nlpTimeoutMs = Number(process.env.NLP_TIMEOUT_MS || 300_000);
const logLevels = { debug: 10, info: 20, warn: 30, error: 40 };
const configuredLogLevel = process.env.LOG_LEVEL?.toLowerCase() || "info";
const minimumLogLevel = logLevels[configuredLogLevel] ? configuredLogLevel : "info";
const { Pool } = pg;
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined })
  : null;
const schemaRegistry = '"dbmentor_generated_schemas"';

function log(level, message, fields = {}) {
  if (logLevels[level] < logLevels[minimumLogLevel]) return;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: "dbmentor-api",
    message,
    ...fields,
  };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

function errorFields(error) {
  return {
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  };
}

if (pool) {
  pool.on("error", (error) => log("error", "Unexpected PostgreSQL pool error", errorFields(error)));
}

app.use(cors({ origin: process.env.FRONTEND_ORIGIN?.split(",") || true }));
app.use(express.json({ limit: "2mb" }));

app.use((request, response, next) => {
  const requestId = request.get("x-request-id") || randomUUID();
  const started = performance.now();
  response.setHeader("x-request-id", requestId);
  response.on("finish", () => {
    const durationMs = Number((performance.now() - started).toFixed(1));
    log(response.statusCode >= 500 ? "error" : response.statusCode >= 400 ? "warn" : "info", "HTTP request completed", {
      requestId,
      method: request.method,
      path: request.path,
      status: response.statusCode,
      durationMs,
      userAgent: request.get("user-agent") || undefined,
    });
  });
  request.requestId = requestId;
  next();
});

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    const error = new Error(`${field} must be a non-empty string`);
    error.status = 400;
    throw error;
  }
  return value.trim();
}

async function nlp(task, payload) {
  const started = performance.now();
  try {
    const response = await fetch(`${nlpUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task, ...payload }),
      signal: AbortSignal.timeout(nlpTimeoutMs),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "NLP service failed");
    log("debug", "NLP request completed", { task, status: response.status, durationMs: Number((performance.now() - started).toFixed(1)), timeoutMs: nlpTimeoutMs });
    return body;
  } catch (error) {
    log("error", "NLP request failed", { task, durationMs: Number((performance.now() - started).toFixed(1)), timeoutMs: nlpTimeoutMs, ...errorFields(error) });
    if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
      throw Object.assign(new Error(`NLP service at ${nlpUrl} is unreachable. Start backend/nlp-service.py and check that it remains running while loading the SQL model.`), { status: 503, cause: error });
    }
    throw error;
  }
}

function parseSql(sql) {
  const clean = sql.replace(/\s+/g, " ").trim();
  const section = (name, stops) => {
    const match = clean.match(new RegExp(`${name}\\s+([\\s\\S]*?)(?=\\s+(?:${stops.join("|")})\\b|;|$)`, "i"));
    return match?.[1]?.trim() || null;
  };
  const stops = ["FROM", "JOIN", "WHERE", "GROUP BY", "HAVING", "ORDER BY", "LIMIT"];
  const joins = [...clean.matchAll(/(LEFT\s+JOIN|INNER\s+JOIN|JOIN)\s+([\w.]+)(?:\s+(?:AS\s+)?(?!ON\b)(\w+))?\s+ON\s+([^\s=]+)\s*=\s*([^\s;]+)/gi)]
    .map((match) => ({ kind: match[1].toLowerCase(), table: match[2], alias: match[3] || match[2], left: match[4], right: match[5] }));
  return {
    select: section("SELECT", stops),
    from: section("FROM", stops),
    where: section("WHERE", stops),
    groupBy: section("GROUP BY", stops),
    orderBy: section("ORDER BY", stops),
    limit: section("LIMIT", stops),
    joins,
  };
}

function optimize(sql) {
  const parsed = parseSql(sql);
  const hints = [];
  if (parsed.select === "*") hints.push({ tone: "amber", title: "Replace SELECT * with named columns", note: "less I/O per row and index-only scans become possible" });
  for (const join of parsed.joins) hints.push({ tone: "mint", title: `Index ${join.right}`, note: `turns the join on ${join.table} into an index lookup` });
  if (parsed.where && /like\s+'%/i.test(parsed.where)) hints.push({ tone: "rose", title: "Leading-wildcard LIKE", note: "a trigram index (pg_trgm) can rescue this scan" });
  if (parsed.orderBy && !parsed.limit) hints.push({ tone: "violet", title: "Add a LIMIT to the sort", note: "lets Postgres use a cheap top-N heapsort" });
  return hints.length ? hints.slice(0, 4) : [{ tone: "mint", title: "Query looks lean", note: "no obvious rewrite; check EXPLAIN for row estimates" }];
}

function buildPlan(sql) {
  const parsed = parseSql(sql);
  const base = parsed.from?.split(/\s+/)[0] || "table";
  const steps = [{ tone: "violet", node: "Seq Scan", target: base, detail: parsed.where ? `apply filter: ${parsed.where}` : "fetch all rows", rows: 8, cost: "0.00..15.50", story: `Postgres opens ${base} and walks it page by page.` }];
  for (const join of parsed.joins) steps.push({ tone: "cyan", node: join.kind.startsWith("left") ? "Hash Left Join" : "Hash Join", target: `${base} ⋈ ${join.table}`, detail: `match on ${join.left} = ${join.right}`, rows: 12, cost: "0.15..8.20", story: `A hash table is built from ${join.table}, then ${base} is probed against it.` });
  if (parsed.groupBy) steps.push({ tone: "amber", node: "HashAggregate", target: parsed.groupBy, detail: "collapse groups", rows: 5, cost: "8.40..9.10", story: `Rows are bucketed by ${parsed.groupBy}.` });
  if (parsed.orderBy) steps.push({ tone: "mint", node: "Sort", target: parsed.orderBy, detail: parsed.limit ? `top-${parsed.limit} heapsort` : "quicksort in work_mem", rows: 3, cost: "12.40..12.90", story: `Surviving rows are ordered by ${parsed.orderBy}.` });
  if (parsed.limit) steps.push({ tone: "cyan", node: "Limit", target: `${parsed.limit} rows`, detail: "stop early", rows: Number(parsed.limit), cost: "12.90..12.92", story: `Execution stops after ${parsed.limit} rows.` });
  return steps;
}

function safeSelect(sql) {
  const normalized = sql.trim().replace(/;\s*$/, "");
  if (!/^select\b/i.test(normalized)) throw Object.assign(new Error("Only SELECT statements are allowed by this endpoint"), { status: 400 });
  if (normalized.includes(";")) throw Object.assign(new Error("Multiple SQL statements are not allowed"), { status: 400 });
  if (/\b(insert|update|delete|drop|alter|create|attach|pragma|vacuum)\b/i.test(normalized)) throw Object.assign(new Error("Mutating or administrative SQL is not allowed"), { status: 400 });
  return normalized;
}

function quoteIdentifier(identifier) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw Object.assign(new Error("Dataset and column names must contain only letters, numbers, and underscores"), { status: 400 });
  }
  return `"${identifier}"`;
}

function datasetTable(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^\d+/, "");
  return quoteIdentifier(`dbmentor_${slug || "dataset"}`);
}

function schemaIdentifier(schemaId) {
  if (!/^[a-f0-9-]{36}$/.test(schemaId)) {
    throw Object.assign(new Error("Invalid schemaId"), { status: 400 });
  }
  return `dbmentor_${schemaId.replaceAll("-", "")}`;
}

function sampleUuid(table, column, rowIndex) {
  const prefix = createHash("sha256").update(`${table.name}.${column.name}`).digest("hex").slice(0, 8);
  return `${prefix}-0000-4000-8000-${String(rowIndex).padStart(12, "0")}`;
}

function sampleValue(table, column, rowIndex, tables) {
  const name = column.name.toLowerCase();
  const type = (column.sqlType || column.type || "text").toLowerCase();
  if (column.references) {
    const referencedTable = tables.find((candidate) => candidate.name === column.references.table);
    const referencedColumn = referencedTable?.columns.find((candidate) => candidate.name === column.references.column);
    if (referencedTable && referencedColumn) return sampleValue(referencedTable, referencedColumn, rowIndex, tables);
  }
  if (type === "uuid") return sampleUuid(table, column, rowIndex);
  if (type === "boolean" || type === "bool") return rowIndex % 2 === 1;
  if (type === "json" || type === "jsonb") return { sample: rowIndex };
  if (type === "bytea") return Buffer.from(`sample-${rowIndex}`);
  if (type === "time" || type.startsWith("time ") || type === "timetz") return `10:${String(rowIndex).padStart(2, "0")}:00`;
  if (["date", "ts", "timestamp", "timestamp with time zone", "timestamp without time zone", "timestamptz", "datetime"].includes(type)) return new Date(Date.UTC(2025, rowIndex - 1, 10)).toISOString();
  if (["smallint", "integer", "int", "bigint", "int2", "int4", "int8", "smallserial", "serial", "bigserial", "fk"].includes(type)) {
    return column.key === "pk" || column.key === "fk" || name === "id" || name.endsWith("_id") ? rowIndex : rowIndex * 25;
  }
  if (["num", "numeric", "decimal", "real", "double precision", "float4", "float8", "money"].includes(type)) return rowIndex * 25;
  if (column.key === "pk" || name === "id") return `${table.name}_${rowIndex}`;
  if (column.key === "fk" || name.endsWith("_id")) return String(rowIndex);
  if (name.includes("email")) return `${table.replace(/s$/, "")}${rowIndex}@example.test`;
  if (name.includes("status")) return rowIndex % 2 ? "active" : "pending";
  if (name.includes("name")) return `${table.replace(/s$/, "")} ${rowIndex}`;
  if (name.includes("phone")) return `555010${rowIndex}`;
  if (name.includes("amount") || name.includes("price") || name.includes("fare") || name.includes("total")) return String(rowIndex * 25);
  return `${column.name.replaceAll("_", " ")} ${rowIndex}`;
}

function sampleRows(schema) {
  return (schema.tables || []).map((table) => ({
    table,
    rows: Array.from({ length: 5 }, (_, index) => {
      const rowNumber = index + 1;
      return table.columns.map((column) => sampleValue(table.name, column, rowNumber, schema.tables));
    }),
  }));
}

async function ensureSchemaRegistry(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS ${schemaRegistry} (
    schema_id UUID PRIMARY KEY,
    schema_name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schema_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_active BOOLEAN NOT NULL DEFAULT TRUE
  )`);
}

async function readSampleRows(databaseSchema, schema) {
  const firstTable = schema?.tables?.[0]?.name;
  if (!firstTable) return { columns: [], rows: [], ms: 0 };
  const started = performance.now();
  const result = await pool.query(`SELECT * FROM ${quoteIdentifier(databaseSchema)}.${quoteIdentifier(firstTable)} ORDER BY 1 LIMIT 10`);
  return {
    columns: result.fields.map((field) => field.name),
    rows: result.rows.map((row) => result.fields.map((field) => row[field.name])),
    ms: Number((performance.now() - started).toFixed(1)),
  };
}

async function createGeneratedSchema(schema, schemaId) {
  if (!pool) throw Object.assign(new Error("PostgreSQL is required to persist generated schemas"), { status: 503 });
  const databaseSchema = schemaIdentifier(schemaId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureSchemaRegistry(client);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(databaseSchema)}`);
    for (const table of schema.tables || []) {
      const columns = (table.columns || []).map((column) => {
        const type = { int: "INTEGER", text: "TEXT", num: "NUMERIC", ts: "TIMESTAMPTZ", date: "DATE", fk: "INTEGER" }[column.type] || "TEXT";
        const key = column.key === "pk" ? " PRIMARY KEY" : "";
        return `${quoteIdentifier(column.name)} ${type}${key}`;
      });
      await client.query(`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(databaseSchema)}.${quoteIdentifier(table.name)} (${columns.join(", ")})`);
    }
    for (const { table, rows } of sampleRows(schema)) {
      const columns = table.columns.map((column) => quoteIdentifier(column.name));
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
      for (const row of rows) {
        await client.query(`INSERT INTO ${quoteIdentifier(databaseSchema)}.${quoteIdentifier(table.name)} (${columns.join(", ")}) VALUES (${placeholders})`, row);
      }
    }
    await client.query(`UPDATE ${schemaRegistry} SET is_active = FALSE WHERE is_active = TRUE`);
    await client.query(`INSERT INTO ${schemaRegistry} (schema_id, schema_name, prompt, schema_json, is_active) VALUES ($1, $2, $3, $4::jsonb, TRUE)`, [schemaId, schema.title || "Generated schema", schema.prompt || "", JSON.stringify(schema)]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return databaseSchema;
}

function parseImportedDdl(ddl) {
  let statements;
  try {
    statements = parsePostgresSql(ddl);
  } catch (error) {
    throw Object.assign(new Error(`Invalid PostgreSQL DDL: ${error.message}`), { status: 400 });
  }

  const createStatements = [];
  for (const statement of statements) {
    if (statement.type === "create schema" || statement.type === "set") continue;
    if (statement.type !== "create table" || !Array.isArray(statement.columns) || statement.query) {
      throw Object.assign(new Error("Only CREATE TABLE statements are supported. Remove other SQL statements and try again."), { status: 400 });
    }
    createStatements.push(statement);
  }
  if (!createStatements.length) {
    throw Object.assign(new Error("Paste at least one CREATE TABLE statement."), { status: 400 });
  }

  const normalizeIdentifier = (identifier, label) => {
    const normalized = String(identifier || "").toLowerCase();
    try { quoteIdentifier(normalized); } catch {
      throw Object.assign(new Error(`${label} must be a simple SQL identifier (letters, numbers, and underscores).`), { status: 400 });
    }
    return normalized;
  };
  const supportedTypes = new Set([
    "smallint", "integer", "int", "bigint", "int2", "int4", "int8", "smallserial", "serial", "bigserial",
    "numeric", "decimal", "real", "double precision", "float4", "float8", "money",
    "text", "character", "char", "varchar", "character varying", "boolean", "bool", "uuid", "json", "jsonb", "bytea",
    "date", "time", "time with time zone", "time without time zone", "timetz", "timestamp", "timestamp with time zone", "timestamp without time zone", "timestamptz",
  ]);
  const compactType = (name) => {
    const value = name.toLowerCase();
    if (["smallint", "integer", "int", "bigint", "int2", "int4", "int8", "smallserial", "serial", "bigserial"].includes(value)) return "int";
    if (["numeric", "decimal", "real", "double precision", "float4", "float8", "money"].includes(value)) return "num";
    if (value === "date") return "date";
    if (value.startsWith("time") || value.startsWith("timestamp") || value === "timetz" || value === "timestamptz") return "ts";
    return "text";
  };

  const tableNames = new Set();
  const tableByName = new Map();
  const foreignKeys = [];
  for (const statement of createStatements) {
    if (statement.name?.schema) {
      throw Object.assign(new Error("Do not qualify table names with a schema; imported tables are isolated automatically."), { status: 400 });
    }
    const name = normalizeIdentifier(statement.name?.name, "Table name");
    if (tableNames.has(name)) throw Object.assign(new Error(`Duplicate table name: ${name}`), { status: 400 });
    tableNames.add(name);
    statement.name.name = name;

    const columns = [];
    const columnByName = new Map();
    for (const definition of statement.columns) {
      if (definition.kind !== "column" || definition.name?.schema) {
        throw Object.assign(new Error(`Unsupported column definition in table ${name}.`), { status: 400 });
      }
      const columnName = normalizeIdentifier(definition.name?.name, "Column name");
      if (columnByName.has(columnName)) throw Object.assign(new Error(`Duplicate column ${columnName} in table ${name}.`), { status: 400 });
      const dataType = definition.dataType;
      if (!dataType?.name || !supportedTypes.has(dataType.name.toLowerCase())) {
        throw Object.assign(new Error(`Unsupported PostgreSQL data type in ${name}.${columnName}: ${dataType?.name || "unknown"}.`), { status: 400 });
      }
      definition.name.name = columnName;
      const column = { name: columnName, type: compactType(dataType.name), sqlType: dataType.name.toLowerCase(), key: undefined };
      columns.push(column);
      columnByName.set(columnName, column);

      for (const constraint of definition.constraints || []) {
        if (!["primary key", "not null", "unique", "default", "reference"].includes(constraint.type)) {
          throw Object.assign(new Error(`Unsupported constraint in table ${name}.${columnName}: ${constraint.type}.`), { status: 400 });
        }
        if (constraint.type === "primary key") column.key = "pk";
        if (constraint.type === "default" && !["string", "integer", "numeric", "boolean", "null"].includes(constraint.default?.type)) {
          throw Object.assign(new Error(`Only literal defaults are supported in ${name}.${columnName}.`), { status: 400 });
        }
        if (constraint.type === "reference") {
          if (!constraint.foreignTable?.name || !Array.isArray(constraint.foreignColumns) || !constraint.foreignColumns.length) {
            throw Object.assign(new Error(`A REFERENCES clause on ${name}.${columnName} must name the referenced table and columns.`), { status: 400 });
          }
          if (constraint.foreignTable.schema) {
            throw Object.assign(new Error("Foreign keys must reference tables included in the pasted DDL."), { status: 400 });
          }
          constraint.foreignTable.name = normalizeIdentifier(constraint.foreignTable?.name, "Referenced table");
          for (const item of constraint.foreignColumns || []) item.name = normalizeIdentifier(item.name, "Referenced column");
          foreignKeys.push({ table: name, localColumns: [{ name: columnName }], foreignTable: constraint.foreignTable, foreignColumns: constraint.foreignColumns });
        }
      }
    }

    for (const constraint of statement.constraints || []) {
      if (!["primary key", "foreign key", "unique"].includes(constraint.type)) {
        throw Object.assign(new Error(`Unsupported table constraint in ${name}: ${constraint.type}.`), { status: 400 });
      }
      if (constraint.type === "primary key") {
        for (const item of constraint.columns || []) {
          item.name = normalizeIdentifier(item.name, "Primary key column");
          const column = columnByName.get(item.name);
          if (!column) throw Object.assign(new Error(`Unknown primary key column in table ${name}.`), { status: 400 });
          column.key = "pk";
        }
      }
      if (constraint.type === "foreign key") {
        if (!constraint.foreignTable?.name || !Array.isArray(constraint.localColumns) || !constraint.localColumns.length || !Array.isArray(constraint.foreignColumns) || !constraint.foreignColumns.length) {
          throw Object.assign(new Error(`A foreign key in table ${name} must name local and referenced columns.`), { status: 400 });
        }
        if (constraint.foreignTable.schema) {
          throw Object.assign(new Error("Foreign keys must reference tables included in the pasted DDL."), { status: 400 });
        }
        constraint.foreignTable.name = normalizeIdentifier(constraint.foreignTable?.name, "Referenced table");
        for (const item of constraint.localColumns || []) item.name = normalizeIdentifier(item.name, "Foreign key column");
        for (const item of constraint.foreignColumns || []) item.name = normalizeIdentifier(item.name, "Referenced column");
        foreignKeys.push({ table: name, localColumns: constraint.localColumns, foreignTable: constraint.foreignTable, foreignColumns: constraint.foreignColumns });
      }
      if (constraint.type === "unique") {
        for (const item of constraint.columns || []) item.name = normalizeIdentifier(item.name, "Unique column");
      }
    }
    tableByName.set(name, { name, columns });
  }

  const edges = new Map();
  const dependencies = new Map([...tableNames].map((name) => [name, new Set()]));
  for (const foreignKey of foreignKeys) {
    if (foreignKey.foreignTable?.schema) {
      throw Object.assign(new Error("Foreign keys must reference tables included in the pasted DDL."), { status: 400 });
    }
    const parentName = normalizeIdentifier(foreignKey.foreignTable?.name, "Referenced table");
    const parent = tableByName.get(parentName);
    if (!parent || !Array.isArray(foreignKey.localColumns) || !Array.isArray(foreignKey.foreignColumns) || foreignKey.localColumns.length !== foreignKey.foreignColumns.length) {
      throw Object.assign(new Error(`Foreign key references an unknown table or mismatched columns: ${parentName}.`), { status: 400 });
    }
    foreignKey.foreignTable.name = parentName;
    if (parentName !== foreignKey.table) dependencies.get(foreignKey.table).add(parentName);
    edges.set(`${parentName}->${foreignKey.table}`, { from: parentName, to: foreignKey.table, tone: "cyan", label: "1..N" });
    for (let index = 0; index < foreignKey.localColumns.length; index += 1) {
      const localName = normalizeIdentifier(foreignKey.localColumns[index].name, "Foreign key column");
      const foreignName = normalizeIdentifier(foreignKey.foreignColumns[index].name, "Referenced column");
      const local = tableByName.get(foreignKey.table).columns.find((column) => column.name === localName);
      if (!local || !parent.columns.some((column) => column.name === foreignName)) {
        throw Object.assign(new Error(`Foreign key references an unknown column: ${foreignKey.table}.${localName} -> ${parentName}.${foreignName}.`), { status: 400 });
      }
      local.key = "fk";
      local.references = { table: parentName, column: foreignName };
    }
  }

  const orderedNames = [];
  const pending = new Set(tableNames);
  while (pending.size) {
    const ready = [...pending].filter((name) => [...dependencies.get(name)].every((dependency) => !pending.has(dependency)));
    if (!ready.length) throw Object.assign(new Error("Circular foreign-key dependencies are not supported by schema import."), { status: 400 });
    for (const name of ready) {
      pending.delete(name);
      orderedNames.push(name);
    }
  }

  const tables = orderedNames.map((name, index) => ({
    ...tableByName.get(name),
    tone: ["cyan", "amber", "violet", "rose"][index % 4],
    x: [5, 40, 68, 70][index % 4],
    y: [60, 150, 46, 232][index % 4],
  }));
  return {
    schema: {
      key: "ddl_import",
      title: "Imported DDL schema",
      prompt: "Imported from SQL DDL",
      matched: true,
      tables,
      edges: [...edges.values()],
      explanation: "Schema imported from PostgreSQL DDL.",
      suggestions: [],
    },
    statements: orderedNames.map((name) => createStatements.find((statement) => statement.name.name === name)),
  };
}

async function persistImportedSchema(schema, schemaId, statements) {
  if (!pool) throw Object.assign(new Error("PostgreSQL is required to import schemas"), { status: 503 });
  const databaseSchema = schemaIdentifier(schemaId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureSchemaRegistry(client);
    await client.query(`CREATE SCHEMA ${quoteIdentifier(databaseSchema)}`);
    await client.query(`SET LOCAL search_path TO ${quoteIdentifier(databaseSchema)}, public`);
    for (const statement of statements) await client.query(toSql.statement(statement));
    for (const { table, rows } of sampleRows(schema)) {
      const columns = table.columns.map((column) => quoteIdentifier(column.name));
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
      for (const row of rows) {
        await client.query(`INSERT INTO ${quoteIdentifier(table.name)} (${columns.join(", ")}) VALUES (${placeholders})`, row);
      }
      for (const column of table.columns.filter((item) => ["serial", "smallserial", "bigserial"].includes(item.sqlType))) {
        const quotedColumn = quoteIdentifier(column.name);
        await client.query(
          `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE(MAX(${quotedColumn}), 1), MAX(${quotedColumn}) IS NOT NULL) FROM ${quoteIdentifier(table.name)}`,
          [`${databaseSchema}.${table.name}`, column.name],
        );
      }
    }
    await client.query(`UPDATE ${schemaRegistry} SET is_active = FALSE WHERE is_active = TRUE`);
    await client.query(`INSERT INTO ${schemaRegistry} (schema_id, schema_name, prompt, schema_json, is_active) VALUES ($1, $2, $3, $4::jsonb, TRUE)`, [schemaId, schema.title, schema.prompt, JSON.stringify(schema)]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return databaseSchema;
}

app.get("/health", async (_request, response) => {
  let nlp = false;
  try { nlp = (await fetch(`${nlpUrl}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch {}
  let postgres = false;
  if (pool) {
    try { await pool.query("SELECT 1"); postgres = true; } catch {}
  }
  log(postgres || !pool ? "debug" : "warn", "Health check completed", { nlp, postgres, databaseConfigured: Boolean(pool) });
  response.json({ ok: true, service: "dbmentor-api", nlp, postgres, databaseConfigured: Boolean(pool) });
});

app.post("/api/v1/schema/generate", async (request, response, next) => {
  try {
    const prompt = requireString(request.body?.prompt, "prompt");
    const body = await nlp("schema", { prompt });
    log("info", "Schema generated", {
      requestId: request.requestId,
      engine: body.engine || "unknown",
      model: body.model_id || body.model?.schema_model,
      fallback: Boolean(body.fallback),
      fallbackReason: body.fallback_reason,
      tableCount: body.schema?.tables?.length,
    });
    const schemaId = randomUUID();
    const persistedSchema = { ...body.schema, ddl: body.ddl };
    const databaseSchema = await createGeneratedSchema(persistedSchema, schemaId);
    const sampleResult = await readSampleRows(databaseSchema, persistedSchema);
    response.json({ ...body, schema: { ...persistedSchema, schemaId }, schemaId, database: "postgresql", sampleResult });
  } catch (error) { next(error); }
});

app.post("/api/v1/schema/import-ddl", async (request, response, next) => {
  try {
    const ddl = requireString(request.body?.ddl, "ddl");
    const parsed = parseImportedDdl(ddl);
    const schemaId = randomUUID();
    const normalizedDdl = parsed.statements.map((statement) => toSql.statement(statement)).join(";\n\n") + ";";
    const persistedSchema = { ...parsed.schema, ddl: normalizedDdl };
    const databaseSchema = await persistImportedSchema(persistedSchema, schemaId, parsed.statements);
    const sampleResult = await readSampleRows(databaseSchema, persistedSchema);
    log("info", "DDL schema imported", { requestId: request.requestId, tableCount: persistedSchema.tables.length });
    response.status(201).json({ schema: { ...persistedSchema, schemaId }, schemaId, database: "postgresql", sampleResult, engine: "ddl_import" });
  } catch (error) { next(error); }
});

app.get("/api/v1/schema/active", async (_request, response, next) => {
  try {
    if (!pool) throw Object.assign(new Error("PostgreSQL is not configured"), { status: 503 });
    await pool.query(`CREATE TABLE IF NOT EXISTS ${schemaRegistry} (schema_id UUID PRIMARY KEY, schema_name TEXT NOT NULL, prompt TEXT NOT NULL, schema_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), is_active BOOLEAN NOT NULL DEFAULT TRUE)`);
    const active = await pool.query(`SELECT schema_id, schema_json, created_at FROM ${schemaRegistry} WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 1`);
    if (!active.rowCount) return response.json({ schema: null });
    const schema = { ...active.rows[0].schema_json, schemaId: active.rows[0].schema_id };
    const sampleResult = await readSampleRows(schemaIdentifier(schema.schemaId), schema);
    response.json({ schema, sampleResult, database: "postgresql" });
  } catch (error) { next(error); }
});

app.post("/api/v1/sql/generate", async (request, response, next) => {
  try {
    const question = requireString(request.body?.question, "question");
    if (!request.body?.schema?.tables?.length) throw Object.assign(new Error("A generated schema is required before creating SQL"), { status: 400 });
    const generated = await nlp("sql", { question, schema: request.body.schema });
    log("info", "SQL generated", {
      requestId: request.requestId,
      engine: generated.engine || "unknown",
      model: generated.model?.sql_model,
      fallback: Boolean(generated.fallback),
      fallbackReason: generated.fallback_reason,
    });
    response.json(generated);
  } catch (error) { next(error); }
});

app.post("/api/v1/sql/explain", async (request, response, next) => {
  try {
    const sql = requireString(request.body?.sql, "sql");
    const question = typeof request.body?.question === "string" ? request.body.question : "";
    const [story, parsed] = await Promise.all([nlp("story", { sql, question }), Promise.resolve(parseSql(sql))]);
    response.json({ ...story, parsed, hints: optimize(sql), plan: buildPlan(sql) });
  } catch (error) { next(error); }
});

app.post("/api/v1/sql/execute", async (request, response, next) => {
  try {
    const sql = safeSelect(requireString(request.body?.sql, "sql"));
    const started = performance.now();
    if (!pool) {
      throw Object.assign(new Error("PostgreSQL is required to execute queries"), { status: 503 });
    }
    const schemaId = requireString(request.body?.schemaId, "schemaId");
    const databaseSchema = schemaIdentifier(schemaId);
    const client = await pool.connect();
    let result;
    try {
      await client.query("BEGIN");
      await client.query("SET TRANSACTION READ ONLY");
      await client.query(`SET LOCAL search_path TO ${quoteIdentifier(databaseSchema)}, public`);
      result = await client.query(sql);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    response.json({ columns: result.fields.map((field) => field.name), rows: result.rows.map((row) => result.fields.map((field) => row[field.name])), sql, ms: Number((performance.now() - started).toFixed(1)), execution: "postgresql" });
  } catch (error) { next(error); }
});

app.post("/api/v1/datasets", async (request, response, next) => {
  try {
    if (!pool) throw Object.assign(new Error("PostgreSQL is not configured. Set DATABASE_URL before uploading datasets."), { status: 503 });
    const name = requireString(request.body?.name, "name");
    const columns = request.body?.columns;
    const rows = request.body?.rows;
    if (!Array.isArray(columns) || !Array.isArray(rows) || columns.length === 0) throw Object.assign(new Error("columns and rows must be non-empty arrays"), { status: 400 });
    const normalizedColumns = columns.map((column) => requireString(column, "column").toLowerCase().replace(/\s+/g, "_"));
    const table = datasetTable(name);
    const columnSql = normalizedColumns.map((column) => `${quoteIdentifier(column)} TEXT`).join(", ");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DROP TABLE IF EXISTS ${table}`);
      await client.query(`CREATE TABLE ${table} (${columnSql})`);
      const placeholders = normalizedColumns.map((_, index) => `$${index + 1}`).join(", ");
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== normalizedColumns.length) throw Object.assign(new Error("Every row must match the column count"), { status: 400 });
        await client.query(`INSERT INTO ${table} (${normalizedColumns.map(quoteIdentifier).join(", ")}) VALUES (${placeholders})`, row);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    response.status(201).json({ name, table: table.slice(1, -1), columns: normalizedColumns, rowCount: rows.length, database: "postgresql" });
  } catch (error) { next(error); }
});

app.use((error, request, response, _next) => {
  const status = error.status || 500;
  log(status >= 500 ? "error" : "warn", "Request failed", { requestId: request.requestId, status, ...errorFields(error) });
  response.status(status).json({ error: error.message || "Internal server error", requestId: request.requestId });
});

app.listen(port, () => {
  log("info", "DBMentor API listening", {
    address: `http://127.0.0.1:${port}`,
    nlpUrl,
    databaseConfigured: Boolean(pool),
    logLevel: minimumLogLevel,
  });
});
