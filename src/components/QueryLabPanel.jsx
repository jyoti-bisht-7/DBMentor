import { useEffect, useState } from "react";
import { SqlEditor } from "@/components/SqlEditor";
import { ResultsGrid } from "@/components/ResultsGrid";
import { emptyResult, executeSqlFromApi, PENDING_QUERY_STORAGE_KEY } from "@/lib/dbmentor";

export function QueryLabPanel({ schema, initialResult, loadPendingQuery = false }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState(initialResult || emptyResult());
  const [busy, setBusy] = useState(false);
  const [executionError, setExecutionError] = useState("");

  useEffect(() => {
    if (!loadPendingQuery) return;
    try {
      const pendingQuery = window.sessionStorage.getItem(PENDING_QUERY_STORAGE_KEY);
      if (pendingQuery === null) return;
      window.sessionStorage.removeItem(PENDING_QUERY_STORAGE_KEY);
      setQuery(pendingQuery);
      setExecutionError("");
    } catch (storageError) {
      setExecutionError(`Could not load the generated query: ${storageError.message}`);
    }
  }, [loadPendingQuery]);

  useEffect(() => {
    setResult(initialResult || emptyResult());
    setExecutionError("");
  }, [schema, initialResult]);

  const run = async () => {
    setBusy(true);
    setExecutionError("");
    try {
      if (!schema?.schemaId) throw new Error("Generate a schema in the workspace first.");
      setResult(await executeSqlFromApi(query, schema.schemaId));
    } catch (runError) {
      setExecutionError(runError.message);
    } finally {
      setBusy(false);
    }
  };

  const updateQuery = (nextQuery) => {
    setQuery(nextQuery);
    setExecutionError("");
  };

  return (
    <div className="flex flex-col">
      <div className="min-h-[288px] flex-1 border-b border-edge">
        <SqlEditor
          value={query}
          onChange={updateQuery}
          onRun={run}
          running={busy}
          error={executionError}
        />
      </div>
      <div className="min-h-[264px] flex-1">
        <ResultsGrid result={result} />
      </div>
    </div>
  );
}
