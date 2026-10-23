import type { DiagnosticCommand } from "./diagnostic-plans.ts";
/** Run one fixed diagnostic, returning counts only. The caller enforces its shared wall-clock deadline. */
export declare function runDiagnosticProbe(command: DiagnosticCommand, root: string, scratch: string): Promise<number>;
//# sourceMappingURL=diagnostic-probes.d.ts.map