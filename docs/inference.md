# Local terminal classification

Issue #217 removed model evaluation, inference sources, provider keys and Run check. Foom classifies terminals using hooks, local agent rules, process facts and text patterns. It sends no terminal content to a model or network service. Ambiguous terminals retain the neutral rules verdict.

See [the evaluator pipeline](architecture.md#evaluator-pipeline) and [the product specification](product.md#the-evaluator). The local verdict log remains available to guide improvements to rules.
