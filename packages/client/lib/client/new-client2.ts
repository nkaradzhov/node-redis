import { RedisArgument } from '../..';
import { getTransformReply } from '../commander';
import CLIENT_INFO, { ClientInfoReply } from '../commands/CLIENT_INFO';
import GET from '../commands/GET';
import HSET, { HSETArguments } from '../commands/HSET';
import SET, { SetOptions } from '../commands/SET';
import { Decoder } from '../RESP/decoder';
import { Command, RespVersions } from '../RESP/types';
import { BrandedCommandOptions, isCommandOptions } from './new-client-command-options';
import { CommandOptions, Parser } from './commands-queue';
import RedisCommandsQueue from './commands-queue';
import { RespReply } from './new-client';
import { BasicCommandParser } from './parser';
import RedisSocket from './socket';

export { makeOptions } from './new-client-command-options';

export type NewClient2CommandOptions = Omit<CommandOptions, 'parseMode'> & {
  parseMode?: never;
};

export type Reply<
  OPTIONS,
  DEFAULT_REPLY
> = (
  OPTIONS extends { parser: Parser<infer T> } ? T :
  DEFAULT_REPLY
);

export const rawParser: Parser<Buffer> = reply => reply;

export const respParser: Parser<RespReply> = reply => {
  let parsed: RespReply | undefined;
  let error: unknown;

  const decoder = new Decoder({
    onReply: decoded => {
      parsed = decoded as RespReply;
    },
    onErrorReply: err => {
      error = err;
    },
    onPush: () => undefined,
    getTypeMapping: () => ({}),
    getParseMode: () => 'resp'
  });

  decoder.write(reply);

  if (error !== undefined) {
    throw error;
  } else if (parsed === undefined) {
    throw new Error('Failed to parse raw reply with respParser');
  }

  return parsed;
};

export class NewClient2 {
  constructor(
    private queue: RedisCommandsQueue,
    private socket: RedisSocket,
    private resp: RespVersions
  ) { }

  async #executeCommand<O extends NewClient2CommandOptions, DEFAULT_REPLY>(
    command: Command,
    commandOptions: BrandedCommandOptions<O> | undefined,
    ...args: Array<unknown>
  ): Promise<Reply<O, DEFAULT_REPLY>> {
    const parser = new BasicCommandParser();
    command.parseCommand(parser, ...args);

    const resolvedOptions = commandOptions as O | undefined;
    const queueOptions = (
      resolvedOptions?.parser ?
        {
          ...resolvedOptions,
          parseMode: 'raw' as const
        } :
        resolvedOptions
    ) as CommandOptions | undefined;

    const replyPromise = this.queue.addCommand<unknown>(parser.redisArgs, queueOptions);
    this.socket.write(this.queue.commandsToWrite());
    const reply = await replyPromise;

    if (resolvedOptions?.parser) {
      if (!Buffer.isBuffer(reply)) {
        throw new TypeError('Custom parser expected raw Buffer reply');
      }

      return resolvedOptions.parser(reply) as Reply<O, DEFAULT_REPLY>;
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

  get<O extends NewClient2CommandOptions>(
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
  set<O extends NewClient2CommandOptions>(
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
  hSet<O extends NewClient2CommandOptions>(
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

  clientInfo<O extends NewClient2CommandOptions>(
    commandOptions?: BrandedCommandOptions<O>
  ): Promise<Reply<O, ClientInfoReply>> {
    return this.#executeCommand<O, ClientInfoReply>(
      CLIENT_INFO,
      commandOptions
    );
  }
}
