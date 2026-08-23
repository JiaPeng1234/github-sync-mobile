import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      obsidian: path.resolve(here, "tests/mocks/obsidian.ts"),
    },
  },
});
