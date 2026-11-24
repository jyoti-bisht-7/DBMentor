"""DBMentor NLP service.

The service is deliberately usable without model weights. Set MODEL_BACKEND=transformers
and the model ids below to enable local Hugging Face inference. The SQL model may be
replaced with a SADGA+GAP checkpoint when one is available in the deployment registry.
"""
from __future__ import annotations

import json
import os
import re
import shutil
from collections import OrderedDict
from threading import Lock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

os.environ["USE_TF"] = "0"

MODEL_BACKEND = os.getenv("MODEL_BACKEND", "transformers")
SCHEMA_MODEL = os.getenv("SCHEMA_MODEL", "google/flan-t5-small")
SQL_MODEL = os.getenv("SQL_MODEL", "gaussalgo/T5-LM-Large-text2sql-spider")
STORY_MODEL = os.getenv("STORY_MODEL", "google/flan-t5-small")
SQL_MODEL_TYPE = os.getenv("SQL_MODEL_TYPE", "spider_seq2seq")
MODEL_DEVICE = os.getenv("MODEL_DEVICE", "auto")
MAX_INPUT_TOKENS = int(os.getenv("MAX_INPUT_TOKENS", "2048"))
MAX_NEW_TOKENS = int(os.getenv("MAX_NEW_TOKENS", "512"))
MIN_FREE_DISK_GB = float(os.getenv("MIN_FREE_DISK_GB", "2"))

_generator_cache: dict[str, Any] = {}
_model_errors: dict[str, str] = {}
_model_load_lock = Lock()
_sql_cache: OrderedDict[tuple[str, str], dict[str, Any]] = OrderedDict()
_sql_cache_lock = Lock()
SQL_CACHE_SIZE = 10


