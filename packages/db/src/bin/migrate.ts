import { migrate } from "../migrate.js";

try {
  await migrate();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
