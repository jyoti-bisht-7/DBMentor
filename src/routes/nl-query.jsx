import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SqlHighlight } from "@/components/SqlEditor";
import { TopBar } from "@/components/TopBar";
import {
  ACTIVE_SCHEMA_STORAGE_KEY,
  explainSqlFromApi,
  englishToSqlFromApi,
  getActiveSchemaFromApi,
  getPersistedSchema,
  parsePersistedSchema,
  persistSchema,
  PENDING_QUERY_STORAGE_KEY,
} from "@/lib/dbmentor";

export const Route = createFileRoute("/nl-query")({
  head: () => ({ meta: [{ title: "NL → Query — DBMentor" }] }),
  component: NaturalLanguageQuery,
});

function NaturalLanguageQuery() {
  const navigate = useNavigate();
  const [schema, setSchema] = useState(null);
  const [question, setQuestion] = useState("");
  const [drafted, setDrafted] = useState("");
  const [explanation, setExplanation] = useState([]);
  const [explanationBusy, setExplanationBusy] = useState(false);
  const [explanationError, setExplanationError] = useState("");
  const [busy, setBusy] = useState(false);
  const [schemaError, setSchemaError] = useState("");
  const [generationError, setGenerationError] = useState("");

  useEffect(() => {
    let active = true;
    const cachedSchema = getPersistedSchema();
    if (cachedSchema) setSchema(cachedSchema);
    getActiveSchemaFromApi().then((activeData) => {
      if (!active || !activeData.schema) return;
      setSchema(activeData.schema);
      persistSchema(activeData.schema);
      setSchemaError("");
    }).catch((loadError) => {
      if (active && !cachedSchema) setSchemaError(`Could not load the active schema: ${loadError.message}`);
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
      setGenerationError("");
    };
    window.addEventListener("storage", syncSchema);
    return () => window.removeEventListener("storage", syncSchema);
  }, []);

  const convert = async () => {
    setBusy(true);
    setGenerationError("");
    setDrafted("");
    setExplanation([]);
    setExplanationError("");
    try {
      if (!schema) throw new Error("Generate a schema in the workspace first.");
      const generated = await englishToSqlFromApi(question, schema);
      setDrafted(generated.sql);
      setExplanationBusy(true);
      try {
        const explained = await explainSqlFromApi(generated.sql, question);
        if (!Array.isArray(explained.story) || !explained.story.length) {
          throw new Error("The explanation service returned no explanation.");
        }
        setExplanation(explained.story);
      } catch (explainError) {
        setExplanationError(`The SQL was created, but its explanation could not be loaded: ${explainError.message}`);
      } finally {
        setExplanationBusy(false);
      }
    } catch (convertError) {
      setGenerationError(convertError.message);
    } finally {
      setBusy(false);
    }
  };

  const loadIntoQueryLab = async () => {
    try {
      window.sessionStorage.setItem(PENDING_QUERY_STORAGE_KEY, drafted);
      await navigate({ to: "/query-lab" });
    } catch (loadError) {
      setGenerationError(`Could not load the generated query into Query Lab: ${loadError.message}`);
    }
  };

  return (
    <div className="min-h-screen bg-surface text-ink">
      <TopBar />
      <main className="module-scale min-h-[calc(100vh-3.5rem)] px-3 sm:px-4 lg:px-6">
        <section className="flex min-h-[70vh] flex-col border-b border-edge bg-surface2/30">
          <div className="border-b border-edge bg-surface2/30 px-5 py-2.5">
            <h1 className="border-l-4 border-l-amber pl-3 font-mono text-[17.2px] font-semibold text-amber">
              Natural language to SQL
            </h1>
          </div>
          <div className="space-y-4 p-5">
            <label htmlFor="natural-language-query" className="block font-mono text-[15.6px] uppercase tracking-[0.18em] text-dim">
              Describe the query you need
            </label>
            <textarea
              id="natural-language-query"
              rows={4}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              className="w-full resize-none rounded-[14px] bg-surface3 p-4 text-[20.3px] leading-relaxed text-mute outline-none ring-1 ring-inset ring-edge focus:text-ink focus:ring-cyan/40"
            />
            {schemaError && <p role="alert" className="text-[17.2px] text-rose">{schemaError}</p>}
            <button
              type="button"
              onClick={convert}
              disabled={busy}
              className="landing-button inline-flex w-full items-center justify-center py-2.5 font-mono text-[18.7px] font-semibold transition-transform hover:-translate-y-px hover:bg-[#ffd06a] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "Working..." : "Convert to SQL"}
            </button>
            {generationError && <p role="alert" className="text-[17.2px] text-rose">{generationError}</p>}
            {drafted && (
              <div className="overflow-hidden rounded-[14px] bg-surface3/60 ring-1 ring-inset ring-edge">
                <SqlHighlight sql={drafted} gutter={false} />
                <div className="border-t border-edge px-4 py-4">
                  <h2 className="font-mono text-[16px] font-semibold text-amber">How this SQL was formed</h2>
                  {explanationBusy && <p className="mt-3 text-[15.6px] text-dim">Writing a beginner-friendly explanation...</p>}
                  {explanationError && <p role="alert" className="mt-3 text-[15.6px] text-rose">{explanationError}</p>}
                  {explanation.length > 0 && (
                    <ol className="mt-3 space-y-2.5" aria-label="SQL statement steps">
                      {explanation.map((step, index) => {
                        const separator = step.indexOf(":");
                        const keyword = separator >= 0 ? step.slice(0, separator) : "SQL";
                        const detail = separator >= 0 ? step.slice(separator + 1).trim() : step;
                        return (
                          <li
                            key={`${index}-${step}`}
                            className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-3 rounded-[10px] bg-surface/70 px-3 py-3 ring-1 ring-inset ring-edge"
                          >
                            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-amber font-mono text-[13px] font-bold text-cyanink">
                              {index + 1}
                            </span>
                            <span className="mt-0.5 inline-flex rounded-[6px] bg-cyan/15 px-2 py-0.5 font-mono text-[13px] font-semibold text-cyan">
                              {keyword}
                            </span>
                            <p className="min-w-0 text-[15.6px] leading-relaxed text-mute">{detail}</p>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </div>
                <button
                  type="button"
                  onClick={loadIntoQueryLab}
                  className="landing-button w-full py-2.5 font-mono text-[17.2px] transition-transform hover:-translate-y-px hover:bg-[#ffd06a]"
                >
                  Load into Query Lab
                </button>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
