# Schema NLP training

This directory contains a non-generative NLP pipeline for natural-language requirements to schema intermediate representation.

## Pipeline

1. Fine-tune RoBERTa token classification on BIO entity labels.
2. Fine-tune RoBERTa sequence classification on entity-pair relationship labels.
3. Run `schema_nlp.py` to extract entities and relationships.
4. Compile the intermediate representation into normalized tables and foreign keys.

The included JSONL files are seed examples only. Add hundreds or thousands of annotated requirements before treating the model as reliable.

## Dataset sources and generation

Spider, WikiSQL, SParC, and CoSQL are useful public text-to-SQL datasets, but they do not directly annotate natural-language requirements with entity, attribute, and relationship labels. They are not drop-in datasets for this schema-extraction task.

Generate a larger synthetic starter dataset locally:

```powershell
python backend/schema_training/generate_dataset.py --output E:/DBMentor/schema-data --per-domain 60 --seed 7
```

The default output contains 2,160 NER examples and 1,620 relation examples across banking, railway, healthcare, education, retail, logistics, hospitality, HR, and manufacturing. It is bootstrapping data, not a replacement for human-reviewed annotations.

Each relation now receives `--per-domain` paraphrases instead of sharing that count across all relations. Training holds out 20% of the data and reports validation metrics. NER uses class-weighted loss because `O` naturally dominates token counts; relations use stratified validation and macro-F1.

## Annotation format

`ner.jsonl` contains one JSON object per line:

```json
{"tokens":["Passengers","book","tickets","for","trains"],"tags":["B-ENTITY","O","B-ENTITY","O","B-ENTITY"]}
```

`relations.jsonl` contains one JSON object per line. Entity spans use token indexes with an exclusive end:

```json
{"text":"Passengers book tickets for trains.","entity1":{"start":0,"end":1,"label":"ENTITY"},"entity2":{"start":2,"end":3,"label":"ENTITY"},"label":"BOOKS"}
```

## Train

From the repository root:

```powershell
python -m pip install -r backend/requirements.txt
python backend/schema_training/train_ner.py --data E:/DBMentor/schema-data/ner.jsonl --output E:/DBMentor/models/schema-ner --cache-dir E:/huggingface-cache
python backend/schema_training/train_relations.py --data E:/DBMentor/schema-data/relations.jsonl --output E:/DBMentor/models/schema-relations --cache-dir E:/huggingface-cache
```

Checkpoints are limited to the latest model-only checkpoint to avoid filling the system drive. Use absolute `E:/...` paths for both output and cache when the C: drive is low on space.

Then use `SchemaNlpPipeline` from `backend/schema_nlp.py` with both output directories.
