import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { githubRequest } from "../src/index.js";

describe("signed GitHub delivery timeout", () => {
  it("aborts a request after an unresponsive local server accepts it", async () => {
    const sockets = new Set<Socket>();
    let resolveRequestAccepted: (() => void) | undefined;
    const requestAccepted = new Promise<void>((resolve) => {
      resolveRequestAccepted = resolve;
    });
    let resolveConnectionClosed: (() => void) | undefined;
    const connectionClosed = new Promise<void>((resolve) => {
      resolveConnectionClosed = resolve;
    });
    const server = createServer(() => {
      // Intentionally never send headers: this deterministic local endpoint
      // represents an upstream that accepted the connection and then stalled.
      resolveRequestAccepted?.();
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => {
        sockets.delete(socket);
        resolveConnectionClosed?.();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const { port } = server.address() as AddressInfo;
      const pendingRequest = githubRequest(
        fetch,
        `http://127.0.0.1:${port}/graphql`,
        "installation-token",
        { method: "POST", body: "{}" },
        500,
      );
      await requestAccepted;
      await expect(pendingRequest).rejects.toMatchObject({ name: "TimeoutError" });
      await Promise.race([
        connectionClosed,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timed-out request connection remained open")), 2_000),
        ),
      ]);
      expect(sockets.size).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      expect(sockets.size).toBe(0);
    }
  });
});
