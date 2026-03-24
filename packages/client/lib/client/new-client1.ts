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

//simpler, but can break on non-literal params:
// const opts: CommandOptions = { parseMode: Math.random() ? 'resp' : 'raw' };
// const r = client.get('k', opts);
export type Reply<
  PARSE_MODE,
  DEFAULT_REPLY
> = (
  PARSE_MODE extends { parseMode: 'resp' } ? RespReply :
  PARSE_MODE extends { parseMode: 'raw' } ? Buffer :
  DEFAULT_REPLY
);

//fixes non-literal params, but is more complicated. should benchmark via --extendedDiagnostics`
type Reply1<O, DEFAULT_REPLY> =
  O extends { parseMode?: infer P }
    ? P extends 'resp' ? RespReply
      : P extends 'raw' ? Buffer
      : DEFAULT_REPLY
    : DEFAULT_REPLY;

const commandOptionsBrand = Symbol('new-client1-command-options');
type BrandedCommandOptions = CommandOptions & { readonly [commandOptionsBrand]: true };
type MaybeCommandOptions = BrandedCommandOptions | undefined;

export function makeOptions<O extends CommandOptions>(options: O): O & BrandedCommandOptions {
  return Object.defineProperty(
    options,
    commandOptionsBrand,
    {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false
    }
  ) as O & BrandedCommandOptions;
}

function isCommandOptions(value: unknown): value is BrandedCommandOptions {
  return typeof value === 'object' &&
    value !== null &&
    (value as BrandedCommandOptions)[commandOptionsBrand] === true;
}

export class NewClient1 {
  constructor(
    private queue: RedisCommandsQueue,
    private socket: RedisSocket,
    private resp: RespVersions
  ) { }

  #execute<T>(args: ReadonlyArray<RedisArgument>, clientOptions?: CommandOptions): Promise<T> {
    const replyPromise = this.queue.addCommand<T>(args, clientOptions);
    this.socket.write(this.queue.commandsToWrite());
    return replyPromise;
  }

  async #executeCommand<O extends MaybeCommandOptions, DEFAULT_REPLY>(
    command: Command,
    commandOptions: O | undefined,
    ...args: Array<unknown>
  ): Promise<Reply1<O, DEFAULT_REPLY>> {
    const parser = new BasicCommandParser();
    command.parseCommand(parser, ...args);

    const reply = await this.#execute<unknown>(parser.redisArgs, commandOptions);

    const parseMode = commandOptions?.parseMode;
    if (parseMode !== undefined && parseMode !== 'idiomatic') {
      return reply as Reply1<O, DEFAULT_REPLY>;
    }

    const transformReply = getTransformReply(command, this.resp);
    if (!transformReply) {
      return reply as Reply1<O, DEFAULT_REPLY>;
    }

    return transformReply(
      reply,
      parser.preserve,
      commandOptions?.typeMapping
    ) as Reply1<O, DEFAULT_REPLY>;
  }

  get<O extends MaybeCommandOptions = undefined>(
    key: RedisArgument,
    commandOption?: O
  ): Promise<Reply1<O, string | null>> {
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
  set<O extends MaybeCommandOptions = undefined>(
    key: RedisArgument,
    value: RedisArgument | number,
    options?: SetOptions,
    commandOptions?: O
  ): Promise<Reply1<O, string | null>> {
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
  hSet<O extends MaybeCommandOptions = undefined>(
    ...args: [...HSETArguments, commandOptions?: O]
  ): Promise<Reply1<O, number>> {
    const lastArg = args[args.length - 1];
    const commandOptions = (isCommandOptions(lastArg) ? lastArg : undefined) as O | undefined;
    const hSetArgs = (commandOptions ? args.slice(0, -1) : args) as HSETArguments;
    return this.#executeCommand<O, number>(
      HSET,
      commandOptions,
      ...hSetArgs
    );
  }

  clientInfo<O extends MaybeCommandOptions = undefined>(
    commandOptions?: O
  ): Promise<Reply1<O, ClientInfoReply>> {
    return this.#executeCommand<O, ClientInfoReply>(
      CLIENT_INFO,
      commandOptions
    );
  }
}
