
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { createClient } from "../../..";

/**
 * Options for the `fireCommandsUntilStopSignal` method
 */
type FireCommandsUntilStopSignalOptions = {
  /**
   * Number of commands to fire in each batch
   */
  batchSize: number;
  /**
   * Timeout between batches in milliseconds
   */
  timeoutMs: number;
  /**
   * Function that creates the commands to be executed
   */
  createCommands: (
    client: ReturnType<typeof createClient<any, any, any, any>>
  ) => Array<() => Promise<unknown>>;
};

export class TestCommandRunner {
  // Make defaultOptions static
  private static defaultOptions: FireCommandsUntilStopSignalOptions = {
    batchSize: 60,
    timeoutMs: 10,
    createCommands: (client) => [
      () => client.set(randomUUID(), Date.now()),
      () => client.get(randomUUID()),
    ],
  };

  // Make helper methods static
  static #toSettled<T>(p: Promise<T>) {
    return p
      .then((value) => ({ status: "fulfilled" as const, value, error: null }))
      .catch((reason) => ({
        status: "rejected" as const,
        value: null,
        error: reason,
      }));
  }

  static async #racePromises<S, T>({
    timeout,
    stopper,
  }: {
    timeout: Promise<S>;
    stopper: Promise<T>;
  }) {
    return Promise.race([
      TestCommandRunner.#toSettled<S>(timeout).then((result) => ({
        ...result,
        stop: false,
      })),
      TestCommandRunner.#toSettled<T>(stopper).then((result) => ({ 
        ...result, 
        stop: true 
      })),
    ]);
  }

  // Make main method static
  static async fireCommandsUntilStopSignal(
    client: ReturnType<typeof createClient<any, any, any, any>>,
    stopSignalPromise: Promise<unknown>,
    options?: Partial<FireCommandsUntilStopSignalOptions>
  ) {
    const executeOptions = {
      ...TestCommandRunner.defaultOptions,
      ...options,
    };

    const commandPromises = [];

    while (true) {
      for (let i = 0; i < executeOptions.batchSize; i++) {
        for (const command of executeOptions.createCommands(client)) {
          commandPromises.push(TestCommandRunner.#toSettled(command()));
        }
      }

      const result = await TestCommandRunner.#racePromises({
        timeout: setTimeout(executeOptions.timeoutMs),
        stopper: stopSignalPromise,
      });

      if (result.stop) {
        return {
          commandPromises,
          stopResult: result,
        };
      }
    }
  }
}
