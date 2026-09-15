import { seed } from "../seed.js";

try {
  await seed(undefined, { includeDemoData: process.env.FACILITY_SEED_DEMO === "1" });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
