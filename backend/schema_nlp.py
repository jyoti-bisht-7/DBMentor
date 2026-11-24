from __future__ import annotations

import re
import os
from dataclasses import dataclass
from typing import Any

import torch
from transformers import AutoModelForSequenceClassification, AutoModelForTokenClassification, AutoTokenizer


@dataclass
class Entity:
    text: str
    label: str
    start: int
    end: int


class SchemaNlpPipeline:
    """Non-generative schema extraction using fine-tuned NER and relation models."""

    def __init__(self, ner_model: str, relation_model: str, device: str = "auto") -> None:
        self.device = torch.device("cuda" if device == "auto" and torch.cuda.is_available() else "cpu") if device != "cpu" else torch.device("cpu")
        self.relation_min_confidence = float(os.getenv("RELATION_MIN_CONFIDENCE", "0.75"))
        self.max_relation_distance = int(os.getenv("MAX_RELATION_DISTANCE", "4"))
        self.relation_debug = os.getenv("RELATION_DEBUG", "0") == "1"
        self.ner_tokenizer = AutoTokenizer.from_pretrained(ner_model, add_prefix_space=True)
        self.ner_model = AutoModelForTokenClassification.from_pretrained(ner_model).to(self.device).eval()
        self.relation_tokenizer = AutoTokenizer.from_pretrained(relation_model, add_prefix_space=True)
        self.relation_model = AutoModelForSequenceClassification.from_pretrained(relation_model).to(self.device).eval()

    def extract(self, text: str) -> dict[str, Any]:
        words = text.split()
        entities = self._entities(words)
        relationships = []
        candidates = []
        for first_index, first in enumerate(entities):
            for second in entities[first_index + 1:]:
                if second.start - first.end > self.max_relation_distance:
                    continue
                label, confidence = self._relation(text, first, second)
                if self.relation_debug:
                    candidates.append({"source": first.text, "target": second.text, "label": label, "confidence": round(confidence, 4), "accepted": label not in ("O", "NO_RELATION") and confidence >= self.relation_min_confidence})
                if label not in ("O", "NO_RELATION") and confidence >= self.relation_min_confidence:
                    relationships.append({"source": first.text, "target": second.text, "label": label})
        result = {"entities": [entity.__dict__ for entity in entities], "relationships": relationships}
        if self.relation_debug:
            result["relation_candidates"] = candidates
        return result

    def _entities(self, words: list[str]) -> list[Entity]:
        inputs = self.ner_tokenizer(words, is_split_into_words=True, return_tensors="pt", truncation=True, max_length=256)
        word_ids = inputs.word_ids()
        inputs = {key: value.to(self.device) for key, value in inputs.items()}
        with torch.inference_mode():
            predictions = self.ner_model(**inputs).logits.argmax(-1)[0].tolist()
        entities = []
        current: Entity | None = None
        previous_word_index = None
        for token_index, word_index in enumerate(word_ids):
            if word_index is None or token_index >= len(predictions) or word_index >= len(words):
                continue
            if word_index == previous_word_index:
                continue
            previous_word_index = word_index
            label = self.ner_model.config.id2label[predictions[token_index]]
            word = re.sub(r"^[^\w]+|[^\w]+$", "", words[word_index])
            if not word:
                continue
            if label.startswith("B-"):
                if current:
                    entities.append(current)
                current = Entity(word, label[2:], word_index, word_index + 1)
            elif label.startswith("I-") and current and current.label == label[2:] and current.end == word_index:
                current.text = f"{current.text} {word}"
                current.end = word_index + 1
            elif current:
                entities.append(current)
                current = None
        if current:
            entities.append(current)
        unique = []
        seen = set()
        for entity in entities:
            key = (entity.start, entity.end, entity.label)
            if key not in seen:
                unique.append(entity)
                seen.add(key)
        return unique

    def _relation(self, text: str, first: Entity, second: Entity) -> tuple[str, float]:
        words = text.split()
        marked_words = []
        for index, word in enumerate(words):
            clean_word = re.sub(r"^[^\w]+|[^\w]+$", "", word)
            if first.start <= index < first.end:
                marked_words.extend(["[E1]", clean_word, "[/E1]"])
            elif second.start <= index < second.end:
                marked_words.extend(["[E2]", clean_word, "[/E2]"])
            else:
                marked_words.append(word)
        prompt = " ".join(marked_words)
        inputs = self.relation_tokenizer(prompt, return_tensors="pt", truncation=True, max_length=256)
        inputs = {key: value.to(self.device) for key, value in inputs.items()}
        with torch.inference_mode():
            logits = self.relation_model(**inputs).logits[0]
            probabilities = torch.softmax(logits, dim=-1)
            confidence, prediction = probabilities.max(dim=-1)
        return self.relation_model.config.id2label[prediction.item()], confidence.item()
