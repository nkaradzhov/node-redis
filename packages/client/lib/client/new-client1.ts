import { RedisArgument } from '../..';
import { getTransformReply } from '../commander';
import CLIENT_INFO, { ClientInfoReply } from '../commands/CLIENT_INFO';
import GET from '../commands/GET';
import HSET, { HSETArguments } from '../commands/HSET';
import SET, { SetOptions } from '../commands/SET';
import { Command, RespVersions } from '../RESP/types';
import { CommandOptions } from './commands-queue';
import RedisCommandsQueue from './commands-queue';
import { RespReply } from './new-client';
import { BasicCommandParser } from './parser';
import RedisSocket from './socket';

export type Reply<
  OPTIONS,
  DEFAULT_REPLY
> = (
  OPTIONS extends { parseMode: 'resp' } ? RespReply :
  OPTIONS extends { parseMode: 'raw' } ? Buffer :
  DEFAULT_REPLY
);

const commandOptionsBrand = Symbol('new-client1-command-options');
// Some commands accept trailing optional objects as regular command arguments
// (e.g. HSET object form), while command options are also trailing optional objects and
// have no required discriminator field.
// We add an internal brand and only treat branded objects as command options at runtime.
// Tradeoff: callers must wrap options with `makeOptions(...)`; a plain object is not treated
// as command options in ambiguous positions.
type BrandedCommandOptions<O extends CommandOptions> =
  O & { readonly [commandOptionsBrand]: true };

export function makeOptions<O extends CommandOptions>(options: O): BrandedCommandOptions<O> {
  return Object.defineProperty(
    options,
    commandOptionsBrand,
    {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false
    }
  ) as BrandedCommandOptions<O>;
}

function isCommandOptions(value: unknown): value is BrandedCommandOptions<CommandOptions> {
  return typeof value === 'object' &&
    value !== null &&
    (value as BrandedCommandOptions<CommandOptions>)[commandOptionsBrand] === true;
}

export class NewClient1 {
  constructor(
    private queue: RedisCommandsQueue,
    private socket: RedisSocket,
    private resp: RespVersions
  ) { }

  async #executeCommand<O extends CommandOptions, DEFAULT_REPLY>(
    command: Command,
    commandOptions: BrandedCommandOptions<O> | undefined,
    ...args: Array<unknown>
  ): Promise<Reply<O, DEFAULT_REPLY>> {
    const parser = new BasicCommandParser();
    command.parseCommand(parser, ...args);

    const resolvedOptions = commandOptions as CommandOptions | undefined;
    const replyPromise = this.queue.addCommand<unknown>(parser.redisArgs, resolvedOptions);
    this.socket.write(this.queue.commandsToWrite());
    const reply = await replyPromise;

    const parseMode = resolvedOptions?.parseMode;
    if (parseMode !== undefined && parseMode !== 'idiomatic') {
      return reply as Reply<O, DEFAULT_REPLY>;
    }

    const transformReply = getTransformReply(command, this.resp);
    if (!transformReply) {
      return reply as Reply<O, DEFAULT_REPLY>;
    }

    return transformReply(
      reply,
      parser.preserve,
      resolvedOptions?.typeMapping
    ) as Reply<O, DEFAULT_REPLY>;
  }

  get<O extends CommandOptions>(
    key: RedisArgument,
    commandOption?: BrandedCommandOptions<O>
  ): Promise<Reply<O, string | null>> {
    return this.#executeCommand<O, string | null>(
      GET,
      commandOption,
      key
    );
  }

  // Workaround for ambiguous command signatures:
  // command options do not have a required discriminator field, so for commands that
  // already accept trailing objects we only treat the last argument as command options
  // when it is branded via `makeOptions(...)`.
  set<O extends CommandOptions>(
    key: RedisArgument,
    value: RedisArgument | number,
    options?: SetOptions,
    commandOptions?: BrandedCommandOptions<O>
  ): Promise<Reply<O, string | null>> {
    return this.#executeCommand<O, string | null>(
      SET,
      commandOptions,
      key,
      value,
      options
    );
  }

  // Same workaround as `set`: only branded trailing options are interpreted as
  // command options; otherwise all arguments are forwarded to HSET.parseCommand.
  hSet<O extends CommandOptions>(
    ...args: [...HSETArguments, commandOptions?: BrandedCommandOptions<O>]
  ): Promise<Reply<O, number>> {
    const lastArg = args[args.length - 1];
    const commandOptions = (isCommandOptions(lastArg) ? lastArg : undefined) as BrandedCommandOptions<O> | undefined;
    const hSetArgs = (commandOptions ? args.slice(0, -1) : args) as HSETArguments;
    return this.#executeCommand<O, number>(
      HSET,
      commandOptions,
      ...hSetArgs
    );
  }

  clientInfo<O extends CommandOptions>(
    commandOptions?: BrandedCommandOptions<O>
  ): Promise<Reply<O, ClientInfoReply>> {
    return this.#executeCommand<O, ClientInfoReply>(
      CLIENT_INFO,
      commandOptions
    );
  }
}
