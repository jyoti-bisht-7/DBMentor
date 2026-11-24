from __future__ import annotations

import argparse
import json
import random
import re
from pathlib import Path


DOMAINS = {
    "banking": {
        "entities": ["clients", "accounts", "transactions", "loans", "deposits", "managers", "branches", "payments"],
        "attributes": ["name", "email", "balance", "amount", "status", "opened date", "interest rate", "account number"],
        "relations": [("clients", "accounts", "OWNS"), ("clients", "loans", "RECEIVES"), ("clients", "deposits", "MAKES"), ("accounts", "transactions", "HAS"), ("managers", "loans", "MANAGES"), ("branches", "accounts", "SERVES")],
    },
    "railway": {
        "entities": ["passengers", "tickets", "trains", "stations", "routes", "schedules", "bookings", "employees", "platforms"],
        "attributes": ["name", "email", "phone", "train number", "capacity", "departure time", "arrival time", "seat number", "fare"],
        "relations": [("passengers", "tickets", "BOOKS"), ("tickets", "trains", "FOR"), ("trains", "routes", "FOLLOWS"), ("routes", "stations", "VISITS"), ("schedules", "trains", "SCHEDULES"), ("stations", "platforms", "HAS")],
    },
    "healthcare": {
        "entities": ["patients", "doctors", "hospitals", "appointments", "prescriptions", "medications", "departments", "invoices"],
        "attributes": ["name", "email", "phone", "date of birth", "specialization", "appointment date", "dosage", "amount", "status"],
        "relations": [("doctors", "patients", "TREATS"), ("patients", "appointments", "HAS"), ("doctors", "appointments", "CONDUCTS"), ("appointments", "prescriptions", "CREATES"), ("prescriptions", "medications", "CONTAINS"), ("hospitals", "departments", "HAS")],
    },
    "education": {
        "entities": ["students", "teachers", "courses", "departments", "enrollments", "exams", "semesters", "classrooms"],
        "attributes": ["name", "email", "student number", "course code", "credits", "grade", "exam date", "room number"],
        "relations": [("students", "courses", "ENROLLS_IN"), ("teachers", "courses", "TEACHES"), ("departments", "courses", "OFFERS"), ("courses", "exams", "HAS"), ("students", "enrollments", "CREATES"), ("semesters", "courses", "CONTAINS")],
    },
    "retail": {
        "entities": ["customers", "products", "orders", "order items", "stores", "suppliers", "categories", "payments"],
        "attributes": ["name", "email", "sku", "price", "quantity", "order date", "total", "address", "status"],
        "relations": [("customers", "orders", "PLACES"), ("orders", "order items", "CONTAINS"), ("order items", "products", "REFERENCES"), ("suppliers", "products", "SUPPLIES"), ("categories", "products", "CLASSIFIES"), ("orders", "payments", "HAS")],
    },
    "logistics": {
        "entities": ["customers", "shipments", "warehouses", "drivers", "vehicles", "packages", "routes", "delivery events"],
        "attributes": ["name", "email", "tracking number", "weight", "address", "delivery date", "status", "capacity"],
        "relations": [("customers", "shipments", "CREATES"), ("shipments", "packages", "CONTAINS"), ("warehouses", "packages", "STORES"), ("drivers", "vehicles", "OPERATES"), ("vehicles", "routes", "FOLLOWS"), ("shipments", "delivery events", "HAS")],
    },
    "hospitality": {
        "entities": ["guests", "hotels", "rooms", "bookings", "staff", "services", "invoices", "payments"],
        "attributes": ["name", "email", "phone", "room number", "check in date", "check out date", "price", "status"],
        "relations": [("guests", "bookings", "MAKES"), ("bookings", "rooms", "RESERVES"), ("hotels", "rooms", "HAS"), ("staff", "services", "PROVIDES"), ("bookings", "invoices", "CREATES"), ("invoices", "payments", "HAS")],
    },
    "human_resources": {
        "entities": ["employees", "departments", "managers", "projects", "timesheets", "salaries", "benefits", "leave requests"],
        "attributes": ["name", "email", "phone", "employee number", "salary", "start date", "title", "status"],
        "relations": [("employees", "departments", "BELONGS_TO"), ("managers", "employees", "SUPERVISES"), ("employees", "projects", "ASSIGNED_TO"), ("employees", "timesheets", "SUBMITS"), ("employees", "leave requests", "CREATES"), ("employees", "benefits", "RECEIVES")],
    },
    "manufacturing": {
        "entities": ["products", "parts", "machines", "factories", "suppliers", "production orders", "employees", "inspections"],
        "attributes": ["name", "sku", "serial number", "quantity", "cost", "production date", "status", "location"],
        "relations": [("products", "parts", "USES"), ("factories", "machines", "HAS"), ("suppliers", "parts", "SUPPLIES"), ("production orders", "products", "CREATES"), ("employees", "machines", "OPERATES"), ("production orders", "inspections", "HAS")],
    },
}

RELATION_WORDS = {
    "OWNS": "owns", "RECEIVES": "receives", "MAKES": "makes", "HAS": "has", "MANAGES": "manages", "SERVES": "serves",
    "BOOKS": "books", "FOR": "is for", "FOLLOWS": "follows", "VISITS": "visits", "SCHEDULES": "schedules", "TREATS": "treats",
    "CONDUCTS": "conducts", "CREATES": "creates", "CONTAINS": "contains", "ENROLLS_IN": "enrolls in", "TEACHES": "teaches",
    "OFFERS": "offers", "PLACES": "places", "REFERENCES": "references", "SUPPLIES": "supplies", "CLASSIFIES": "classifies",
    "STORES": "stores", "OPERATES": "operates", "BELONGS_TO": "belongs to", "SUPERVISES": "supervises", "ASSIGNED_TO": "is assigned to",
    "SUBMITS": "submits", "PROVIDES": "provides", "RESERVES": "reserves", "USES": "uses",
}

