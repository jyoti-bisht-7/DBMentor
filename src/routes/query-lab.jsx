import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { TopBar } from "@/components/TopBar";
import { QueryLabPanel } from "@/components/QueryLabPanel";
import {
  ACTIVE_SCHEMA_STORAGE_KEY,
  emptyResult,
  getActiveSchemaFromApi,
  getPersistedSchema,
  parsePersistedSchema,
  persistSchema,
} from "@/lib/dbmentor";

export const Route = createFileRoute("/query-lab")({
  head: () => ({ meta: [{ title: "Query Lab — DBMentor" }] }),
  component: QueryLab,
});

function QueryLab() {
  const [schema, setSchema] = useState(null);
  const [initialResult, setInitialResult] = useState(emptyResult);

  useEffect(() => {
    let active = true;
    const cachedSchema = getPersistedSchema();
    if (cachedSchema) setSchema(cachedSchema);
    getActiveSchemaFromApi().then((activeData) => {
      if (active && activeData.schema) {
        setSchema(activeData.schema);
        setInitialResult(activeData.sampleResult || emptyResult());
        persistSchema(activeData.schema);
      }
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const syncSchema = (event) => {
      if (event.key !== ACTIVE_SCHEMA_STORAGE_KEY) return;
      const nextSchema = parsePersistedSchema(event.newValue);
      if (!nextSchema) return;
      setSchema(nextSchema);
      setInitialResult(emptyResult());
    };
    window.addEventListener("storage", syncSchema);
    return () => window.removeEventListener("storage", syncSchema);
  }, []);

  return (
    <div className="min-h-screen bg-surface text-ink">
      <TopBar />
      <div className="module-scale grid grid-cols-1 px-3 sm:px-4 lg:px-6">
        <QueryLabPanel schema={schema} initialResult={initialResult} loadPendingQuery />
      </div>
    </div>
  );
}
