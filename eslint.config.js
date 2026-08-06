import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "src/model-types.generated/"]
  },
  {
    files: ["examples/**/*.mjs", "scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly"
      }
    }
  },
  js.configs.recommended,
  tseslint.configs.recommended
);