RELATION_TEMPLATES = {
    "BOOKS": ["{first} book {second}.", "{first} make bookings for {second}.", "Bookings are made by {first} for {second}."],
    "FOR": ["{first} are for {second}.", "{first} are linked to {second}.", "The {first} belong to the {second}."],
    "HAS": ["{first} have {second}.", "{first} contain {second}.", "The {first} include {second}."],
    "MANAGES": ["{first} manage {second}.", "{first} oversee {second}.", "{second} are supervised by {first}."],
    "TREATS": ["{first} treat {second}.", "{first} provide care for {second}.", "{second} receive treatment from {first}."],
    "ENROLLS_IN": ["{first} enroll in {second}.", "{first} register for {second}.", "{second} have {first} as enrolled students."],
    "PLACES": ["{first} place {second}.", "{first} create {second}.", "{second} are submitted by {first}."],
    "SUPPLIES": ["{first} supply {second}.", "{first} provide {second}.", "{second} are sourced from {first}."],
    "FOLLOWS": ["{first} follow {second}.", "{first} use {second}.", "{second} are followed by {first}."],
    "VISITS": ["{first} visit {second}.", "{first} stop at {second}.", "{second} are visited by {first}."],
}


def tokens(text: str) -> list[str]:
    return re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)?|\d+|[^\w\s]", text)


def span_for(parts: list[str], value: str) -> tuple[int, int]:
    wanted = tokens(value.lower())
    lowered = [part.lower() for part in parts]
    for start in range(len(parts) - len(wanted) + 1):
        if lowered[start:start + len(wanted)] == wanted:
            return start, start + len(wanted)
    raise ValueError(f"Could not find {value!r} in {parts!r}")


def ner_record(text: str, entity_values: list[str], attribute_values: list[str]) -> dict:
    parts = tokens(text)
    tags = ["O"] * len(parts)
    for value, label in [(item, "ENTITY") for item in entity_values] + [(item, "ATTRIBUTE") for item in attribute_values]:
        start, end = span_for(parts, value)
        tags[start] = f"B-{label}"
        for index in range(start + 1, end):
            tags[index] = f"I-{label}"
    return {"tokens": parts, "tags": tags}


def relation_record(text: str, first: str, second: str, label: str) -> dict:
    parts = tokens(text)
    first_start, first_end = span_for(parts, first)
    second_start, second_end = span_for(parts, second)
    return {"text": " ".join(parts), "entity1": {"start": first_start, "end": first_end, "label": "ENTITY"}, "entity2": {"start": second_start, "end": second_end, "label": "ENTITY"}, "label": label}


def singular(value: str) -> str:
    if value.endswith("ies"):
        return value[:-3] + "y"
    if value.endswith("s") and not value.endswith("ss"):
        return value[:-1]
    return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("backend/schema_training/generated"))
    parser.add_argument("--per-domain", type=int, default=60)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()
    random.seed(args.seed)
    args.output.mkdir(parents=True, exist_ok=True)
    ner = []
    relations = []
    for domain_index, spec in enumerate(DOMAINS.values()):
        entities = spec["entities"]
        attributes = spec["attributes"]
        domain_relations = spec["relations"]
        for relation_index, (first, second, label) in enumerate(domain_relations):
            templates = RELATION_TEMPLATES.get(label, [f"The {{first}} {RELATION_WORDS[label]} the {{second}}."])
            for example_index in range(args.per_domain):
                template = templates[example_index % len(templates)]
                sentence = template.format(first=first, second=second, first_singular=singular(first), second_singular=singular(second))
                ner.append(ner_record(sentence, [first, second], []))
                relations.append(relation_record(sentence, first, second, label))
            attribute_entity = entities[(example_index + domain_index) % len(entities)]
            attribute = attributes[(example_index * 3 + domain_index) % len(attributes)]
            attribute_sentence = f"Each {attribute_entity} has a {attribute}."
            ner.append(ner_record(attribute_sentence, [attribute_entity], [attribute]))
            for noise_index in range(args.per_domain * 2):
                noise_first = entities[(relation_index + noise_index + 2) % len(entities)]
                noise_second = entities[(relation_index + noise_index + 4) % len(entities)]
                if noise_first == noise_second:
                    noise_second = entities[(relation_index + noise_index + 5) % len(entities)]
                noise_sentence = f"The {noise_first} is recorded near the {noise_second}."
                ner.append(ner_record(noise_sentence, [noise_first, noise_second], []))
                relations.append(relation_record(noise_sentence, noise_first, noise_second, "NO_RELATION"))
    random.shuffle(ner)
    random.shuffle(relations)
    (args.output / "ner.jsonl").write_text("\n".join(json.dumps(item) for item in ner) + "\n", encoding="utf-8")
    (args.output / "relations.jsonl").write_text("\n".join(json.dumps(item) for item in relations) + "\n", encoding="utf-8")
    print(f"Generated {len(ner)} NER examples and {len(relations)} relation examples in {args.output}")


if __name__ == "__main__":
    main()
