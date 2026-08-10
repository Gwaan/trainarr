import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Assets servis tels quels, dont le worker MapLibre recopié depuis
    // node_modules par `scripts/copy-maplibre-worker.mjs` : du code minifié
    // tiers, à ne pas linter.
    "public/**",
  ]),
]);

export default eslintConfig;
