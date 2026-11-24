import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { TopBar } from "@/components/TopBar";
import { ErCanvas } from "@/components/ErCanvas";
import { SqlHighlight } from "@/components/SqlEditor";
import { PlanSteps } from "@/components/PlanSteps";
import { TONE_DOT } from "@/components/tone";
import {
  getActiveSchemaFromApi,
  getPersistedSchema,
  generateSchemaFromApi,
  importSchemaDdlFromApi,
  ACTIVE_SCHEMA_STORAGE_KEY,
  parsePersistedSchema,
  persistSchema,
  schemaToSql,
  explainSchema,
} from "@/lib/dbmentor";

export const Route = createFileRoute("/workspace")({
  head: () => ({
    meta: [
      { title: "Schema workspace — DBMentor" },
      {
        name: "description",
        content:
          "Describe a requirement in plain English and get tables, keys, an ER diagram and normalization advice.",
      },
      { property: "og:title", content: "Schema workspace — DBMentor" },
      {
        property: "og:description",
        content: "Plain-English requirements become tables, keys and an ER diagram you can read.",
      },
    ],
  }),
  component: Workspace,
});

function Workspace() {
  const [prompt, setPrompt] = useState("");
  const [ddlInput, setDdlInput] = useState("");
  const [ddlEdit, setDdlEdit] = useState("");
  const [inputMode, setInputMode] = useState("scenario");
  const [schema, setSchema] = useState(null);
  const [hovered, setHovered] = useState(null);
  const [schemaError, setSchemaError] = useState("");
  const [busy, setBusy] = useState(false);
  const diagramRef = useRef(null);
  const ddlRef = useRef(null);

  const ddl = useMemo(() => schemaToSql(schema), [schema]);
  const schemaExplanation = useMemo(() => explainSchema(schema), [schema]);
  useEffect(() => setDdlEdit(ddl), [ddl]);
  const scrollToSection = (sectionRef) => {
    const section = sectionRef.current;
    if (!section) return;
    window.scrollTo({
      top: window.scrollY + section.getBoundingClientRect().top,
      behavior: "instant",
    });
  };
  const diagram = schema ? (
    <ErCanvas schema={schema} hovered={hovered} onHover={setHovered} />
  ) : (
    <div className="grid min-h-[70vh] place-items-center p-8 text-center font-mono text-[15.6px] text-dim">
      Describe your database scenario to generate the ER diagram.
    </div>
  );

  useEffect(() => {
    let active = true;
    const cachedSchema = getPersistedSchema();
    if (cachedSchema) setSchema(cachedSchema);
    getActiveSchemaFromApi().then((activeData) => {
      const storedSchema = activeData.schema;
      if (!active || !storedSchema) return;
      setSchema(storedSchema);
      persistSchema(storedSchema);
      setSchemaError("");
    }).catch((loadError) => {
      if (active && !cachedSchema) setSchemaError(`Could not load the saved schema: ${loadError.message}`);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const syncSchema = (event) => {
      if (event.key !== ACTIVE_SCHEMA_STORAGE_KEY) return;
      const nextSchema = parsePersistedSchema(event.newValue);
      if (!nextSchema) return;
      setSchema(nextSchema);
      setSchemaError("");
    };
    window.addEventListener("storage", syncSchema);
    return () => window.removeEventListener("storage", syncSchema);
  }, []);

  const generate = async () => {
    setBusy(true);
    try {
      const generated = await generateSchemaFromApi(prompt);
      const nextSchema = generated.schema;
      setSchema(nextSchema);
      setSchemaError("");
      persistSchema(nextSchema);
    } catch (generateError) {
      setSchemaError(generateError.message);
    } finally {
      setBusy(false);
    }
  };

  const applyDdl = async (source) => {
    setBusy(true);
    try {
      const imported = await importSchemaDdlFromApi(source);
      const nextSchema = imported.schema;
      setSchema(nextSchema);
      setSchemaError("");
      persistSchema(nextSchema);
      scrollToSection(diagramRef);
    } catch (ddlError) {
      setSchemaError(ddlError.message);
    } finally {
      setBusy(false);
    }
  };

  const importDdl = () => applyDdl(ddlInput);

  return (
    <div className="min-h-screen bg-surface text-ink">
      <TopBar />

      <div className="module-scale flex min-h-[calc(100vh-3.5rem)] flex-col px-3 sm:px-4 lg:px-6">
        <div className="flex flex-col">
          {/* LEFT RAIL */}
          <aside className="flex w-full shrink-0 flex-col border-b border-edge bg-surface2/40 backdrop-blur-md">
            <div className="space-y-4 p-5">
              <div className="flex w-fit rounded-[10px] bg-surface3 p-1" role="tablist" aria-label="Schema input method">
                <button
                  type="button"
                  role="tab"
                  aria-selected={inputMode === "scenario"}
                  onClick={() => { setInputMode("scenario"); setSchemaError(""); }}
                  className={`rounded-[7px] px-3 py-1.5 font-mono text-[13px] ${inputMode === "scenario" ? "bg-cyan text-cyanink" : "text-dim"}`}
                >
                  Scenario
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={inputMode === "ddl"}
                  onClick={() => { setInputMode("ddl"); setSchemaError(""); }}
                  className={`rounded-[7px] px-3 py-1.5 font-mono text-[13px] ${inputMode === "ddl" ? "bg-cyan text-cyanink" : "text-dim"}`}
                >
                  Paste DDL
                </button>
              </div>
              {inputMode === "scenario" ? (
                <>
                  <div className="-mx-5 border-y border-l-4 border-edge border-l-amber bg-surface2/30 px-5 py-2.5 pl-3 font-mono text-[17.2px] font-semibold text-amber">
                    Describe a Schema
                  </div>
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={5}
                    className="w-full resize-none rounded-[14px] bg-surface3 p-4 text-[20.3px] leading-relaxed text-mute outline-none ring-1 ring-inset ring-edge focus:text-ink focus:ring-cyan/40"
                  />
                  <button
                    type="button"
                    onClick={generate}
                    disabled={busy}
                    className="landing-button inline-flex w-full items-center justify-center gap-2 py-2.5 pl-2.5 pr-4 font-mono text-[18.7px] font-semibold transition-transform hover:-translate-y-px hover:bg-[#ffd06a]"
                  >
                    <span className="text-[21.8px] leading-none">→</span>
                    {busy ? "Working..." : "Generate schema"}
                  </button>
                </>
              ) : (
                <>
                  <div className="font-mono text-[15.6px] uppercase tracking-[0.18em] text-dim">Paste PostgreSQL DDL</div>
                  <textarea
                    value={ddlInput}
                    onChange={(e) => setDdlInput(e.target.value)}
                    rows={7}
                    spellCheck="false"
                    placeholder={'CREATE TABLE customers (\n  id INTEGER PRIMARY KEY,\n  name TEXT NOT NULL\n);'}
                    className="w-full resize-y rounded-[14px] bg-surface3 p-4 font-mono text-[14px] leading-relaxed text-mute outline-none ring-1 ring-inset ring-edge focus:text-ink focus:ring-cyan/40"
                  />
                  <button
                    type="button"
                    onClick={importDdl}
                    disabled={busy || !ddlInput.trim()}
                    className="landing-button inline-flex w-full items-center justify-center gap-2 py-2.5 pl-2.5 pr-4 font-mono text-[18.7px] font-semibold transition-transform hover:-translate-y-px hover:bg-[#ffd06a] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy ? "Importing..." : "Import DDL"}
                  </button>
                </>
              )}
            </div>
            {schemaError && <div className="px-5 pb-4 text-[17.2px] text-rose">{schemaError}</div>}
          </aside>

          {/* CENTER */}
          <section id="schema-diagram" ref={diagramRef} className="flex min-w-0 flex-col border-b border-edge">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-edge bg-surface2/30 px-5">
              <div className="flex items-center gap-2.5">
                <span className="border-l-4 border-l-amber pl-3 font-mono text-[17.2px] font-semibold text-amber">ER Canvas</span>
                <span className="font-mono text-[15.6px] text-dim">
                  {schema ? `${schema.tables.length} nodes · ${schema.edges.length} edges` : "generate a schema to begin"}
                </span>
              </div>
              <div className="flex items-center gap-2 font-mono text-[15.6px] text-dim">
                <button
                  type="button"
                  onClick={() => scrollToSection(diagramRef)}
                  className="landing-button px-2.5 py-1.5 font-mono transition-transform hover:-translate-y-px hover:bg-[#ffd06a]"
                >
                  Diagram
                </button>
                <button
                  type="button"
                  onClick={() => scrollToSection(ddlRef)}
                  className="landing-button px-2.5 py-1.5 font-mono transition-transform hover:-translate-y-px hover:bg-[#ffd06a]"
                >
                  DDL
                </button>
              </div>
            </div>
            <div className="min-h-[70vh]">
              {diagram}
            </div>
            {schemaExplanation && (
              <div className="border-t border-edge bg-[radial-gradient(ellipse_at_top,rgba(157,200,141,0.10),transparent_65%)] px-4 py-8 sm:px-6 lg:px-8">
                <div className="mx-auto max-w-6xl space-y-8">
                  <header className="space-y-3">
                    <span className="inline-flex items-center gap-2 rounded-full bg-cyan/10 px-3 py-1 font-mono text-[12px] font-semibold uppercase tracking-[0.16em] text-cyan ring-1 ring-inset ring-cyan/20">
                      <span className="size-1.5 rounded-full bg-cyan" />
                      ER diagram guide
                    </span>
                    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
                      <div>
                        <h2 className="font-mono text-[22px] font-semibold tracking-tight text-ink sm:text-[26px]">
                          Understand your schema
                        </h2>
                        <p className="mt-1 max-w-3xl text-[15.6px] leading-relaxed text-mute">
                          {schemaExplanation.source}. Every card is a table, and every row inside it is a column.
                          Table colors make the diagram easier to scan.
                        </p>
                      </div>
                      <span className="w-fit rounded-lg bg-surface3/80 px-3 py-1.5 font-mono text-[13px] text-dim ring-1 ring-inset ring-edge">
                        {schemaExplanation.tables.length} tables · {schemaExplanation.relationships.length} relationships
                      </span>
                    </div>
                    {schemaExplanation.summary && (
                      <div className="flex gap-3 rounded-xl border border-mint/20 bg-mint/5 p-4">
                        <span className="mt-0.5 size-2 shrink-0 rounded-full bg-mint" />
                        <p className="text-[15.6px] leading-relaxed text-mute">{schemaExplanation.summary}</p>
                      </div>
                    )}
                  </header>

                  <section aria-label="Diagram symbol guide" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    {[
                      { symbol: "◆", title: "Primary key", description: "Uniquely identifies a row.", tone: "text-amber" },
                      { symbol: "◇", title: "Foreign key", description: "Points to a related row.", tone: "text-cyan" },
                      { symbol: "·", title: "Regular column", description: "Stores a record detail.", tone: "text-dim" },
                      { symbol: "↔", title: "Relationship", description: "Shows how tables connect.", tone: "text-mint" },
                    ].map((item) => (
                      <div key={item.title} className="flex items-center gap-3 rounded-xl bg-surface2/50 p-3 ring-1 ring-inset ring-edge">
                        <span className={`grid size-9 shrink-0 place-items-center rounded-lg bg-surface3 font-mono text-[18px] ${item.tone}`}>
                          {item.symbol}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-[14px] font-semibold text-ink">{item.title}</span>
                          <span className="block text-[13px] leading-snug text-dim">{item.description}</span>
                        </span>
                      </div>
                    ))}
                  </section>

                  <section className="space-y-4" aria-labelledby="er-tables-heading">
                    <div className="flex items-end justify-between gap-3">
                      <div>
                        <p className="font-mono text-[12px] uppercase tracking-[0.16em] text-dim">Schema breakdown</p>
                        <h3 id="er-tables-heading" className="mt-1 font-mono text-[18px] font-semibold text-ink">Tables & columns</h3>
                      </div>
                      <span className="text-[13px] text-dim">Types show what kind of value each column stores.</span>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                      {schemaExplanation.tables.map((table, tableIndex) => (
                        <section
                          key={table.name}
                          className="overflow-hidden rounded-2xl bg-surface2/50 shadow-[0_8px_24px_rgba(0,0,0,0.08)] ring-1 ring-inset ring-edge transition-transform hover:-translate-y-0.5"
                        >
                          <div className="flex items-center gap-3 border-b border-edge bg-surface3/50 px-4 py-3">
                            <span className={`grid size-9 place-items-center rounded-xl ${TONE_DOT[schema.tables[tableIndex]?.tone] || TONE_DOT.cyan}`}>
                              <span className="size-2 rounded-full bg-white/90" />
                            </span>
                            <div className="min-w-0">
                              <h4 className="truncate font-mono text-[16px] font-semibold text-ink">{table.name}</h4>
                              <p className="text-[12px] text-dim">Table · {table.columns.length} columns</p>
                            </div>
                          </div>
                          <p className="px-4 pb-3 pt-3 text-[14px] leading-relaxed text-mute">{table.description}</p>
                          <ul className="px-3 pb-3">
                            {table.columns.map((column) => {
                              const keyKind = column.description.startsWith("Primary key")
                                ? "PK"
                                : column.description.startsWith("Foreign key")
                                  ? "FK"
                                  : null;
                              return (
                                <li key={column.name} className="border-t border-edge/70 px-1 py-2.5">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-mono text-[13px] font-semibold text-ink">{column.name}</span>
                                    {keyKind && (
                                      <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${
                                        keyKind === "PK" ? "bg-amber/10 text-amber" : "bg-cyan/10 text-cyan"
                                      }`}>
                                        {keyKind}
                                      </span>
                                    )}
                                    <span className="ml-auto rounded-md bg-surface3 px-2 py-0.5 text-[11px] text-dim">
                                      {column.type}
                                    </span>
                                  </div>
                                  <p className="mt-1 text-[13px] leading-relaxed text-dim">{column.description}</p>
                                </li>
                              );
                            })}
                          </ul>
                        </section>
                      ))}
                    </div>
                  </section>

                  <section className="space-y-4" aria-labelledby="er-relationships-heading">
                    <div>
                      <p className="font-mono text-[12px] uppercase tracking-[0.16em] text-dim">How records connect</p>
                      <h3 id="er-relationships-heading" className="mt-1 font-mono text-[18px] font-semibold text-ink">Relationships</h3>
                    </div>
                    {schemaExplanation.relationships.length ? (
                      <ul className="grid gap-3 md:grid-cols-2">
                        {schemaExplanation.relationships.map((edge, index) => (
                          <li key={`${edge.from}-${edge.to}-${index}`} className="rounded-xl bg-surface2/50 p-4 ring-1 ring-inset ring-edge">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="rounded-lg bg-surface3 px-2.5 py-1 font-mono text-[13px] font-semibold text-ink">{edge.from}</span>
                              <span aria-hidden="true" className="text-mint">→</span>
                              <span className="rounded-lg bg-surface3 px-2.5 py-1 font-mono text-[13px] font-semibold text-ink">{edge.to}</span>
                              {edge.label && (
                                <span className="ml-auto rounded-full bg-mint/10 px-2.5 py-1 font-mono text-[11px] font-semibold text-mint ring-1 ring-inset ring-mint/20">
                                  {edge.label}
                                </span>
                              )}
                            </div>
                            <p className="mt-3 text-[14px] leading-relaxed text-mute">{edge.description}</p>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="rounded-xl bg-surface2/50 p-4 text-[14px] leading-relaxed text-dim ring-1 ring-inset ring-edge">
                        No relationships are recorded in this schema, so no connecting lines appear between the tables.
                      </p>
                    )}
                  </section>
                </div>
              </div>
            )}
          </section>

          <section id="schema-ddl" ref={ddlRef} className="min-w-0 border-b border-edge">
            <div className="flex items-center justify-between border-b border-edge bg-surface2/30 px-5 py-2.5">
              <span className="border-l-4 border-l-amber pl-3 font-mono text-[17.2px] font-semibold text-amber">DDL</span>
              <button
                type="button"
                onClick={() => applyDdl(ddlEdit)}
                disabled={busy || !schema || !ddlEdit.trim() || ddlEdit === ddl}
                className="landing-button px-3 py-1.5 font-mono text-[14px] font-semibold transition-transform hover:-translate-y-px hover:bg-[#ffd06a] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Updating..." : "Update ER"}
              </button>
            </div>
            <textarea
              aria-label="Edit schema DDL"
              value={ddlEdit}
              onChange={(event) => setDdlEdit(event.target.value)}
              spellCheck="false"
              disabled={!schema}
              className="min-h-[264px] w-full resize-y overflow-auto bg-surface2/20 p-5 font-mono text-[14px] leading-relaxed text-ink outline-none focus:ring-1 focus:ring-inset focus:ring-cyan/40 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </section>

        </div>

      </div>
    </div>
  );
}