def sql_cache_key(question: str, schema: dict[str, Any]) -> tuple[str, str]:
    normalized_question = re.sub(r"\s+", " ", question.strip())
    serialized_schema = json.dumps(schema, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return normalized_question, serialized_schema


def get_cached_sql(question: str, schema: dict[str, Any]) -> dict[str, Any] | None:
    key = sql_cache_key(question, schema)
    with _sql_cache_lock:
        result = _sql_cache.get(key)
        if result is not None:
            _sql_cache.move_to_end(key)
        return result


def cache_sql_result(question: str, schema: dict[str, Any], result: dict[str, Any]) -> None:
    key = sql_cache_key(question, schema)
    with _sql_cache_lock:
        _sql_cache[key] = result
        _sql_cache.move_to_end(key)
        while len(_sql_cache) > SQL_CACHE_SIZE:
            _sql_cache.popitem(last=False)


def cache_root() -> str:
    configured = os.getenv("HF_HOME") or os.getenv("HF_HUB_CACHE")
    if configured:
        return os.path.abspath(configured)
    return os.path.abspath(os.path.expanduser("~/.cache/huggingface"))


def model_cache_dir() -> str:
    configured_hub = os.getenv("HF_HUB_CACHE")
    if configured_hub:
        return os.path.abspath(configured_hub)
    configured_home = os.getenv("HF_HOME")
    if configured_home:
        return os.path.join(os.path.abspath(configured_home), "hub")
    return os.path.join(os.path.abspath(os.path.expanduser("~/.cache/huggingface")), "hub")


def _load_generator(model_id: str) -> tuple[Any, Any]:
    if model_id in _generator_cache:
        cached = _generator_cache[model_id]
        return cached["tokenizer"], cached["model"]
    if model_id in _model_errors:
        raise RuntimeError(f"Model {model_id} is unavailable: {_model_errors[model_id]}")
    with _model_load_lock:
        if model_id in _generator_cache:
            cached = _generator_cache[model_id]
            return cached["tokenizer"], cached["model"]
        model_cache = model_cache_dir()
        try:
            os.makedirs(model_cache, exist_ok=True)
        except OSError as error:
            message = f"Hugging Face cache path is unavailable: {model_cache}. Set HF_HOME to an existing drive and restart the service. ({error})"
            _model_errors[model_id] = message
            raise RuntimeError(message) from error
        disk_root = model_cache
        free_gb = shutil.disk_usage(disk_root).free / (1024 ** 3)
        if free_gb < MIN_FREE_DISK_GB:
            message = f"Only {free_gb:.2f} GB is free at {disk_root}; at least {MIN_FREE_DISK_GB:.2f} GB is required before downloading {model_id}."
            _model_errors[model_id] = message
            raise RuntimeError(message)
        try:
            print(f"Loading model {model_id}; Hugging Face cache: {model_cache}; free disk: {free_gb:.2f} GB", flush=True)
            from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
            import torch

            tokenizer = AutoTokenizer.from_pretrained(model_id, cache_dir=model_cache)
            model = AutoModelForSeq2SeqLM.from_pretrained(model_id, cache_dir=model_cache, low_cpu_mem_usage=True)
            if MODEL_DEVICE != "cpu" and torch.cuda.is_available():
                model = model.to("cuda")
            model.eval()
            _generator_cache[model_id] = {"tokenizer": tokenizer, "model": model}
            print(f"Loaded model {model_id}", flush=True)
            return tokenizer, model
        except Exception as error:
            _model_errors[model_id] = str(error)
            print(f"Model load failed for {model_id}: {error}", flush=True)
            raise


def _generate(model_id: str, prompt: str, max_new_tokens: int = MAX_NEW_TOKENS) -> str:
    tokenizer, model = _load_generator(model_id)
    import torch

    inputs = tokenizer(prompt, return_tensors="pt", truncation=True, max_length=MAX_INPUT_TOKENS)
    device = next(model.parameters()).device
    inputs = {key: value.to(device) for key, value in inputs.items()}
    with torch.inference_mode():
        output = model.generate(**inputs, max_new_tokens=max_new_tokens, num_beams=4, early_stopping=True)
    return tokenizer.decode(output[0], skip_special_tokens=True).strip()


def words(text: str) -> list[str]:
    return re.findall(r"[a-z][a-z0-9_]*", text.lower())


def singular(value: str) -> str:
    if value.endswith("ies"):
        return value[:-3] + "y"
    if value.endswith("s") and not value.endswith("ss"):
        return value[:-1]
    return value


def table_name(value: str) -> str:
    value = re.sub(r"[^a-z0-9_]+", "_", value.lower()).strip("_")
    if value.endswith("ies"):
        return value[:-3] + "y"
    if value.endswith("s") and not value.endswith("ss"):
        return value
    if value.endswith("y"):
        return value[:-1] + "ies"
    if value.endswith("ing"):
        return f"{value}_records"
    return f"{value}s"


def schema_entity_candidates(prompt: str) -> list[str]:
    excluded = {
        "a", "an", "and", "all", "are", "as", "be", "build", "can", "create", "database",
        "data", "description", "details", "each", "every", "field", "for", "from", "has",
        "have", "including", "information", "into", "management", "many", "multiple", "name",
        "of", "on", "other", "record", "records", "related", "several", "should", "store",
        "system", "table", "the", "their", "these", "this", "to", "track", "use", "with",
        "where", "which",
    }
    candidates: dict[str, int] = {}

    def add(value: str, position: int) -> None:
        normalized = singular(value.lower().strip("_"))
        if len(normalized) > 2 and normalized not in excluded:
            candidates.setdefault(normalized, position)

    patterns = (
        r"\b(?:each|every|all|multiple|many|several|various)\s+([a-z][a-z0-9_]*)",
        r"\b(?:store|track|manage|record|include|maintain|organize|handle|create|monitor)\s+(?:each|every|the|all)?\s*([a-z][a-z0-9_]*)",
        r"\b([a-z][a-z0-9_]*)\s+(?:management|tracking|reservation|booking|inventory)\s+(?:database|system)\b",
        r"\b([a-z][a-z0-9_]*)\s+(?:belong|belongs|report|reports)\s+to\s+([a-z][a-z0-9_]*)",
        r"\b([a-z][a-z0-9_]*)\s+(?:can\s+be\s+)?(?:assigned|linked|connected)\s+to\s+(?:(?:multiple|many|several)\s+)?([a-z][a-z0-9_]*)",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, prompt.lower()):
            for group in match.groups():
                add(group, match.start())

    return [table_name(name) for name, _ in sorted(candidates.items(), key=lambda item: item[1])][:8]


def generic_schema(prompt: str) -> tuple[list[tuple[str, list[tuple[str, str, str | None]]]], list[tuple[str, str]], str]:
    candidates = schema_entity_candidates(prompt)
    if not candidates:
        candidates = ["records"]

    attributes_by_table: dict[str, list[tuple[str, str, str | None]]] = {}
    for table in candidates:
        entity_forms = {table, singular(table)}
        for entity in entity_forms:
            escaped_entity = re.escape(entity)
            attribute_patterns = (
                rf"\b(?:each|every)\s+{escaped_entity}['’]s\s+([^.;]+)",
                rf"\b(?:each|every)\s+{escaped_entity}\b[^.;]*?\b(?:has|have|includes?|contains?|should\s+record|records?|stores?)\s+([^.;]+)",
                rf"\b{escaped_entity}\s+(?:with|including)\s+([^.;]+)",
            )
            for pattern in attribute_patterns:
                for match in re.finditer(pattern, prompt, re.I):
                    attributes = attributes_by_table.setdefault(table, [])
                    for raw_attribute in re.split(r",|\band\b", match.group(1), flags=re.I):
                        name = raw_attribute.strip()
                        name = re.sub(r"^(?:a|an|the)\s+", "", name, flags=re.I)
                        name = re.sub(r"^(?:[a-z][a-z0-9_]*['’]s)\s+", "", name, flags=re.I)
                        name = re.sub(r"[^a-zA-Z0-9]+", "_", name).strip("_").lower()
                        if not name or name in {"and", "or"} or name == "id":
                            continue
                        if any(term in name for term in ("date", "time", " at")) or name.endswith("_at"):
                            data_type = "ts" if "time" in name or name.endswith("_at") else "date"
                        elif any(term in name for term in ("salary", "amount", "hours", "price", "count", "quantity")):
                            data_type = "num"
                        else:
                            data_type = "text"
                        if not any(column[0] == name for column in attributes):
                            attributes.append((name, data_type, None))

    definitions = []
    for name in candidates:
        columns = [("id", "int", "pk")]
        columns.extend(attributes_by_table.get(name) or [("name", "text", None)])
        definitions.append((name, columns))

    entity_tables = {singular(name): name for name in candidates}
    edges = []
    child_foreign_keys: dict[str, str] = {}
    for match in re.finditer(
        r"\b([a-z][a-z0-9_]*)\s+(?:belong|belongs|report|reports)\s+to\s+([a-z][a-z0-9_]*)",
        prompt.lower(),
    ):
        child = entity_tables.get(singular(match.group(1)))
        parent = entity_tables.get(singular(match.group(2)))
        if child and parent and child != parent:
            edges.append((parent, child))
            child_foreign_keys[child] = f"{singular(parent)}_id"
    connected_tables = {table for edge in edges for table in edge}
    for name in candidates[1:]:
        if name not in connected_tables:
            edges.append((candidates[0], name))
            child_foreign_keys[name] = f"{singular(candidates[0])}_id"
            connected_tables.update((candidates[0], name))
    for table, columns in definitions:
        foreign_key = child_foreign_keys.get(table)
        if foreign_key:
            columns.append((foreign_key, "fk", "fk"))

    explanation = (
        f"These tables were identified from the entities mentioned in your requirement: "
        f"{', '.join(candidates)}. Primary keys identify each record; foreign keys connect related tables."
    )
    return definitions, edges, explanation


def is_flight_schema_prompt(prompt: str) -> bool:
    prompt_words = set(words(prompt))
    return bool(prompt_words & {"flight", "flights", "airline", "airlines", "airport", "airports", "aircraft"})


def infer_schema(prompt: str) -> dict[str, Any]:
    prompt_words = set(words(prompt))
    flight_schema = is_flight_schema_prompt(prompt)
    domains = [
        ("banking", ("bank", "banking", "client", "manager", "loan", "deposit"), ["clients", "managers", "loans", "deposits"]),
        ("railway", ("railway", "railroad", "train", "station", "passenger", "ticket", "route", "schedule"), ["passengers", "stations", "trains", "routes", "schedules", "bookings"]),
        ("library", ("library", "book", "borrow", "loan"), ["members", "books", "loans"]),
        ("school", ("school", "student", "course", "class", "enroll"), ["students", "courses", "enrollments"]),
        ("store", ("shop", "order", "product", "cart"), ["customers", "orders", "items", "products"]),
    ]
    key, _, _ = max(domains, key=lambda item: sum(token in prompt_words for token in item[1]))
    if flight_schema:
        key = "flight"
    match_score = 1 if flight_schema else sum(token in prompt_words for token in next(domain[1] for domain in domains if domain[0] == key))
    if key == "flight":
        table_defs = [
            ("passengers", [("id", "int", "pk"), ("full_name", "text", None), ("email", "text", None), ("phone", "text", None)]),
            ("airports", [("id", "int", "pk"), ("code", "text", None), ("name", "text", None), ("city", "text", None)]),
            ("flights", [("id", "int", "pk"), ("flight_number", "text", None), ("origin_airport_id", "fk", "fk"), ("destination_airport_id", "fk", "fk"), ("departure_at", "ts", None), ("arrival_at", "ts", None), ("status", "text", None)]),
            ("reservations", [("id", "int", "pk"), ("passenger_id", "fk", "fk"), ("flight_id", "fk", "fk"), ("seat_number", "text", None), ("fare", "num", None), ("booking_status", "text", None)]),
        ]
        edges = [
            ("passengers", "reservations"),
            ("flights", "reservations"),
            ("airports", "flights"),
        ]
        explanation = "Passengers reserve seats on flights. Each flight has an origin and destination airport, and reservations connect passengers to flights with a seat, fare, and booking status."
        match_score = max(match_score, 1)
    elif key == "banking":
        table_defs = [
            ("clients", [("id", "int", "pk"), ("name", "text", None), ("email", "text", None)]),
            ("managers", [("id", "int", "pk"), ("name", "text", None), ("email", "text", None)]),
            ("loans", [("id", "int", "pk"), ("client_id", "fk", "fk"), ("manager_id", "fk", "fk"), ("amount", "num", None), ("status", "text", None)]),
            ("deposits", [("id", "int", "pk"), ("client_id", "fk", "fk"), ("amount", "num", None), ("deposited_at", "ts", None)]),
        ]
        edges = [("clients", "loans"), ("managers", "loans"), ("clients", "deposits")]
        explanation = "clients own loans and deposits, while managers oversee loans. Foreign keys preserve those relationships without repeating client or manager details."
    elif key == "railway":
        table_defs = [
            ("passengers", [("id", "int", "pk"), ("name", "text", None), ("email", "text", None), ("phone", "text", None)]),
            ("stations", [("id", "int", "pk"), ("name", "text", None), ("city", "text", None)]),
            ("trains", [("id", "int", "pk"), ("train_number", "text", None), ("name", "text", None), ("capacity", "int", None)]),
            ("routes", [("id", "int", "pk"), ("name", "text", None)]),
            ("schedules", [("id", "int", "pk"), ("train_id", "fk", "fk"), ("route_id", "fk", "fk"), ("departure_at", "ts", None), ("arrival_at", "ts", None)]),
            ("bookings", [("id", "int", "pk"), ("passenger_id", "fk", "fk"), ("schedule_id", "fk", "fk"), ("seat_number", "text", None), ("status", "text", None), ("fare", "num", None)]),
        ]
        edges = [("trains", "schedules"), ("routes", "schedules"), ("passengers", "bookings"), ("schedules", "bookings")]
        explanation = "passengers reserve seats on scheduled trains. Schedules connect a train to a route and bookings connect passengers to a specific scheduled journey."
    elif key == "library":
        table_defs = [
            ("members", [("id", "int", "pk"), ("name", "text", None), ("joined_at", "ts", None)]),
            ("books", [("id", "int", "pk"), ("title", "text", None), ("author", "text", None)]),
            ("loans", [("id", "int", "pk"), ("member_id", "fk", "fk"), ("book_id", "fk", "fk"), ("due_on", "date", None)]),
        ]
        edges = [("members", "loans"), ("books", "loans")]
        explanation = "loans records which member borrowed which book and keeps the relationship history in one place."
    elif key == "school":
        table_defs = [
            ("students", [("id", "int", "pk"), ("name", "text", None), ("email", "text", None)]),
            ("courses", [("id", "int", "pk"), ("code", "text", None), ("teacher_id", "fk", "fk")]),
            ("enrollments", [("student_id", "fk", "fk"), ("course_id", "fk", "fk"), ("grade", "text", None)]),
            ("teachers", [("id", "int", "pk"), ("name", "text", None)]),
        ]
        edges = [("students", "enrollments"), ("courses", "enrollments"), ("teachers", "courses")]
        explanation = "enrollments resolves the many-to-many relationship between students and courses, while teachers own courses."
    else:
        table_defs = [
            ("customers", [("id", "int", "pk"), ("email", "text", None), ("name", "text", None)]),
            ("orders", [("id", "int", "pk"), ("customer_id", "fk", "fk"), ("total", "num", None), ("placed_at", "ts", None)]),
            ("products", [("id", "int", "pk"), ("sku", "text", None), ("price", "num", None)]),
            ("items", [("id", "int", "pk"), ("order_id", "fk", "fk"), ("product_id", "fk", "fk"), ("qty", "int", None)]),
        ]
        edges = [("customers", "orders"), ("orders", "items"), ("products", "items")]
        explanation = "orders belongs to one customer and items bridges orders to products, preserving quantity and future price snapshots."
    if match_score == 0:
        key = "custom"
        table_defs, edges, explanation = generic_schema(prompt)
    result_tables = []
    for index, (name, columns) in enumerate(table_defs):
        result_tables.append({
            "name": name,
            "tone": ["cyan", "amber", "violet", "rose"][index % 4],
            "x": [5, 40, 68, 70][index % 4],
            "y": [60, 150, 46, 232][index % 4],
            "columns": [{"name": col, "type": typ, **({"key": marker} if marker else {})} for col, typ, marker in columns],
        })
    return {
        "key": key,
        "title": f"{key.title()} schema" if key != "custom" else f"{singular(table_defs[0][0]).title()} system schema",
        "prompt": prompt,
        "matched": match_score > 0,
        "tables": result_tables,
        "edges": [{"from": a, "to": b, "tone": "cyan", "label": "1..N"} for a, b in edges],
        "explanation": explanation,
        "suggestions": [
            {"tone": "mint", "title": "Index foreign keys", "note": "faster joins and referential lookups"},
            {"tone": "amber", "title": "Add domain constraints", "note": "rejects invalid values at the database boundary"},
            {"tone": "violet", "title": "Review nullable attributes", "note": "keeps optional facts explicit"},
        ],
    }


def _json_object(text: str) -> dict[str, Any]:
    candidate = text.strip().replace("```json", "").replace("```", "").strip()
    match = re.search(r"\{[\s\S]*\}", candidate)
    if not match:
        raise ValueError("The schema model did not return a JSON object")
    value = json.loads(match.group(0))
    if not isinstance(value, dict):
        raise ValueError("The schema model returned a non-object JSON value")
    return value


def schema_context(schema: dict[str, Any]) -> str:
    lines = []
    for table in schema.get("tables", []):
        columns = ", ".join(f"{column['name']}:{column.get('type', 'text')}" for column in table.get("columns", []))
        lines.append(f"table {table['name']}({columns})")
    for edge in schema.get("edges", []):
        lines.append(f"relationship {edge['from']} -> {edge['to']} ({edge.get('label', 'related')})")
    return "\n".join(lines)


def schema_from_transformer(prompt: str) -> dict[str, Any]:
    instruction = f"""Generate a normalized relational database schema for this requirement:
{prompt}
Return JSON only: {{"title":"short title","explanation":"brief explanation","tables":[{{"name":"table_name","columns":[{{"name":"id","type":"int","key":"pk"}}]}}],"relationships":[{{"from":"parent","to":"child","label":"1..N"}}]}}
Use only types int, text, num, date, ts. Include primary and foreign keys. No markdown or SQL."""
    raw = _json_object(_generate(SCHEMA_MODEL, instruction, max_new_tokens=768))
    tables = []
    for index, table in enumerate(raw.get("tables", [])[:12]):
        if not isinstance(table, dict) or not table.get("name"):
            continue
        columns = []
        for column in table.get("columns", []):
            if not isinstance(column, dict) or not column.get("name"):
                continue
            item = {"name": str(column["name"]).lower(), "type": str(column.get("type", "text")).lower()}
            if column.get("key") in ("pk", "fk"):
                item["key"] = column["key"]
            columns.append(item)
        if columns:
            tables.append({"name": str(table["name"]).lower(), "tone": ["cyan", "amber", "violet", "rose"][index % 4], "x": [5, 40, 68, 70][index % 4], "y": [60, 150, 46, 232][index % 4], "columns": columns})
    if not tables:
        raise ValueError("The schema model returned no valid tables")
    generated_table_names = {table["name"] for table in tables}
    prompt_words = set(re.findall(r"[a-z][a-z0-9_]*", prompt.lower()))
    grounded_entity_words = {
        singular(word)
        for word in prompt_words
    } | {
        singular(word)
        for entity in schema_entity_candidates(prompt)
        for word in entity.split("_")
    }
    if grounded_entity_words:
        ungrounded_tables = [
            table["name"]
            for table in tables
            if not all(
                singular(part) in grounded_entity_words
                for part in table["name"].split("_")
                if part not in {"data", "records", "details"}
            )
        ]
        if ungrounded_tables:
            raise ValueError(
                "The schema model returned tables not grounded in the requirement: "
                + ", ".join(ungrounded_tables)
            )
    if is_flight_schema_prompt(prompt):
        required_flight_tables = {"flights"}
        if prompt_words & {"airport", "airports"}:
            required_flight_tables.add("airports")
        if prompt_words & {"passenger", "passengers"}:
            required_flight_tables.add("passengers")
        if prompt_words & {"reservation", "reservations", "booking", "bookings"}:
            required_flight_tables.add("reservations")
        if not required_flight_tables.issubset(generated_table_names) or generated_table_names & {"trains", "schedules", "stations"}:
            raise ValueError("The schema model returned an incomplete or non-flight schema for a flight requirement")
    expected_domains = {
        "railway": ({"railway", "railroad", "train", "station", "passenger", "ticket", "route", "schedule"}, {"passengers", "stations", "trains", "routes", "schedules", "bookings"}),
        "banking": ({"bank", "banking", "client", "manager", "loan", "deposit"}, {"clients", "managers", "loans", "deposits"}),
    }
    for domain_words, expected_tables in expected_domains.values():
        if not is_flight_schema_prompt(prompt) and len(prompt_words & domain_words) >= 2 and not (generated_table_names & expected_tables):
            raise ValueError("The schema model returned tables unrelated to the requested domain")
    known = {table["name"] for table in tables}
    edges = [{"from": relation["from"], "to": relation["to"], "tone": "cyan", "label": relation.get("label", "1..N")} for relation in raw.get("relationships", []) if isinstance(relation, dict) and relation.get("from") in known and relation.get("to") in known]
    return {"key": "transformer", "title": raw.get("title", "Generated schema"), "prompt": prompt, "matched": True, "tables": tables, "edges": edges, "explanation": raw.get("explanation", "Generated by FLAN-T5."), "suggestions": []}


def sql_from_seq2seq(question: str, schema: dict[str, Any]) -> str:
    tables = schema.get("tables", [])
    table_names = {table["name"].lower() for table in tables}
    edges = schema.get("edges", [])
    serialized_tables = []
    for table in tables:
        table_name_value = table["name"].lower()
        serialized_columns = []
        primary_keys = []
        foreign_keys = []
        for column in table.get("columns", []):
            column_name = column["name"].lower()
            column_type = {"int": "int", "fk": "int", "text": "text", "num": "number", "date": "date", "ts": "time"}.get(column.get("type"), "text")
            serialized_columns.extend([f'"{column_name}"', column_type])
            if column.get("key") == "pk":
                primary_keys.append(column_name)
            if column.get("key") == "fk" or column_name.endswith("_id"):
                stem = column_name[:-3] if column_name.endswith("_id") else ""
                candidates = [stem, f"{stem}s", f"{stem}es", f"{stem[:-1]}ies" if stem.endswith("y") else ""]
                parent = next((candidate for candidate in candidates if candidate in table_names and candidate != table_name_value), None)
                if not parent:
                    parent = next((str(edge.get("from", "")).lower() for edge in edges if str(edge.get("to", "")).lower() == table_name_value), None)
                if parent:
                    foreign_keys.append(f'foreign_key: "{column_name}" {column_type} from "{parent}" "id"')
        parts = [f'"{table_name_value}"', *serialized_columns]
        parts.extend(foreign_keys)
        if primary_keys:
            parts.append("primary key: " + " ".join(f'"{key}"' for key in primary_keys))
        serialized_tables.append(" ".join(parts) + " [SEP]")
    schema_serialization = " ".join(serialized_tables)
    instruction = f"Question: {question} Schema: {schema_serialization}"
    raw = _generate(SQL_MODEL, instruction)
    match = re.search(r"(?is)(select\b[\s\S]*?;?)(?:$|```)", raw.strip())
    if not match:
        raise ValueError("The configured text-to-SQL checkpoint did not return a SELECT statement")
    sql = match.group(1).strip().replace("```", "")
    if not re.match(r"(?is)^select\b", sql):
        raise ValueError("The SQL model returned a non-SELECT statement")
    sql = normalize_sql(sql)
    return sql


def normalize_sql(sql: str) -> str:
    clean = re.sub(r"\s+", " ", str(sql).strip())
    clean = re.sub(r"\*FROM\b", "* FROM", clean, flags=re.I)
    clean = re.sub(r"([A-Za-z0-9_)])FROM\b", r"\1 FROM", clean, flags=re.I)
    clean = re.sub(r"([A-Za-z0-9_])JOIN\b", r"\1 JOIN", clean, flags=re.I)
    clean = re.sub(r"\bJOIN([A-Za-z_])", r"JOIN \1", clean, flags=re.I)
    clean = re.sub(r"\bON([A-Za-z_])", r"ON \1", clean, flags=re.I)
    clean = re.sub(r"([A-Za-z0-9_)])WHERE\b", r"\1 WHERE", clean, flags=re.I)
    clean = re.sub(r"([A-Za-z0-9_)])GROUP\s+BY\b", r"\1 GROUP BY", clean, flags=re.I)
    clean = re.sub(r"([A-Za-z0-9_)])ORDER\s+BY\b", r"\1 ORDER BY", clean, flags=re.I)
    clean = re.sub(r"([A-Za-z0-9_)])LIMIT\b", r"\1 LIMIT", clean, flags=re.I)
    clean = re.sub(r"\s*;\s*$", "", clean)
    clean = re.sub(r"(?is)\bFROM\b", "\nFROM", clean, count=1)
    clean = re.sub(r"(?is)\bJOIN\b", "\nJOIN", clean)
    clean = re.sub(r"(?is)\bWHERE\b", "\nWHERE", clean)
    clean = re.sub(r"(?is)\bGROUP\s+BY\b", "\nGROUP BY", clean)
    clean = re.sub(r"(?is)\bHAVING\b", "\nHAVING", clean)
    clean = re.sub(r"(?is)\bORDER\s+BY\b", "\nORDER BY", clean)
    clean = re.sub(r"(?is)\bLIMIT\b", "\nLIMIT", clean)
    clean = re.sub(r"(?is)\bOFFSET\b", "\nOFFSET", clean)
    clean = re.sub(r"\n\s*\n", "\n", clean)
    clean = re.sub(r"\n\s+", "\n", clean)
    return clean.rstrip() + ";"


def validate_sql_tables(sql: str, schema: dict[str, Any]) -> None:
    allowed = {table["name"].lower(): {column["name"].lower() for column in table.get("columns", [])} for table in schema.get("tables", [])}
    referenced = re.findall(r"\b(?:FROM|JOIN)\s+([a-zA-Z_][\w]*)", sql, re.I)
    unknown = sorted({name.lower() for name in referenced} - set(allowed))
    if unknown:
        raise ValueError(f"Generated SQL references tables outside the active schema: {', '.join(unknown)}")
    aliases = {}
    for match in re.finditer(r"\b(?:FROM|JOIN)\s+([a-zA-Z_][\w]*)(?:\s+(?:AS\s+)?([a-zA-Z_][\w]*))?", sql, re.I):
        table_name_value, alias = match.group(1).lower(), match.group(2)
        if table_name_value in allowed and alias and alias.lower() not in {"where", "join", "left", "right", "inner", "outer", "on", "group", "order", "limit"}:
            aliases[alias.lower()] = table_name_value
    aliases.update({name: name for name in allowed})
    invalid_columns = []
    for table_ref, column_ref in re.findall(r"\b([a-zA-Z_][\w]*)\.([a-zA-Z_][\w]*)\b", sql):
        table_name_value = aliases.get(table_ref.lower())
        if table_name_value and column_ref.lower() not in allowed[table_name_value]:
            invalid_columns.append(f"{table_ref}.{column_ref}")
    if invalid_columns:
        raise ValueError(f"Generated SQL references columns outside the active schema: {', '.join(sorted(set(invalid_columns)))}")


def story_from_transformer(sql: str, question: str = "") -> list[str]:
    request_context = f"User request: {question.strip()}\n" if question.strip() else ""
    prompt = (
        "Explain how this PostgreSQL query answers the user's request to a beginner. "
        "Use short, accurate numbered steps, explain the purpose of each SQL clause that appears, "
        "and do not describe clauses that are absent.\n"
        f"{request_context}SQL:\n{sql}"
    )
    raw = _generate(STORY_MODEL, prompt, max_new_tokens=256)
    return [re.sub(r"^\s*(?:[-*]|\d+[.)])\s*", "", line).strip() for line in raw.splitlines() if line.strip()]


def schema_sql(schema: dict[str, Any]) -> str:
    type_map = {"int": "INTEGER", "text": "TEXT", "num": "NUMERIC", "ts": "TIMESTAMPTZ", "date": "DATE", "fk": "INTEGER"}
    table_names = {table["name"] for table in schema.get("tables", [])}

    def foreign_table(column_name: str) -> str | None:
        if not column_name.endswith("_id"):
            return None
        stem = column_name[:-3]
        base_stem = re.sub(r"^(?:origin|destination)_", "", stem)
        candidates = [
            stem,
            f"{stem}s",
            f"{stem}es",
            f"{stem[:-1]}ies" if stem.endswith("y") else "",
            base_stem,
            f"{base_stem}s",
            f"{base_stem}es",
            f"{base_stem[:-1]}ies" if base_stem.endswith("y") else "",
        ]
        return next((candidate for candidate in candidates if candidate in table_names), None)

    blocks = []
    for table in schema.get("tables", []):
        columns = []
        for column in table.get("columns", []):
            typ = type_map.get(column.get("type"), "TEXT")
            line = f"  {column['name']} {typ}"
            if column.get("key") == "pk":
                line += " PRIMARY KEY"
            elif column.get("key") == "fk":
                target = foreign_table(column["name"])
                if target:
                    line += f" REFERENCES {target}(id)"
            columns.append(line)
        column_sql = ",\n".join(columns)
        blocks.append(f"CREATE TABLE {table['name']} (\n{column_sql}\n);")
    return "\n\n".join(blocks)


def english_to_sql(question: str, schema: dict[str, Any] | None = None) -> str:
    text = question.lower()
    question_tokens = words(text)
    question_words = set(question_tokens)
    tables = (schema or {}).get("tables", [])
    if not tables:
        raise ValueError("A generated schema with tables is required to generate SQL")

    table_by_name = {table["name"].lower(): table for table in tables}

    def phrase_present(phrase: str) -> bool:
        phrase_words = [singular(token) for token in words(phrase.replace("_", " "))]
        normalized_question = [singular(token) for token in question_tokens]
        return bool(phrase_words) and any(
            normalized_question[index:index + len(phrase_words)] == phrase_words
            for index in range(len(normalized_question) - len(phrase_words) + 1)
        )

    table_scores: dict[str, int] = {}
    explicit_tables: set[str] = set()
    table_positions: dict[str, int] = {}
    matched_columns: dict[str, list[str]] = {}
    for table_name_value, table_data in table_by_name.items():
        score = 0
        table_match = re.search(rf"\b{re.escape(table_name_value.replace('_', ' '))}\b", text)
        singular_match = re.search(rf"\b{re.escape(singular(table_name_value).replace('_', ' '))}\b", text)
        if phrase_present(table_name_value):
            score += 12
            explicit_tables.add(table_name_value)
            table_positions[table_name_value] = table_match.start() if table_match else (singular_match.start() if singular_match else 0)
        singular_name = singular(table_name_value)
        if singular_name != table_name_value and phrase_present(singular_name):
            score += 10
            explicit_tables.add(table_name_value)
            table_positions[table_name_value] = table_match.start() if table_match else (singular_match.start() if singular_match else 0)
        column_hits = []
        for column in table_data.get("columns", []):
            column_name = column["name"].lower()
            if column_name in ("id",) or column_name.endswith("_id"):
                continue
            if phrase_present(column_name):
                column_hits.append(column_name)
                score += 4 if column_name not in ("name", "status", "type") else 2
        table_scores[table_name_value] = score
        matched_columns[table_name_value] = column_hits

    column_owners: dict[str, set[str]] = {}
    for table_name_value, table_data in table_by_name.items():
        for column in table_data.get("columns", []):
            column_name = column["name"].lower()
            if column_name not in ("id",) and not column_name.endswith("_id"):
                column_owners.setdefault(column_name, set()).add(table_name_value)

    generic_column_names = {"name", "status", "type", "description", "date", "created_at", "updated_at"}
    negative_match = re.search(r"\b(?:no|without|not any|none of the)\s+([a-z][a-z_ ]*?)(?:\s+(?:enrolled|registered|assigned|associated|belonging|with)\b|[?.!,]|$)", text)
    negated_table = None
    if negative_match:
        negated_words = {singular(token) for token in words(negative_match.group(1))}
        negated_table = next((name for name in table_by_name if {singular(token) for token in words(name)} & negated_words), None)

    required = set(explicit_tables)
    if negated_table:
        required.discard(negated_table)
    for table_name_value, hits in matched_columns.items():
        if table_name_value in explicit_tables:
            continue
        if any(hit not in generic_column_names and len(column_owners.get(hit, ())) == 1 for hit in hits):
            required.add(table_name_value)
    if not required:
        raise ValueError("Could not match the question to any table or column in the active schema. Mention a schema table or column explicitly.")

    # Build join edges from FK-like columns and explicit relationship metadata.
    graph: dict[str, list[tuple[str, str, str]]] = {name: [] for name in table_by_name}
    for child_name, table_data in table_by_name.items():
        for column in table_data.get("columns", []):
            column_name = column["name"].lower()
            if not (column.get("key") == "fk" or column_name.endswith("_id")):
                continue
            stem = column_name[:-3]
            candidates = [stem, f"{stem}s", f"{stem}es", f"{stem[:-1]}ies" if stem.endswith("y") else ""]
            parent_name = next((candidate for candidate in candidates if candidate in table_by_name and candidate != child_name), None)
            if parent_name:
                graph[parent_name].append((child_name, f"{parent_name}.id", f"{child_name}.{column_name}"))
                graph[child_name].append((parent_name, f"{child_name}.{column_name}", f"{parent_name}.id"))
    for edge in (schema or {}).get("edges", []):
        parent = str(edge.get("from", "")).lower()
        child = str(edge.get("to", "")).lower()
        if parent in graph and child in graph and not any(neighbor == child for neighbor, _, _ in graph[parent]):
            child_fk = next((column["name"] for column in table_by_name[child].get("columns", []) if column["name"].lower().endswith("_id")), None)
            if child_fk:
                graph[parent].append((child, f"{parent}.id", f"{child}.{child_fk}"))
                graph[child].append((parent, f"{child}.{child_fk}", f"{parent}.id"))

    def path_between(start: str, target: str) -> list[tuple[str, str, str]] | None:
        queue = [(start, [])]
        visited = {start}
        while queue:
            current, path = queue.pop(0)
            if current == target:
                return path
            for neighbor, left, right in graph[current]:
                if neighbor not in visited:
                    visited.add(neighbor)
                    queue.append((neighbor, path + [(neighbor, left, right)]))
        return None

    root_candidates = [name for name in required if name in explicit_tables]
    if negated_table and negative_match:
        preceding_tables = [name for name in root_candidates if table_positions.get(name, -1) < negative_match.start()]
        root = max(preceding_tables, key=lambda name: table_positions[name]) if preceding_tables else max(required, key=lambda name: table_scores[name])
    elif root_candidates:
        root = min(root_candidates, key=lambda name: table_positions.get(name, 10**9))
    else:
        root = max(required, key=lambda name: table_scores[name])
    joined = {root}
    join_clauses = []
    for target in sorted(required - {root}, key=lambda name: table_scores[name], reverse=True):
        options = [(len(path), source, path) for source in joined if (path := path_between(source, target)) is not None]
        if not options:
            raise ValueError(f"Tables {root} and {target} are not connected by a relationship in the active schema")
        _, _, path = min(options, key=lambda item: item[0])
        for table_name_value, left, right in path:
            if table_name_value not in joined:
                join_clauses.append(f"JOIN {table_name_value} ON {left} = {right}")
                joined.add(table_name_value)

    where_clauses = []
    if negated_table:
        path = path_between(root, negated_table)
        if not path:
            raise ValueError(f"No relationship path connects {root} to {negated_table} in the active schema")
        first_join_table, left_key, right_key = path[0]
        where_clauses.append(f"NOT EXISTS (SELECT 1 FROM {first_join_table} WHERE {left_key} = {right_key})")

    requested_column_words = {"name", "email", "phone", "code", "grade", "title", "status", "number", "date", "amount", "price", "balance", "fare", "address"}
    explicit_column_words = question_words & requested_column_words
    selected_columns = []
    for table_name_value in joined:
        table_data = table_by_name[table_name_value]
        for column in table_data.get("columns", []):
            column_name = column["name"].lower()
            column_terms = set(words(column_name.replace("_", " ")))
            if column_name == "id" or column_name.endswith("_id"):
                continue
            if column_name in matched_columns[table_name_value] or (explicit_column_words & column_terms):
                selected_columns.append(f"{table_name_value}.{column_name}")
        list_request = any(verb in text for verb in ("list", "show", "display", "find"))
        if table_name_value in explicit_tables and ("name" in question_words or (list_request and explicit_column_words)):
            name_column = next((column["name"] for column in table_data.get("columns", []) if column["name"].lower() == "name"), None)
            qualified_name = f"{table_name_value}.{name_column}" if name_column else None
            if qualified_name and qualified_name not in selected_columns:
                selected_columns.append(qualified_name)
    count = any(phrase in text for phrase in ("how many", "count", "number of"))
    selection = "COUNT(*) AS count" if count else ", ".join(dict.fromkeys(selected_columns)) or "*"
    lines = [f"SELECT {selection}", f"FROM {root}", *join_clauses]

    amount_match = re.search(r"\b(?:over|above|more than|greater than|at least|under|below|less than)\s+(\d+(?:\.\d+)?)\b", text)
    if amount_match:
        comparator = "<" if any(term in text for term in ("under", "below", "less than")) else ">"
        numeric_column = next((f"{name}.{column['name']}" for name in joined for column in table_by_name[name].get("columns", []) if column.get("type") in ("int", "num") and any(term in column["name"].lower() for term in ("amount", "total", "price", "balance", "fare", "cost", "credit"))), None)
        if numeric_column:
            where_clauses.append(f"{numeric_column} {comparator} {amount_match.group(1)}")

    for table_name_value in joined:
        for column in table_by_name[table_name_value].get("columns", []):
            column_name = column["name"].lower()
            if column.get("type") != "text" or not phrase_present(column_name):
                continue
            escaped_column = re.escape(column_name.replace("_", " "))
            value_match = re.search(rf"\b{escaped_column}\b\s*(?:is|equals|=|of)\s*['\"]?([a-z0-9_-]+)", question, re.I)
            if value_match:
                value = value_match.group(1).replace("'", "''")
                where_clauses.append(f"{table_name_value}.{column_name} = '{value}'")
    for table_name_value in joined:
        for column in table_by_name[table_name_value].get("columns", []):
            column_name = column["name"].lower()
            if column.get("type") != "text":
                continue
            value_match = None
            if column_name in ("flight_number", "train_number", "booking_number", "reservation_number"):
                value_match = re.search(r"\b(?:flight|train|booking|reservation)(?:\s+number)?\s+(?:is\s+|equals\s+|=\s*)?([A-Za-z0-9_-]+)", question, re.I)
            elif column_name in ("code", "status", "city"):
                patterns = [
                    rf"\b{re.escape(column_name.replace('_', ' '))}\b\s*(?:is|equals|=|of)\s*['\"]?([a-z0-9_-]+)",
                    rf"\b(status|with\s+status)\s+(confirmed|cancelled|canceled|pending|scheduled|delayed)",
                ]
                if column_name == "code":
                    patterns.append(r"\b(?:from|to)\s+([A-Z]{3})\b")
                for pattern in patterns:
                    value_match = re.search(pattern, question, re.I)
                    if value_match:
                        break
            if value_match:
                groups = value_match.groups()
                value = next((group for group in reversed(groups) if group), "")
                if value:
                    value = value.replace("'", "''")
                    where_clauses.append(f"{table_name_value}.{column_name} = '{value}'")
    if where_clauses:
        lines.append("WHERE " + " AND ".join(where_clauses))

    group_match = re.search(r"\b(?:per|for each|in each|grouped by|group by|by|each)\s+(?:the\s+)?([a-z][a-z_ ]*?)(?:\s+(?:and|with|over|under|above|below|where|whose|enrolled|registered)|[?.!,]|$)", text)
    if count and group_match:
        group_phrase = group_match.group(1).strip()
        normalized_group_words = {singular(token) for token in words(group_phrase)}
        group_table = next((name for name in joined if singular(name) in normalized_group_words or any(singular(token) in normalized_group_words for token in words(name))), None)
        if group_table is None:
            group_table = next((name for name in joined if {singular(token) for token in words(name)} & normalized_group_words), None)
        if group_table:
            group_column = next((column["name"] for column in table_by_name[group_table].get("columns", []) if column["name"].lower() in ("name", "code", "title")), None)
            group_column = group_column or "id"
            selection = f"{group_table}.{group_column}, COUNT(*) AS count"
            lines[0] = f"SELECT {selection}"
            lines.append(f"GROUP BY {group_table}.{group_column}")

    recent = any(word in text for word in ("recent", "latest", "newest"))
    if recent:
        date_column = next((f"{name}.{column['name']}" for name in joined for column in table_by_name[name].get("columns", []) if column.get("type") in ("date", "ts") or any(term in column["name"].lower() for term in ("date", "time", "created", "at"))), None)
        if date_column:
            lines.append(f"ORDER BY {date_column} DESC")
    limit_match = re.search(r"\b(?:top|first|limit)\s+(\d+)\b", text)
    if limit_match:
        lines.append(f"LIMIT {limit_match.group(1)}")
    return "\n".join(lines) + ";"


def sql_to_story(sql: str, question: str = "") -> list[str]:
    clean = re.sub(r"\s+", " ", sql.strip()).rstrip(";")
    from_match = re.search(r"\bFROM\s+([\w.]+)(?:\s+(?:AS\s+)?\w+)?", clean, re.I)
    if not from_match:
        return ["Write a SELECT query to see it translated into plain English."]
    select_match = re.search(r"\bSELECT\s+(.+?)\s+FROM\b", clean, re.I)
    lines = []

    if select_match:
        selection = select_match.group(1).strip()
        if re.match(r"(?is)^DISTINCT\b", selection):
            selection = re.sub(r"(?is)^DISTINCT\s*", "", selection)
            lines.append("SELECT DISTINCT: return only unique result rows, removing duplicate matches.")
        lines.append(f"SELECT: choose {'all columns (*)' if selection == '*' else f'these columns or values: {selection}'}.")
        aggregate_descriptions = {
            "COUNT": "count the matching rows or values",
            "SUM": "add the matching numeric values",
            "AVG": "calculate the average of the matching numeric values",
            "MIN": "find the smallest matching value",
            "MAX": "find the largest matching value",
        }
        aggregates = [
            f"{function} ({aggregate_descriptions[function]})"
            for function in aggregate_descriptions
            if re.search(rf"\b{function}\s*\(", selection, re.I)
        ]
        if aggregates:
            lines.append(f"Calculate the requested summary: {', '.join(aggregates)}.")

    table = from_match.group(1)
    lines.append(f"FROM: start with the {table} table and read its rows.")

    join_pattern = re.compile(
        r"\b(LEFT\s+JOIN|INNER\s+JOIN|JOIN)\s+([\w.]+)"
        r"(?:\s+(?:AS\s+)?(?!ON\b)\w+)?\s+ON\s+([^\s=]+)\s*=\s*([^\s,;]+)",
        re.I,
    )
    for join in join_pattern.finditer(clean):
        kind = join.group(1).upper()
        if kind.startswith("LEFT"):
            lines.append(
                f"LEFT JOIN: add matching rows from {join.group(2)} while retaining unmatched rows from the left side."
            )
        else:
            lines.append(f"JOIN: combine rows from {join.group(2)} that match the main row set.")
        lines.append(
            f"ON: connect the tables where {join.group(3).strip()} equals {join.group(4).strip()}."
        )

    where = re.search(r"\bWHERE\s+(.+?)(?=\s+(?:GROUP BY|HAVING|ORDER BY|LIMIT)\b|$)", clean, re.I)
    if where:
        lines.append(f"WHERE: keep only rows that satisfy {where.group(1).strip()}.")
    group = re.search(r"\bGROUP BY\s+(.+?)(?=\s+(?:HAVING|ORDER BY|LIMIT)\b|$)", clean, re.I)
    if group:
        lines.append(f"GROUP BY: collapse the remaining rows into one group per {group.group(1).strip()}.")
    having = re.search(r"\bHAVING\s+(.+?)(?=\s+(?:ORDER BY|LIMIT|OFFSET)\b|$)", clean, re.I)
    if having:
        lines.append(f"HAVING: keep only groups that satisfy {having.group(1).strip()}.")
    order = re.search(r"\bORDER BY\s+(.+?)(?=\s+LIMIT\b|$)", clean, re.I)
    if order:
        direction = "highest to lowest" if re.search(r"\bDESC\b", order.group(1), re.I) else "lowest to highest"
        order_column = re.sub(r"\s+(?:DESC|ASC)\b", "", order.group(1), flags=re.I).strip()
        lines.append(f"ORDER BY: sort the result by {order_column} from {direction}.")
    limit = re.search(r"\bLIMIT\s+(\d+)", clean, re.I)
    if limit:
        lines.append(f"LIMIT: return only the first {limit.group(1)} rows.")
    offset = re.search(r"\bOFFSET\s+(\d+)", clean, re.I)
    if offset:
        lines.append(f"OFFSET: skip the first {offset.group(1)} rows before returning results.")
    return lines


def model_status() -> dict[str, Any]:
    return {"backend": MODEL_BACKEND, "schema_model": SCHEMA_MODEL, "sql_model": SQL_MODEL, "sql_model_type": SQL_MODEL_TYPE, "story_model": STORY_MODEL, "loaded_models": list(_generator_cache), "model_errors": _model_errors, "cache_root": cache_root(), "model_cache_dir": model_cache_dir(), "min_free_disk_gb": MIN_FREE_DISK_GB}


def handle(payload: dict[str, Any]) -> dict[str, Any]:
    task = payload.get("task")
    if task == "schema":
        prompt = str(payload.get("prompt", ""))
        fallback_reason = None
        if MODEL_BACKEND == "transformers":
            try:
                schema = schema_from_transformer(prompt)
                return {"schema": schema, "ddl": schema_sql(schema), "engine": "transformer", "model_id": SCHEMA_MODEL, "model": model_status()}
            except Exception as error:
                _model_errors[SCHEMA_MODEL] = str(error)
                fallback_reason = str(error)
        else:
            fallback_reason = f"MODEL_BACKEND is configured as {MODEL_BACKEND}"
        schema = infer_schema(prompt)
        return {"schema": schema, "ddl": schema_sql(schema), "engine": "rules_fallback", "model_id": None, "model": model_status(), "fallback": "rules", "fallback_reason": fallback_reason}
    if task == "sql":
        question = str(payload.get("question", ""))
        schema = payload.get("schema") or {}
        cached_result = get_cached_sql(question, schema)
        if cached_result is not None:
            return cached_result
        if MODEL_BACKEND == "transformers" and SQL_MODEL_TYPE in ("spider_seq2seq", "seq2seq"):
            try:
                sql = sql_from_seq2seq(question, schema)
                validate_sql_tables(sql, schema)
                fallback = english_to_sql(question, schema)
                validate_sql_tables(fallback, schema)
                fallback = normalize_sql(fallback)
                for clause in ("WHERE", "GROUP BY", "HAVING", "ORDER BY", "LIMIT", "OFFSET"):
                    if re.search(rf"\b{clause}\b", fallback, re.I) and not re.search(rf"\b{clause}\b", sql, re.I):
                        sql = fallback
                        break
                sql = normalize_sql(sql)
                result = {"sql": sql, "engine": "transformer_seq2seq", "model": model_status()}
                cache_sql_result(question, schema, result)
                return result
            except Exception as error:
                _model_errors[SQL_MODEL] = str(error)
        elif MODEL_BACKEND == "transformers" and SQL_MODEL_TYPE == "sadga_gap":
            _model_errors[SQL_MODEL] = "SADGA+GAP is a specialized graph model and is not implemented by the generic Hugging Face seq2seq loader. Configure SQL_MODEL_TYPE=spider_seq2seq for the configured Spider checkpoint or provide a SADGA+GAP inference adapter."
        sql = english_to_sql(question, schema)
        validate_sql_tables(sql, schema)
        result = {"sql": sql, "engine": "schema_aware_rules", "fallback": True, "fallback_reason": _model_errors.get(SQL_MODEL), "model": model_status()}
        cache_sql_result(question, schema, result)
        return result
    if task == "story":
        sql = str(payload.get("sql", ""))
        question = str(payload.get("question", ""))
        # SQL explanation is deliberately rule/structure based so it remains accurate
        # and always names every SQL clause that is actually present.
        return {"story": sql_to_story(sql, question), "model": model_status(), "fallback": "rules"}
    if task == "status":
        return model_status()
    raise ValueError("Unknown NLP task")


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_json(200, {"ok": True, "service": "dbmentor-nlp", "model": model_status()})
        else:
            self.send_json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        try:
            length = int(self.headers.get("content-length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            result = handle(payload)
            self.send_json(200, result)
            print(f"POST {self.path} task={payload.get('task', 'unknown')} status=200", flush=True)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error)})
            print(f"POST {self.path} status=400 error={error}", flush=True)
        except Exception as error:  # keep service failures JSON and observable
            self.send_json(500, {"error": str(error)})
            print(f"POST {self.path} status=500 error={error}", flush=True)

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            print(f"NLP client disconnected before status={status} response completed", flush=True)

    def log_message(self, format: str, *args: Any) -> None:
        print(f"NLP request: {format % args}", flush=True)


if __name__ == "__main__":
    port = int(os.getenv("NLP_PORT", "8001"))
    host = os.getenv("NLP_HOST", "127.0.0.1")
    print(f"DBMentor NLP service listening on http://{host}:{port}", flush=True)
    print(f"Health check: http://{host}:{port}/health", flush=True)
    print(f"Hugging Face home: {cache_root()}", flush=True)
    print(f"Model download/cache directory: {model_cache_dir()}", flush=True)
    print(f"Models load on the first /generate request; configured backend: {MODEL_BACKEND}", flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()
