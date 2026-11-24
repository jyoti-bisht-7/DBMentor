from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

os.environ.setdefault("USE_TF", "0")

from datasets import Dataset
import torch
from transformers import (
    AutoModelForTokenClassification,
    AutoTokenizer,
    DataCollatorForTokenClassification,
    Trainer,
    TrainingArguments,
)

LABELS = ["O", "B-ENTITY", "I-ENTITY", "B-ATTRIBUTE", "I-ATTRIBUTE"]
LABEL_TO_ID = {label: index for index, label in enumerate(LABELS)}


class WeightedTokenTrainer(Trainer):
    def __init__(self, *args, class_weights: torch.Tensor, **kwargs):
        super().__init__(*args, **kwargs)
        self.class_weights = class_weights

    def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
        labels = inputs.pop("labels")
        outputs = model(**inputs)
        weights = self.class_weights.to(outputs.logits.device)
        loss = torch.nn.functional.cross_entropy(outputs.logits.view(-1, len(LABELS)), labels.view(-1), weight=weights, ignore_index=-100)
        return (loss, outputs) if return_outputs else loss


def token_accuracy(eval_prediction):
    predictions, labels = eval_prediction
    predicted = predictions.argmax(-1)
    mask = labels != -100
    return {"token_accuracy": float((predicted[mask] == labels[mask]).mean())}


def load_examples(path: Path) -> Dataset:
    records = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return Dataset.from_list(records)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", default="roberta-base")
    parser.add_argument("--epochs", type=float, default=5)
    parser.add_argument("--cache-dir", type=Path, default=None)
    args = parser.parse_args()

    tokenizer = AutoTokenizer.from_pretrained(args.model, add_prefix_space=True, cache_dir=args.cache_dir)
    dataset = load_examples(args.data)

    def encode(batch: dict[str, list]) -> dict[str, list]:
        encoded = tokenizer(batch["tokens"], is_split_into_words=True, truncation=True, max_length=256)
        aligned = []
        for row, tags in enumerate(batch["tags"]):
            word_ids = encoded.word_ids(batch_index=row)
            previous = None
            labels = []
            for word_id in word_ids:
                if word_id is None:
                    labels.append(-100)
                elif word_id != previous:
                    labels.append(LABEL_TO_ID[tags[word_id]])
                else:
                    tag = tags[word_id]
                    labels.append(LABEL_TO_ID[tag.replace("B-", "I-", 1) if tag.startswith("B-") else tag])
                previous = word_id
            aligned.append(labels)
        encoded["labels"] = aligned
        return encoded

    encoded = dataset.map(encode, batched=True, remove_columns=dataset.column_names)
    split = encoded.train_test_split(test_size=0.2, seed=42)
    model = AutoModelForTokenClassification.from_pretrained(args.model, num_labels=len(LABELS), id2label=dict(enumerate(LABELS)), label2id=LABEL_TO_ID, cache_dir=args.cache_dir)
    counts = torch.zeros(len(LABELS))
    for row in split["train"]["labels"]:
        for label in row:
            if label >= 0:
                counts[label] += 1
    class_weights = (counts.sum() / counts.clamp_min(1)).sqrt()
    training_args = TrainingArguments(output_dir=str(args.output), num_train_epochs=args.epochs, per_device_train_batch_size=8, learning_rate=5e-5, logging_steps=10, eval_strategy="epoch", save_strategy="epoch", save_total_limit=1, save_only_model=True, report_to="none")
    trainer = WeightedTokenTrainer(model=model, args=training_args, train_dataset=split["train"], eval_dataset=split["test"], processing_class=tokenizer, data_collator=DataCollatorForTokenClassification(tokenizer), compute_metrics=token_accuracy, class_weights=class_weights)
    trainer.train()
    trainer.save_model(args.output)
    tokenizer.save_pretrained(args.output)


if __name__ == "__main__":
    main()
