import type PgBoss from "pg-boss";

type QueueProducer = Pick<PgBoss, "start" | "createQueue" | "send">;

export function createQueueEnqueuer(boss: QueueProducer, onStarted?: () => void) {
  let startPromise: Promise<void> | undefined;
  const queuePromises = new Map<string, Promise<void>>();

  async function ensureStarted() {
    if (!startPromise) {
      startPromise = boss
        .start()
        .then(() => {
          onStarted?.();
        })
        .catch((error: unknown) => {
          startPromise = undefined;
          throw error;
        });
    }
    await startPromise;
  }

  async function ensureQueue(queue: string) {
    let queuePromise = queuePromises.get(queue);
    if (!queuePromise) {
      queuePromise = boss
        .createQueue(queue)
        .then(() => undefined)
        .catch((error: unknown) => {
          queuePromises.delete(queue);
          throw error;
        });
      queuePromises.set(queue, queuePromise);
    }
    await queuePromise;
  }

  return async (queue: string, data: Record<string, unknown>) => {
    await ensureStarted();
    await ensureQueue(queue);
    return boss.send(queue, data);
  };
}
