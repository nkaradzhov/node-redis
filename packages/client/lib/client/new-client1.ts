import { RedisArgument } from '../..';
import HSET, { HSETArguments } from '../commands/HSET';
import SET, { SetOptions } from '../commands/SET';
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
  PARSE_MODE extends {parseMode: 'resp'} ? RespReply :
  PARSE_MODE extends {parseMode: 'raw'} ? Buffer :
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
  constructor(private queue: RedisCommandsQueue, private socket: RedisSocket) { }

  #execute<T>(args: ReadonlyArray<RedisArgument>, clientOptions?: CommandOptions): Promise<T> {
    const replyPromise = this.queue.addCommand<T>(args, clientOptions);
    this.socket.write(this.queue.commandsToWrite());
    return replyPromise;
  }

  get<O extends MaybeCommandOptions = undefined>(
    key: RedisArgument,
    commandOption?: O
  ): Promise<Reply1<O, string | null>> {
    const parser = new BasicCommandParser();
    parser.push('GET');
    parser.pushKey(key);

    return this.#execute<Reply1<O, string | null>>(parser.redisArgs, commandOption);
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
    const parser = new BasicCommandParser();
    SET.parseCommand(parser, key, value, options);
    return this.#execute<Reply1<O, string | null>>(
      parser.redisArgs,
      commandOptions
    );
  }

  // Same workaround as `set`: only branded trailing options are interpreted as
  // command options; otherwise all arguments are forwarded to HSET.parseCommand.
  hSet<O extends MaybeCommandOptions = undefined>(
    ...args: [...HSETArguments, commandOptions?: O]
  ): Promise<Reply1<O, number>> {
    const parser = new BasicCommandParser();
    const lastArg = args[args.length - 1];
    const commandOptions = (isCommandOptions(lastArg) ? lastArg : undefined) as O | undefined;
    const hSetArgs = (commandOptions ? args.slice(0, -1) : args) as HSETArguments;
    HSET.parseCommand(parser, ...hSetArgs);
    return this.#execute<Reply1<O, number>>(
      parser.redisArgs,
      commandOptions
    );
  }
}
