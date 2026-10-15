# Conditional and array word contexts

Issue: https://github.com/unbraind/pm-ops/issues/172

The scanner keeps Bash conditional operands together. Regex parentheses and alternation do not delimit commands; the trailing regex dollar is an anchor. Actual command substitutions and backticks still enter independent executable child scans. Closing double brackets preserve the public token shape and end the condition so a same-line publisher is audited. Incomplete conditions remain unresolved.

Compound assignments keep array elements in one assignment token, with ordinary quote and substitution handling. Quoted parentheses stay in their element. Append assignments are recognized as assignments by the command-prefix walker. Array contents do not establish new scalar provenance evidence; unsupported mutations remain unknown. Incomplete array assignments remain unresolved.

The required full pm-github acceptance also exposed eight older refusals for variable-expanded case patterns. The scanner tracks case subjects, pattern lists, arm bodies and nested cases. Pattern words are operands; substitutions still execute, while each arm body and every command after esac is audited. Existing scope tests continue to enforce conditional binding isolation.

## Both directions and behavioral reverts

Run `node --test test/regex-array.test.ts` for real Bash syntax and execution with an inert npm function, auditing each fixture as shell source and as a YAML run body. Exact issue lines pass; substitutions, backticks and adjacent unproven publishers fail. Additional controls exercise array append, quoted literal command text, incomplete input and variable-expanded case patterns.

Run `node test/regex-array.proof.ts` for function-only controls against parent 84221c8. The proof restores candidate bytes in a finally block. Reverting scanShellCommands alone causes two exact regex assertions, the exact quoted-array assertion and two variable case-pattern assertions to fail. Reverting scanCommandPrefix alone causes the unresolved-element append assertion to fail. Restoring the candidate passes all three exact fleet fixtures again.

## Review round 1: executable process substitutions

Unquoted `<(...)` and `>(...)` execute Bash children in array elements, conditional operands and case patterns. The shared unquoted substitution branch now discovers these children before handling any of those word contexts. Ordinary argument and command positions use the same discovery; their previous parenthesis splitting could expose simple publishers but did not isolate process children. Double-quoted, single-quoted and escaped process-looking text stays literal. A process child beginning with a subshell is executable, rather than dollar-prefixed arithmetic.

An isolated copy of the pre-fix scanner incorrectly accepts all six direct controls (both operators in each of the three word contexts): one attested sibling is recognized, the hidden publisher is omitted, and zero failures are reported. The candidate enumerates and refuses those publishers.

The Bash-backed suite passes 100 controls, including both process operators in all five contexts, nesting inside command substitutions, exact lexical child boundaries, literal strings and the three original fleet constructs. Each executable fixture runs an inert npm function and waits for asynchronous children; each is audited as shell source and a YAML run body.

Run `node test/process-substitution.proof.ts` for narrowly scoped discovery reverts. Removing discovery independently in array, conditional and case-pattern state makes both direct refusal controls fail by assertion in each context (0 passed, 2 failed), and likewise fails both child-boundary controls. Removing discovery in ordinary contexts fails four child-boundary controls. Restoring candidate bytes passes all 40 selected controls. The original function-only proof also still passes.

## Read-only built fleet comparison

Both main and candidate used `dist/attestation.js`, `verify(root)` and `report(result, write, exit)` against the same fleet checkouts containing a release workflow. Parenthesized counts are refusals. pm-cli and pm-rust remain out of scope; all other verdicts are unchanged except the two requested repairs.

| Checkout | Main 84221c8 | Candidate |
| --- | --- | --- |
| pm-ado | PASS (0) | PASS (0) |
| pm-beads | PASS (0) | PASS (0) |
| pm-brief | PASS (0) | PASS (0) |
| pm-changelog | FAIL (1) | PASS (0) |
| pm-cli | FAIL (48) | FAIL (45) |
| pm-context | PASS (0) | PASS (0) |
| pm-csv | PASS (0) | PASS (0) |
| pm-gantt-chart | PASS (0) | PASS (0) |
| pm-github | FAIL (15) | PASS (0) |
| pm-graph | PASS (0) | PASS (0) |
| pm-jev | PASS (0) | PASS (0) |
| pm-jira | PASS (0) | PASS (0) |
| pm-linear | PASS (0) | PASS (0) |
| pm-lint | PASS (0) | PASS (0) |
| pm-ops | PASS (0) | PASS (0) |
| pm-presets | PASS (0) | PASS (0) |
| pm-review | PASS (0) | PASS (0) |
| pm-rl | PASS (0) | PASS (0) |
| pm-rust | FAIL (1) | FAIL (1) |
| pm-slack | PASS (0) | PASS (0) |
| pm-slack-standup | PASS (0) | PASS (0) |
| pm-starter | PASS (0) | PASS (0) |
| pm-swarm | PASS (0) | PASS (0) |
| pm-todos | PASS (0) | PASS (0) |
| pm-ts-starter | PASS (0) | PASS (0) |
| pm-vcs | PASS (0) | PASS (0) |
| pm-web | PASS (0) | PASS (0) |
