export const DEV_COMPOSE = ["compose", "-f", "docker-compose.dev.yml"];
export const TEST_DATABASES = ["facility_test", "facility_ws"];

export function recreateTestDatabase(name, execute) {
  if (!TEST_DATABASES.includes(name)) {
    throw new Error(`Refusing to recreate non-test database: ${name}`);
  }

  execute("docker", [
    ...DEV_COMPOSE,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "facility",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
  ]);
  execute("docker", [
    ...DEV_COMPOSE,
    "exec",
    "-T",
    "postgres",
    "dropdb",
    "-U",
    "facility",
    "--if-exists",
    name,
  ]);
  execute("docker", [
    ...DEV_COMPOSE,
    "exec",
    "-T",
    "postgres",
    "createdb",
    "-U",
    "facility",
    name,
  ]);
}
