# DBMentor backend

This backend is intentionally separate from the existing frontend. It provides a Node/Express API and a Python NLP service.

## Services

- Node API: `http://127.0.0.1:8000`
- Python NLP service: `http://127.0.0.1:8001`

Endpoints:

- `POST /api/v1/schema/generate` with `{ "prompt": "..." }`
- `GET /api/v1/schema/active` returns the persisted active schema and sample rows
- `POST /api/v1/sql/generate` with `{ "question": "...", "schema": {...} }`
- `POST /api/v1/sql/explain` with `{ "sql": "SELECT ..." }`
- `POST /api/v1/sql/execute` with `{ "sql": "SELECT ...", "dataset": "demo" }`
- `POST /api/v1/datasets` with `{ "name": "demo", "columns": [...], "rows": [...] }`
- `GET /health`

Schema generation creates a PostgreSQL schema, tables, and five illustrative rows per table in one transaction. The active schema and its generated definition are stored in `dbmentor_generated_schemas`; refreshing the UI reloads this record and its sample results. Generating another schema makes it the active schema without deleting prior generated schemas.

The execution endpoint is deliberately restricted to read-only `SELECT` statements and runs with the selected generated schema as its PostgreSQL search path. Natural-language SQL generation receives the active schema and checks generated table references against it.

## Run locally

From the repository root:

```powershell
docker compose up -d postgres

python backend/nlp-service.py
```

In another terminal:

```powershell
$env:DATABASE_URL = "postgresql://dbmentor:dbmentor@127.0.0.1:5432/dbmentor"
$env:NLP_URL = "http://127.0.0.1:8001"
$env:NLP_TIMEOUT_MS = "300000"
npm.cmd install --prefix backend
npm.cmd start --prefix backend
```

Start the frontend in a third terminal:

```powershell
npm.cmd run dev
```

Open `http://localhost:5173`. The frontend uses `VITE_API_URL` when set and otherwise calls `http://127.0.0.1:8000`.

PostgreSQL is required for schema persistence, sample-row creation, and query execution. Without `DATABASE_URL`, schema generation and query execution return an error rather than showing demo results.

## Logging

The API writes structured JSON logs to stdout. Each request includes an `x-request-id`, HTTP method, path, status, and duration. Use `LOG_LEVEL=debug` for NLP timing and health details, or `LOG_LEVEL=warn` to reduce normal request logs. SQL text, request bodies, and database credentials are intentionally excluded.

The Python service uses Transformer inference by default. Install or update the dependencies with `python -m pip install --upgrade -r backend/requirements.txt` so existing environments are also corrected, then configure `SCHEMA_MODEL`, `STORY_MODEL`, and `SQL_MODEL` through environment variables. FLAN-T5 Small is used for schema and SQL-to-story generation. The SQL default is `gaussalgo/T5-LM-Large-text2sql-spider`, a verified Spider/Spider-Syn fine-tuned T5 checkpoint that expects `Question: ... Schema: ...` serialization. It is a large model and may need several GB of RAM. `SQL_MODEL_TYPE=spider_seq2seq` selects this adapter. This is not the SADGA+GAP architecture; SADGA+GAP requires a separate inference implementation and compatible checkpoint.

Models load lazily on the first request. The service allows only one download per model at a time and checks `MIN_FREE_DISK_GB` before loading. If dependencies, disk space, weights, or a checkpoint are unavailable, the request returns a deterministic rules fallback and `/health` exposes the reason under `model_errors`. Set `MODEL_BACKEND=rules` to intentionally disable model inference. In PowerShell, set the Hugging Face cache before starting Python with `$env:HF_HOME = 'D:\huggingface-cache'` and, optionally, `$env:HF_HUB_CACHE = 'D:\huggingface-cache\hub'`. (The `set NAME=value` syntax is for `cmd.exe`, not PowerShell.)

For computers that cannot load the large Spider T5 checkpoint, keep `MODEL_BACKEND=transformers` for FLAN schema/story functions but set `SQL_MODEL_TYPE=rules` before starting the Python service. NL-to-SQL will then use the schema-aware SQL planner without loading/downloading the Spider model. This is a lower-memory mode; SQL generation will not use the Spider Transformer checkpoint.
