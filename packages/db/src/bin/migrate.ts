import { migrate } from "../migrate.js";

try {
  await migrate();
} catch (error) {
  console.error(error);
  process.exitCode =
    typeof error === "object" && error !== null && "exitCode" in error
      ? Number((error as { exitCode: unknown }).exitCode)
      : 1;
}
