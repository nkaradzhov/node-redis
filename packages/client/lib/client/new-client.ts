import { RedisArgument } from "../..";
import { ParseMode } from "../RESP/decoder";
import RedisCommandsQueue from "./commands-queue";
import { BasicCommandParser } from "./parser";
import RedisSocket from "./socket";

type RespNodeType =
  | 'NULL'
  | 'BOOLEAN'
  | 'NUMBER'
  | 'BIG_NUMBER'
  | 'DOUBLE'
  | 'SIMPLE_STRING'
  | 'BLOB_STRING'
  | 'VERBATIM_STRING'
  | 'SIMPLE_ERROR'
  | 'BLOB_ERROR';

interface RespNode {
  type: RespNodeType;
  value: Buffer;
}

export type RespReply = RespNode | Array<RespReply> | Map<RespReply, RespReply>;

interface CommandReply<T> {
  get(): Promise<T>;
  getRaw(): Promise<Buffer>
  getResp(): Promise<RespReply>
}

export class NewClient {
  constructor(private queue: RedisCommandsQueue, private socket: RedisSocket) { }

  #execute<T>(args: ReadonlyArray<RedisArgument>, parseMode?: ParseMode): Promise<T> {
    const replyPromise = this.queue.addCommand<T>(args, parseMode ? { parseMode } : undefined);
    this.socket.write(this.queue.commandsToWrite());
    return replyPromise;
  }

  get(key: RedisArgument): CommandReply<string|null> {
    const parser = new BasicCommandParser()
    parser.push('GET');
    parser.pushKey(key);

    const args = parser.redisArgs;
    return {
      get: () => this.#execute<string>(args),
      getRaw: () => this.#execute<Buffer>(args, 'raw'),
      getResp: () => this.#execute<RespReply>(args, 'resp')
    }
  }
}
