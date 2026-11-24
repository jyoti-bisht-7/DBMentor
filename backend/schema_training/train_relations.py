from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

os.environ.setdefault("USE_TF", "0")

import numpy as np
from datasets import ClassLabel, Dataset
from transformers import AutoModelForSequenceClassification, AutoTokenizer, Trainer, TrainingArguments

LABELS = [
    "NO_RELATION", "HAS_ATTRIBUTE", "BOOKS", "FOR", "OWNS", "RECEIVES", "MAKES", "HAS", "MANAGES",
    "SERVES", "FOLLOWS", "VISITS", "SCHEDULES", "TREATS", "CONDUCTS", "CREATES", "CONTAINS",
    "ENROLLS_IN", "TEACHES", "OFFERS", "PLACES", "REFERENCES", "SUPPLIES", "CLASSIFIES", "STORES",
    "OPERATES", "BELONGS_TO", "SUPERVISES", "ASSIGNED_TO", "SUBMITS", "PROVIDES", "RESERVES", "USES",
]
LABEL_TO_ID = {label: index for index, label in enumerate(LABELS)}
ENTITY_MARKERS = ["[E1]", "[/E1]", "[E2]", "[/E2]"]


def classification_metrics(eval_prediction):
    predictions, labels = eval_prediction
    predicted = predictions.argmax(-1)
    accuracy = float((predicted == labels).mean())
    f1_values = []
    for label in np.unique(labels):
        true_positive = ((predicted == label) & (labels == label)).sum()
        precision = true_positive / max((predicted == label).sum(), 1)
        recall = true_positive / max((labels == label).sum(), 1)
        f1_values.append(2 * precision * recall / max(precision + recall, 1e-9))
    return {"accuracy": accuracy, "macro_f1": float(np.mean(f1_values))}


def mark_entities(record: dict) -> str:
    tokens = record["text"].split()
    first = record["entity1"]
    second = record["entity2"]
    marked = []
    for index, token in enumerate(tokens):
        if first["start"] <= index < first["end"]:
            marked.extend(["[E1]", token, "[/E1]"])
        elif second["start"] <= index < second["end"]:
            marked.extend(["[E2]", token, "[/E2]"])
        else:
            marked.append(token)
    return " ".join(marked)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", default="roberta-base")
    parser.add_argument("--epochs", type=float, default=5)
    parser.add_argument("--cache-dir", type=Path, default=None)
    parser.add_argument("--learning-rate", type=float, default=5e-5)
    args = parser.parse_args()

    records = [json.loads(line) for line in args.data.read_text(encoding="utf-8").splitlines() if line.strip()]
    dataset = Dataset.from_list([{"text": mark_entities(record), "label": LABEL_TO_ID[record["label"]]} for record in records])
    tokenizer = AutoTokenizer.from_pretrained(args.model, add_prefix_space=True, cache_dir=args.cache_dir)
    tokenizer.add_special_tokens({"additional_special_tokens": ENTITY_MARKERS})
    encoded = dataset.map(lambda batch: tokenizer(batch["text"], truncation=True, max_length=256), batched=True)
    encoded = encoded.cast_column("label", ClassLabel(names=LABELS))
    split = encoded.train_test_split(test_size=0.2, seed=42, stratify_by_column="label")
    model = AutoModelForSequenceClassification.from_pretrained(args.model, num_labels=len(LABELS), id2label=dict(enumerate(LABELS)), label2id=LABEL_TO_ID, cache_dir=args.cache_dir)
    model.resize_token_embeddings(len(tokenizer))
    training_args = TrainingArguments(output_dir=str(args.output), num_train_epochs=args.epochs, per_device_train_batch_size=8, learning_rate=args.learning_rate, logging_steps=10, eval_strategy="epoch", save_strategy="epoch", save_total_limit=1, save_only_model=True, report_to="none", warmup_ratio=0.1)
    trainer = Trainer(model=model, args=training_args, train_dataset=split["train"], eval_dataset=split["test"], processing_class=tokenizer, compute_metrics=classification_metrics)
    trainer.train()
    trainer.save_model(args.output)
    tokenizer.save_pretrained(args.output)


if __name__ == "__main__":
    main()
