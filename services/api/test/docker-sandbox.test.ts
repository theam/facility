import { describe, expect, it } from "vitest";
import { DockerSandboxDriver } from "../src/sandbox/docker.js";

describe("Docker sandbox ownership and caches", () => {
  it("partitions package caches and excludes labels swept by legacy workers", async () => {
    const created: Array<Record<string, unknown>> = [];
    const listed: Array<Record<string, unknown>> = [];
    const docker = {
      getImage: () => ({ inspect: async () => ({ Id: "sha256:runner" }) }),
      createContainer: async (options: Record<string, unknown>) => {
        created.push(options);
        return { id: "container_1", start: async () => undefined };
      },
      listContainers: async (options: Record<string, unknown>) => {
        listed.push(options);
        return [
          {
            Id: "container_1",
            Labels: {
              "facility.sandbox.namespace": "instance_alpha",
              "facility.sandbox.kind": "run",
              "facility.sandbox.run": "run_1",
            },
          },
        ];
      },
    };
    const driver = new DockerSandboxDriver(docker as never);

    await driver.launch({
      runId: "run_1",
      namespace: "instance_alpha",
      kind: "run",
      cachePartition: "project_partition_alpha",
      image: "runner:test",
      env: {},
      cpu: 1,
      memoryMb: 256,
      timeoutMin: 5,
    });
    await expect(driver.listFacilityContainers("instance_alpha")).resolves.toEqual([
      { ref: "container_1", runId: "run_1" },
    ]);

    expect(created[0]).toMatchObject({
      Volumes: { "/work": {} },
      Env: [
        "pnpm_config_store_dir=/work/.facility-package-cache/pnpm-store",
        "pnpm_config_network_concurrency=4",
        "pnpm_config_child_concurrency=2",
        "PNPM_CONFIG_VERIFY_STORE_INTEGRITY=true",
        "NPM_CONFIG_CACHE=/work/.facility-package-cache/npm",
      ],
      Labels: {
        "facility.sandbox.namespace": "instance_alpha",
        "facility.sandbox.kind": "run",
        "facility.sandbox.run": "run_1",
      },
      HostConfig: {
        Init: true,
        Tmpfs: {
          "/tmp": "rw,exec,nosuid,nodev,size=512m",
          "/var/tmp": "rw,exec,nosuid,nodev,size=512m",
        },
        Mounts: [
          {
            Type: "volume",
            Source: expect.stringMatching(/^facility-package-cache-[a-f0-9]{32}$/),
            Target: "/work/.facility-package-cache",
            ReadOnly: false,
          },
        ],
      },
    });
    expect((created[0]?.HostConfig as { Tmpfs?: Record<string, string> }).Tmpfs).not.toHaveProperty(
      "/work",
    );
    expect(
      (created[0]?.Labels as Record<string, string> | undefined)?.["facility.run"],
    ).toBeUndefined();
    expect(listed[0]).toEqual({
      all: true,
      filters: {
        label: ["facility.sandbox.namespace=instance_alpha", "facility.sandbox.kind=run"],
      },
    });
  });

  it("does not mount a project package cache into previews", async () => {
    const created: Array<Record<string, unknown>> = [];
    const docker = {
      getImage: () => ({ inspect: async () => ({ Id: "sha256:preview" }) }),
      createContainer: async (options: Record<string, unknown>) => {
        created.push(options);
        return {
          id: "preview_1",
          start: async () => undefined,
          inspect: async () => ({ NetworkSettings: { Ports: {} } }),
          remove: async () => undefined,
        };
      },
    };
    const driver = new DockerSandboxDriver(docker as never);

    await driver.launch({
      runId: "preview:1",
      namespace: "instance_alpha",
      kind: "preview",
      cachePartition: "project_partition_alpha",
      image: "preview:test",
      env: {},
      cpu: 1,
      memoryMb: 256,
      timeoutMin: 5,
    });

    expect(created[0]).toMatchObject({
      Env: [],
      Labels: { "facility.sandbox.kind": "preview" },
      HostConfig: expect.not.objectContaining({ Mounts: expect.anything() }),
    });
  });
});
