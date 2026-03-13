# V9 Full-Feature Reference

Status: reference only
Purpose: preserve the richer graph/extraction design explored during the V8 rewrite so it can be revisited for a future V9 without forcing the current V8 target to carry all features online.

Note:
This file preserves the earlier shared-ontology full-feature branch.
The newer report revises `meso` and `macro` into scene/block and arc/structure layers with their own ontologies.
So this document is an archived reference, not the current authoritative layer model.

## 1. What This Document Preserves

This reference keeps the full-feature direction discussed during the V8 redesign:

- `Text-to-points` extraction over arbitrary raw text
- full `micro / meso / macro` graph layering
- `Core 32 + Extended 6` relation taxonomy
- explicit discourse-role labels
- cross-layer mappings
- `open window` incremental reprocessing
- `lexical + vector + structural` multi-path retrieval
- offline LLM guidance over typed candidate relations and discourse roles

This is not the minimal V8 runtime target.
It is a richer candidate architecture for a future V9.

## 2. Full Candidate Extraction Layer

The report-aligned extraction layer treats raw text as a source of typed candidates rather than directly as memory graph nodes.

Main extraction surfaces:

- lexical: keywords, keyphrases, cue phrases
- object: entities, concepts, methods, metrics, contexts
- proposition: typed relations plus open relations
- discourse: paragraph and segment function

Discourse role labels:

- `definition`, `background`, `event`, `cause`, `outcome`
- `condition`, `purpose`, `evidence`, `comparison`, `contrast`
- `opinion`, `recommendation`, `conclusion`, `procedure_steps`, `exception`

## 3. Full Graph Taxonomy

Node taxonomy:

- `Entity`
- `Concept`
- `Method`
- `Event`
- `Attribute`
- `Metric`
- `Claim`
- `Evidence`
- `Context`
- `DiscourseUnit`

Core 32 relations:

- `is_a`, `instance_of`, `part_of`, `has_part`, `belongs_to`, `equivalent_to`
- `performs`, `acts_on`, `uses`, `produces`, `targets`
- `initiates`, `involves`, `occurs_at`, `results_in_event`
- `causes`, `caused_by`, `enables`, `prevents`, `requires`, `conditioned_on`
- `before`, `after`, `simultaneous_with`, `evolves_to`
- `better_than`, `worse_than`, `similar_to`, `differs_from`
- `supports`, `contradicts`, `cites`

Extended 6 discourse relations:

- `elaborates`, `summarizes`, `contrasts`, `explains`, `concludes`, `recommends`

Cross-layer mappings:

- `mention_maps_to_object`
- `micro_unit_in_meso_unit`
- `meso_unit_in_macro_unit`
- `proposition_summarized_by_topic`
- `topic_has_timewindow`

Recommended qualifiers:

- `aspect`
- `time`
- `context`
- `polarity`
- `certainty`
- `evidence_unit_ids`

## 4. Full Three-Layer Graph

Layer responsibilities:

- `micro`: evidence graph, mention-level anchors, short-distance cues
- `meso`: proposition graph, main reasoning surface
- `macro`: topic and time navigation, long-range organization

Suggested distribution:

- `micro` emphasizes evidence, cue, comparison, and local causal links
- `meso` carries most stable typed propositions
- `macro` emphasizes topic evolution, summarization, contrast, and long-range comparison

## 5. Incremental and Retrieval Features

Incremental write path:

- append raw records immutably
- reopen only the affected offset neighborhood
- re-extract and re-materialize inside an `open window`
- keep stable ids outside the window

Read path:

- lexical retrieval
- vector retrieval
- structural graph expansion
- rerank
- evidence-span alignment

## 6. Why This Is Not Minimal V8

This design is powerful, but it mixes three concerns that the leaner V8 should separate:

- candidate extraction semantics
- durable memory graph semantics
- runtime ignition semantics

If all of it is treated as one online graph, the implementation becomes harder to tune and reason about.

## 7. How V9 Could Reuse This

A future V9 can selectively restore from this document:

- richer typed relation extraction
- broader discourse relation support
- stronger macro-layer retrieval and navigation
- more ambitious multi-path reranking
- a larger canonical graph than the lean V8 runtime graph
