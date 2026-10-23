# Review and select a diagnostic plan

```typescript
/** Review first, execute the exact selected plan later; no tracker writes or Git. */
import { createDiagnosticPlan, executeDiagnosticPlan } from "pm-ops/diagnostic-plans";

const root = process.env.PM_PATH;
if (!root) throw new Error("Set PM_PATH to the selected tracker directory.");
const plan = await createDiagnosticPlan(root, ["items_unreadable", "history_invalid"], {
  processes: 2, network: 0, time_ms: 10000,
});
console.log(JSON.stringify(plan));
// In an application, present this artifact for review and persist the selection.
// Execution requires its exact id; changing scope, commands or budgets invalidates it.
if (process.env.SELECTED_DIAGNOSTIC_PLAN === plan.id) {
  const result = await executeDiagnosticPlan(root, plan, process.env.SELECTED_DIAGNOSTIC_PLAN);
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
```
