import { Kind, OperationTypeNode, parse, print, visit } from "graphql/language";
import type { FieldNode, OperationDefinitionNode } from "graphql/language";
import { fail } from "./agent-manifest-values";

function operation(source: string, variables: Readonly<Record<string, string>>) {
  if (new TextEncoder().encode(source).length > 16384) fail("$.batchStatus", "too-large");
  const document = parse(source, { maxTokens: 4096 });
  const node = document.definitions[0];
  if (
    document.definitions.length !== 1 ||
    node?.kind !== Kind.OPERATION_DEFINITION ||
    node.operation !== OperationTypeNode.QUERY ||
    (node.variableDefinitions?.length ?? 0) !== Object.keys(variables).length
  )
    fail("$.batchStatus", "unsafe-query");
  const names = new Set<string>();
  for (const variable of node.variableDefinitions ?? []) {
    const name = variable.variable.name.value;
    if (names.has(name) || print(variable.type) !== variables[name] || variable.defaultValue)
      fail("$.batchStatus", "invalid-variable");
    names.add(name);
  }
  visit(document, {
    Directive() {
      fail("$.batchStatus", "unsafe-query");
    },
    Variable(variable) {
      if (!names.has(variable.name.value)) fail("$.batchStatus", "unbound-variable");
    },
  });
  return { document, node };
}

function baseOperation(source: string) {
  const document = parse(source, { maxTokens: 4096 });
  const node = document.definitions[0];
  const project =
    node?.kind === Kind.OPERATION_DEFINITION &&
    node.variableDefinitions?.some((v) => v.variable.name.value === "project");
  return operation(source, project ? { project: "ID!" } : { owner: "String!", name: "String!" });
}
function boundOperation(source: string) {
  const document = parse(source, { maxTokens: 4096 });
  const node = document.definitions[0];
  const string =
    node?.kind === Kind.OPERATION_DEFINITION &&
    node.variableDefinitions?.some((v) => print(v.type) === "String!");
  return operation(source, { number: string ? "String!" : "Int!" });
}

/** A closed query composition protocol, shared by bundled and config manifests. */
export function validateForgeBatchQueries(query: string, discovery: string, bound: string): void {
  try {
    const base = baseOperation(query);
    let markers = 0;
    visit(base.document, {
      FragmentSpread(node) {
        if (node.name.value !== "FoomBatch") fail("$.batchStatus", "unsafe-query");
        markers++;
      },
    });
    if (markers !== 1) fail("$.batchStatus", "invalid-batch-marker");
    for (const [source, variables] of [
      [discovery, { branch: "String!" }],
      [bound, { number: "Int!" }],
    ] as const) {
      const item = source === bound ? boundOperation(source) : operation(source, variables);
      if (
        item.node.selectionSet.selections.length !== 1 ||
        item.node.selectionSet.selections[0]?.kind !== Kind.FIELD ||
        item.node.selectionSet.selections[0].alias
      )
        fail("$.batchStatus", "invalid-batch-selection");
      visit(item.document, {
        FragmentSpread() {
          fail("$.batchStatus", "unsafe-query");
        },
      });
    }
  } catch {
    fail("$.batchStatus", "unsafe-query");
  }
}

/** Only engine-generated names and validated numbers enter syntax; branches stay variables. */
export function expandForgeBatchQuery(
  query: string,
  discovery: string,
  bound: string,
  numbers: readonly (number | undefined)[],
): string {
  const base = baseOperation(query);
  const definitions = [...(base.node.variableDefinitions ?? [])];
  const selections: FieldNode[] = [];
  for (const [index, number] of numbers.entries()) {
    if (number !== undefined && (!Number.isSafeInteger(number) || number <= 0))
      fail("$.batchStatus", "invalid-number");
    const variableName = `b${String(index)}`;
    const template =
      number === undefined ? operation(discovery, { branch: "String!" }) : boundOperation(bound);
    const stringNumber = template.node.variableDefinitions?.some(
      (v) => print(v.type) === "String!",
    );
    const field = template.node.selectionSet.selections[0];
    if (field?.kind !== Kind.FIELD) fail("$.batchStatus", "invalid-batch-selection");
    const item: FieldNode = visit(field, {
      Variable() {
        return number === undefined
          ? { kind: Kind.VARIABLE, name: { kind: Kind.NAME, value: variableName } }
          : stringNumber
            ? { kind: Kind.STRING, value: String(number) }
            : { kind: Kind.INT, value: String(number) };
      },
    });
    // Variable definitions are generated separately; no value node can enter a definition.
    if (number === undefined)
      definitions.push({
        kind: Kind.VARIABLE_DEFINITION,
        variable: { kind: Kind.VARIABLE, name: { kind: Kind.NAME, value: variableName } },
        type: {
          kind: Kind.NON_NULL_TYPE,
          type: { kind: Kind.NAMED_TYPE, name: { kind: Kind.NAME, value: "String" } },
        },
      });
    selections.push({ ...item, alias: { kind: Kind.NAME, value: `p${String(index)}` } });
  }
  const expanded: OperationDefinitionNode = visit(base.node, {
    SelectionSet(node) {
      return {
        ...node,
        selections: node.selections.flatMap((selection) =>
          selection.kind === Kind.FRAGMENT_SPREAD ? selections : [selection],
        ),
      };
    },
  });
  return print({ ...expanded, variableDefinitions: definitions });
}
