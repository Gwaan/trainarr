---
description: Architecture du coach IA (providers, outils, RAG)
paths:
  - "src/lib/ai/**"
---

# Coach IA

## Abstraction provider — règle n°1

Tout passe par une interface unique dans `lib/ai/provider.ts` :

- Le format d'échange est le **format OpenAI chat completions** (standard de fait) : llama.cpp (`llama-server`), Ollama, vLLM, OpenAI, Mistral s'y branchent nativement ; Claude via son SDK derrière un adaptateur.
- Le provider actif et sa `base_url` viennent de la config (`AI_PROVIDER`, `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY?`) — jamais codés en dur.
- Le code métier (coach, génération de plan) ne connaît que l'interface, jamais un SDK provider directement.
- Prévoir que le tool calling peut être absent ou peu fiable sur des petits modèles locaux : dégrader proprement (message explicite), ne pas boucler à l'infini.

## Outils du coach (tool calling)

- Les données structurées (activités, splits, charge, plan) s'accèdent par **outils** (`get_activities`, `get_training_load`, `get_current_plan`, …) qui interrogent Postgres — pas par RAG.
- Chaque outil : schéma d'input Zod, résultat compact (le strict nécessaire, pas de dump de table), en lecture seule sauf mention explicite.
- Boucle d'agent bornée (max itérations) avec streaming de la réponse vers l'UI.

## RAG (connaissance non structurée)

- Réservé aux contenus texte : principes d'entraînement, notes perso. Embeddings via le provider configuré (llama.cpp expose `/embedding`), stockage **pgvector** dans le Postgres existant.
- Pas de framework d'orchestration (LangChain & co) : chunking + similarité + injection dans le prompt en code maison, simple et testable.

## Sécurité

- Les clés API restent côté serveur (`server-only`). Le chat passe par une route de streaming côté serveur — le navigateur ne parle jamais directement au provider.
