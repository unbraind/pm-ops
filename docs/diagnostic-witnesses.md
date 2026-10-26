# Explicit failure inputs, minimal shared evidence

```sh
pm ops witnesses --input docs/examples/diagnostic-failures.json
pm ops witnesses --input docs/examples/diagnostic-failures.json --json
```

The [complete example](examples/diagnostic-failures.json) declares five failing
checks with one SDK version mismatch explanation. The output retains `actual`
and `required` once, omits `noise`, and emits one witness with five affected
check IDs. Its diagnosis remains `unverified`. These example versions illustrate
a declared incompatibility; the reducer does not implement version-range logic.

```typescript
import {
  reduceDiagnosticWitnesses, readDiagnosticWitnesses, WitnessRefusal,
  type DiagnosticWitnessInput,
} from "pm-ops/diagnostic-witnesses";

// File reads and direct SDK calls use the same strict input schema.
const report = readDiagnosticWitnesses("diagnostic-failures.json");
console.log(report.facts, report.witnesses);
const input: DiagnosticWitnessInput = {
  version: 1,
  facts: [{ id: "budget", scope: "snapshot-a", key: "processes", value: "0" }],
  checks: [{ id: "items", failure: "process_budget", scope: "snapshot-a",
    command: "sdk:items:v1", diagnosis: "observed", sufficient: [["budget"]] }],
};
try { console.log(reduceDiagnosticWitnesses(input)); }
catch (error) { if (error instanceof WitnessRefusal) console.error(error.code, error.remedy); else throw error; }
```

Every clause is a conjunction of explicit facts that the caller declares
sufficient to reproduce the declared class using the referenced canonical
command and scope. Alternative clauses are disjunctive. Supply all prerequisites
that reproduction needs, including configuration and environment identities;
the reducer cannot discover missing premises. A command reference is data, never
shell text. Use the existing diagnostic-plan review/selection API to run probes.
Do not present a declaration as a measured diagnosis or root-cause proof.

The schema accepts exactly `version`, `facts`, and `checks`. A fact has exactly
`id`, `scope`, `key`, `value`; a check has exactly `id`, `failure`, `scope`,
`command`, `diagnosis`, `sufficient`. Unknown keys, missing fields, duplicate
IDs, duplicate scoped input keys, repeated clause references, dangling references
and references outside the check's scope refuse. Repeated alternatives are
harmless. Empty clauses cannot erase the need for evidence. Separate snapshots
need separate scopes; matching values alone never joins them.

Bounds: 1–16 facts, 1–64 checks, 1–8 alternatives per check, 1–16 references per
clause. All arrays must be dense. Labels contain 1–64 ASCII letters, digits,
dots, underscores, colons or hyphens and start with a letter or digit. Exact
fact values are 1–256 UTF-16 code units, without normalization; CRLF and spaces
remain significant. Include only public, necessary inputs: values are returned
verbatim. JSON files must be valid UTF-8 regular files of at most 64 KiB. Numbers are only
the literal schema version and bounded integer report counts, validated before
returning `ok`. There are no ratios or unbounded counters.

The exhaustive search considers at most 65,535 nonempty fact subsets. It
minimizes distinct retained fact count across **all** checks, rather than picking
each check's shortest clause independently. Sorted fact IDs establish bit order;
the lowest mask breaks equal-size ties. Within that minimum, each check chooses
the shortest contained clause, then the lowest mask. This does not claim to
minimize serialized bytes or the number of witnesses. Groups match exactly on
class, scope, diagnosis and chosen facts. Each affected check retains its own
canonical command, so different probes can share the same sufficient inputs. Shared prefixes or
transitive overlap cannot join unrelated checks. Sorted check IDs make output
independent of input ordering. All affected checks and all selected facts remain
in the result; `omitted_facts` counts only unnecessary input facts.

| Refusal | Remedy |
| --- | --- |
| `invalid_witness_input` | Supply the strict schema, correct references and diagnosis; split selections above the bounds. |
| `witness_input_unreadable` | Supply a readable regular JSON file within 64 KiB. |
| `invalid_witness_output` | Reject the packet and report invalid counts to its producer. |

These are typed `WitnessRefusal` exceptions with `code`, `remedy`, and
`exitCode: 2`; messages never echo inputs, paths or backend errors. Host JSON and
TOON rendering use the same complete report. No internal output truncation or
implicit diagnosis upgrade occurs. Larger output remains subject to the host's
explicit output-budget contract; request an unbounded host output when retaining
a maximal packet. Keep the full returned packet for reproduction.

The reducer is stateless and backend-independent. It does not import, export or
sync native tracker records, interpret status names, persist checkpoints, retry
frozen plans, acquire claims or modify shared records. Thus it introduces no
idempotency keys, revision expectations or ownership transitions. The 500-sequence
seeded model test covers its JSON/TOON representations, repeated and older
inputs, whitespace/CRLF, and verifies native records and relationships read back
through the SDK remain unchanged. Existing canonical probes retain their own
read-only scope and execution-budget contracts.
