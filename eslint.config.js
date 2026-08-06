import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "src/model-types.generated/"]
  },
  js.configs.recommended,
  tseslint.configs.recommended
);
