import { RedisArgument } from '../..';
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

export class NewClient1 {
  constructor(private queue: RedisCommandsQueue, private socket: RedisSocket) { }

  #execute<T>(args: ReadonlyArray<RedisArgument>, clientOptions?: CommandOptions): Promise<T> {
    const replyPromise = this.queue.addCommand<T>(args, clientOptions);
    this.socket.write(this.queue.commandsToWrite());
    return replyPromise;
  }

  get<O extends CommandOptions|undefined = undefined>(
    key: RedisArgument,
    clientOptions?: O
  ): Promise<Reply1<O, string | null>> {
    const parser = new BasicCommandParser();
    parser.push('GET');
    parser.pushKey(key);

    return this.#execute<Reply1<O, string | null>>(parser.redisArgs, clientOptions);
  }
}
