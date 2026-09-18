/**
 * Canonical strict flat configuration for every fleet TypeScript repository.
 *
 * Babel supplies the ESLint parser because typescript-eslint rejects the
 * TypeScript 7 compiler peer range used by part of the fleet. TypeScript stays
 * the authoritative compiler; Babel only supplies ESLint's ESTree syntax tree.
 */
import babelParser from "@babel/eslint-parser";
import { ESLint } from "eslint";
import { defineConfig } from "eslint/config";
const forbiddenSyntax = [
    { selector: "TSAnyKeyword", message: "Use a precise type instead of explicit any." },
    { selector: "ImportExpression", message: "Dynamic imports are forbidden; use a top-level import." },
    { selector: "TSImportType", message: "Inline type imports are forbidden; use a top-level type import." },
    { selector: "TSParameterProperty", message: "Parameter properties require non-erasable emit." },
    { selector: "TSEnumDeclaration", message: "Enums require non-erasable emit; use literal unions." },
    { selector: "TSModuleDeclaration", message: "Namespaces and TypeScript modules are forbidden." },
    { selector: "TSImportEqualsDeclaration", message: "Import-equals syntax is forbidden." },
    { selector: "TSExportAssignment", message: "Export-equals syntax is forbidden." },
];
const defaultIgnores = [
    ".agents/**",
    "coverage/**",
    "dist/**",
    "dist-test/**",
    "node_modules/**",
];
const rules = {
    "constructor-super": "error",
    "eqeqeq": ["error", "always"],
    "no-array-constructor": "error",
    "no-async-promise-executor": "error",
    "no-constant-binary-expression": "error",
    "no-constructor-return": "error",
    "no-debugger": "error",
    "no-dupe-args": "error",
    "no-dupe-class-members": "error",
    "no-dupe-else-if": "error",
    "no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],
    "no-fallthrough": "error",
    "no-import-assign": "error",
    "no-new-native-nonconstructor": "error",
    "no-promise-executor-return": "error",
    "no-restricted-syntax": ["error", ...forbiddenSyntax],
    "no-self-assign": "error",
    "no-setter-return": "error",
    "no-shadow-restricted-names": "error",
    "no-sparse-arrays": "error",
    "no-unexpected-multiline": "error",
    "no-unmodified-loop-condition": "error",
    "no-unreachable": "error",
    "no-unreachable-loop": "error",
    "no-unsafe-finally": "error",
    "no-unsafe-negation": "error",
    "no-unsafe-optional-chaining": "error",
    "no-unused-private-class-members": "error",
    "no-useless-backreference": "error",
    "no-useless-catch": "error",
    "no-useless-escape": "error",
    "no-var": "error",
    "prefer-const": "error",
    "prefer-object-has-own": "error",
    "require-atomic-updates": "error",
    "use-isnan": "error",
    "valid-typeof": "error",
};
/**
 * Build the fleet's strict, TypeScript-aware ESLint flat configuration.
 *
 * The returned array is intentionally a fresh flat-config value, so a
 * consumer can append its own project-specific config without mutating the
 * canonical policy or another ESLint invocation.
 *
 * @param options - Optional additional ignore globs for generated files.
 * @returns ESLint flat-config entries ready for `ESLint` or `eslint`.
 */
export function fleetEslintConfig(options = {}) {
    return defineConfig([
        {
            ignores: [...defaultIgnores, ...(options.ignores ?? [])],
        },
        {
            files: ["**/*.ts"],
            languageOptions: {
                ecmaVersion: "latest",
                sourceType: "module",
                parser: babelParser,
                parserOptions: {
                    requireConfigFile: false,
                    babelOptions: {
                        babelrc: false,
                        configFile: false,
                        parserOpts: {
                            plugins: [["typescript", { disallowAmbiguousJSXLike: true }]],
                        },
                    },
                },
            },
            linterOptions: {
                reportUnusedDisableDirectives: "error",
            },
            rules,
        },
    ]);
}
/**
 * Run the canonical lint policy, print stylish diagnostics, and return a status.
 *
 * @param options - Optional project root, lint paths, and additional ignores.
 * @returns `0` for a clean result and `1` when ESLint reports findings.
 */
export async function runLintGate(options = {}) {
    const eslint = new ESLint({
        cwd: options.cwd,
        overrideConfigFile: true,
        overrideConfig: fleetEslintConfig({ ignores: options.ignores }),
    });
    const results = await eslint.lintFiles([...(options.files ?? ["."])]);
    const formatter = await eslint.loadFormatter("stylish");
    const output = formatter.format(results);
    if (output)
        console.error(output);
    return results.some(({ errorCount, warningCount }) => errorCount + warningCount > 0) ? 1 : 0;
}
//# sourceMappingURL=eslint.js.map