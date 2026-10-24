import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Regras novas do React Compiler (eslint-plugin-react-hooks 6+) que apontam padrões antigos e funcionais do
    // código — "preencher o formulário ao abrir o modal" (setState em effect) e leitura de ref no render. Não
    // são bugs; refatorar todos os efeitos sem poder testar o app é mais arriscado que o aviso. Ficam como
    // aviso (continuam visíveis) para o CI poder falhar só em erro de verdade.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src-tauri/**",
  ]),
]);

export default eslintConfig;
