// eslint.config.js  (ESLint flat config — ESLint v9+)
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import importPlugin from "eslint-plugin-import";

export default [
    {
        files: ["src/**/*.ts"],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                project: "./tsconfig.json",
                sourceType: "module",
            },
        },
        plugins: {
            "@typescript-eslint": tsPlugin,
            import: importPlugin,
        },
        settings: {
            "import/resolver": {
                node: { extensions: [".ts", ".js"] },
            },
        },
        rules: {
            // ─── Circular dependency guard ───────────────────────────────────────
            // Highlights circular imports directly in the editor (red underline).
            // CI uses `madge` for a hard fail; this gives instant in-editor feedback.
            "import/no-cycle": ["error", { maxDepth: 10, ignoreExternal: true }],

            // ─── Basic TS rules (keep it minimal) ───────────────────────────────
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
        },
    },
    {
        // Ignore build output and node_modules
        ignores: ["dist/**", "node_modules/**", "*.js"],
    },
];
