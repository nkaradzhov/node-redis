// @ts-nocheck
import { VerbatimString } from './verbatim-string';
import { SimpleError, BlobError, ErrorReply } from '../errors';
import { TypeMapping } from './types';

// https://github.com/redis/redis-specifications/blob/master/protocol/RESP3.md
export const RESP_TYPES = {
  NULL: 95, // _
  BOOLEAN: 35, // #
  NUMBER: 58, // :
  BIG_NUMBER: 40, // (
  DOUBLE: 44, // ,
  SIMPLE_STRING: 43, // +
  BLOB_STRING: 36, // $
  VERBATIM_STRING: 61, // =
  SIMPLE_ERROR: 45, // -
  BLOB_ERROR: 33, // !
  ARRAY: 42, // *
  SET: 126, // ~
  MAP: 37, // %
  PUSH: 62 // >
} as const;

const ASCII = {
  '\r': 13,
  't': 116,
  '+': 43,
  '-': 45,
  '0': 48,
  '.': 46,
  'i': 105,
  'n': 110,
  'E': 69,
  'e': 101
} as const;

export const PUSH_TYPE_MAPPING = {
  [RESP_TYPES.BLOB_STRING]: Buffer
};

export type ParseMode = 'idiomatic' | 'resp' | 'raw';

const RESP_TYPE_NAMES = {
  [RESP_TYPES.NULL]: 'NULL',
  [RESP_TYPES.BOOLEAN]: 'BOOLEAN',
  [RESP_TYPES.NUMBER]: 'NUMBER',
  [RESP_TYPES.BIG_NUMBER]: 'BIG_NUMBER',
  [RESP_TYPES.DOUBLE]: 'DOUBLE',
  [RESP_TYPES.SIMPLE_STRING]: 'SIMPLE_STRING',
  [RESP_TYPES.BLOB_STRING]: 'BLOB_STRING',
  [RESP_TYPES.VERBATIM_STRING]: 'VERBATIM_STRING',
  [RESP_TYPES.SIMPLE_ERROR]: 'SIMPLE_ERROR',
  [RESP_TYPES.BLOB_ERROR]: 'BLOB_ERROR',
  [RESP_TYPES.ARRAY]: 'ARRAY',
  [RESP_TYPES.SET]: 'SET',
  [RESP_TYPES.MAP]: 'MAP',
  [RESP_TYPES.PUSH]: 'PUSH'
} as const;

// this was written with performance in mind, so it's not very readable... sorry :(

interface DecoderOptions {
  onReply(reply: any): unknown;
  onErrorReply(err: ErrorReply): unknown;
  onPush(push: Array<any>): unknown;
  getTypeMapping(): TypeMapping;
  getParseMode?(): ParseMode;
}

export class Decoder {
  onReply;
  onErrorReply;
  onPush;
  getTypeMapping;
  getParseMode;
  #cursor = 0;
  #next;
  #streamOffset = 0;
  #chunkWindow: Array<{
    start: number;
    end: number;
    chunk: Buffer;
  }> = [];
  #rawCapture:
  | {
    start: number;
  }
  | undefined;
  #deferredRawEnd: number | undefined;
  #currentChunk;
  #currentChunkStart = 0;
  #currentChunkEnd = 0;

  constructor(config: DecoderOptions) {
    this.onReply = config.onReply;
    this.onErrorReply = config.onErrorReply;
    this.onPush = config.onPush;
    this.getTypeMapping = config.getTypeMapping;
    this.getParseMode = config.getParseMode ?? (() => 'idiomatic');
  }

  reset() {
    this.#cursor = 0;
    this.#next = undefined;
    this.#streamOffset = 0;
    this.#chunkWindow = [];
    this.#rawCapture = undefined;
    this.#deferredRawEnd = undefined;
    this.#currentChunk = undefined;
    this.#currentChunkStart = 0;
    this.#currentChunkEnd = 0;
  }

  write(chunk) {
    this.#currentChunk = chunk;
    this.#currentChunkStart = this.#streamOffset;
    this.#currentChunkEnd = this.#streamOffset + chunk.length;
    this.#streamOffset = this.#currentChunkEnd;
    if (this.#rawCapture) {
      this.#ensureCurrentChunkInWindow();
    }

    if (this.#cursor >= chunk.length) {
      if (
        this.#deferredRawEnd !== undefined &&
        this.#currentChunkStart + this.#cursor >= this.#deferredRawEnd
      ) {
        this.#flushDeferredRawReply();
      }

      this.#cursor -= chunk.length;
      this.#pruneChunkWindow();
      return;
    }

    if (this.#next) {
      if (this.#next(chunk) || this.#cursor >= chunk.length) {
        this.#cursor -= chunk.length;
        this.#pruneChunkWindow();
        return;
      }
    }

    do {
      const typeStart = this.#cursor;
      const type = chunk[this.#cursor];
      const parseMode = this.#resolveTopLevelParseMode(type);
      if (parseMode === 'raw') {
        this.#startRawCapture(this.#currentChunkStart + typeStart);
      }

      if (++this.#cursor === chunk.length) {
        this.#next = this.#continueDecodeTypeValue.bind(this, type, parseMode);
        break;
      }

      if (this.#decodeTypeValue(type, parseMode, chunk)) {
        break;
      }
    } while (this.#cursor < chunk.length);

    this.#pruneChunkWindow();
    this.#cursor -= chunk.length;
  }

  #resolveTopLevelParseMode(type): ParseMode {
    switch (type) {
      case RESP_TYPES.NULL:
      case RESP_TYPES.BOOLEAN:
      case RESP_TYPES.NUMBER:
      case RESP_TYPES.BIG_NUMBER:
      case RESP_TYPES.DOUBLE:
      case RESP_TYPES.SIMPLE_STRING:
      case RESP_TYPES.BLOB_STRING:
      case RESP_TYPES.VERBATIM_STRING:
      case RESP_TYPES.ARRAY:
      case RESP_TYPES.SET:
      case RESP_TYPES.MAP:
        return this.getParseMode();

      default:
        return 'idiomatic';
    }
  }

  #continueDecodeTypeValue(type, parseMode, chunk) {
    this.#next = undefined;
    return this.#decodeTypeValue(type, parseMode, chunk);
  }

  #decodeTypeValue(type, parseMode, chunk) {
    switch (type) {
      case RESP_TYPES.SIMPLE_ERROR:
        return this.#handleDecodedValue(
          this.onErrorReply,
          this.#decodeSimpleError(chunk)
        );

      case RESP_TYPES.BLOB_ERROR:
        return this.#handleDecodedValue(
          this.onErrorReply,
          this.#decodeBlobError(chunk)
        );

      case RESP_TYPES.PUSH:
        return this.#handleDecodedValue(
          this.onPush,
          this.#decodeArray(PUSH_TYPE_MAPPING, chunk)
        );

      default:
        return this.#decodeReplyTypeValue(type, parseMode, chunk);
    }
  }

  #decodeReplyTypeValue(type, parseMode, chunk) {
    switch (parseMode) {
      case 'raw':
        return this.#handleDecodedRawValue(
          this.#skipReplyTypeValue(type, chunk)
        );

      case 'resp':
        return this.#handleDecodedValue(
          this.onReply,
          this.#decodeRespTypeValue(type, chunk)
        );

      default:
        return this.#handleDecodedValue(
          this.onReply,
          this.#decodeIdiomaticReplyTypeValue(type, chunk)
        );
    }
  }

  #decodeIdiomaticReplyTypeValue(type, chunk) {
    switch (type) {
      case RESP_TYPES.NULL:
        return this.#decodeNull();

      case RESP_TYPES.BOOLEAN:
        return this.#decodeBoolean(chunk);

      case RESP_TYPES.NUMBER:
        return this.#decodeNumber(
          this.getTypeMapping()[RESP_TYPES.NUMBER],
          chunk
        );

      case RESP_TYPES.BIG_NUMBER:
        return this.#decodeBigNumber(
          this.getTypeMapping()[RESP_TYPES.BIG_NUMBER],
          chunk
        );

      case RESP_TYPES.DOUBLE:
        return this.#decodeDouble(
          this.getTypeMapping()[RESP_TYPES.DOUBLE],
          chunk
        );

      case RESP_TYPES.SIMPLE_STRING:
        return this.#decodeSimpleString(
          this.getTypeMapping()[RESP_TYPES.SIMPLE_STRING],
          chunk
        );

      case RESP_TYPES.BLOB_STRING:
        return this.#decodeBlobString(
          this.getTypeMapping()[RESP_TYPES.BLOB_STRING],
          chunk
        );

      case RESP_TYPES.VERBATIM_STRING:
        return this.#decodeVerbatimString(
          this.getTypeMapping()[RESP_TYPES.VERBATIM_STRING],
          chunk
        );

      case RESP_TYPES.ARRAY:
        return this.#decodeArray(this.getTypeMapping(), chunk);

      case RESP_TYPES.SET:
        return this.#decodeSet(this.getTypeMapping(), chunk);

      case RESP_TYPES.MAP:
        return this.#decodeMap(this.getTypeMapping(), chunk);

      default:
        throw new Error(`Unknown RESP type ${type} "${String.fromCharCode(type)}"`);
    }
  }

  #skipReplyTypeValue(type, chunk) {
    switch (type) {
      case RESP_TYPES.NULL:
        this.#decodeNull();
        return;

      case RESP_TYPES.BOOLEAN:
        this.#cursor += 3; // skip {t|f}\r\n
        return;

      case RESP_TYPES.NUMBER:
      case RESP_TYPES.BIG_NUMBER:
      case RESP_TYPES.DOUBLE:
      case RESP_TYPES.SIMPLE_STRING:
      case RESP_TYPES.SIMPLE_ERROR:
        return this.#skipSimpleStringLike(chunk);

      case RESP_TYPES.BLOB_STRING:
      case RESP_TYPES.BLOB_ERROR:
        return this.#skipBlobString(chunk);

      case RESP_TYPES.VERBATIM_STRING:
        return this.#skipVerbatimString(chunk);

      case RESP_TYPES.ARRAY:
        return this.#skipArray(chunk);

      case RESP_TYPES.SET:
        return this.#skipSet(chunk);

      case RESP_TYPES.MAP:
        return this.#skipMap(chunk);

      case RESP_TYPES.PUSH:
        return this.#skipArray(chunk);

      default:
        throw new Error(`Unknown RESP type ${type} "${String.fromCharCode(type)}"`);
    }
  }

  #skipSimpleStringLike(chunk) {
    let cursor = this.#cursor;
    while (cursor < chunk.length) {
      if (chunk[cursor] === ASCII['\r']) {
        this.#cursor = cursor + 2; // skip \r\n
        return;
      }

      ++cursor;
    }

    this.#cursor = cursor;
    return this.#skipSimpleStringLike.bind(this);
  }

  #skipBlobString(chunk) {
    // RESP2 bulk string null
    if (chunk[this.#cursor] === ASCII['-']) {
      this.#cursor += 4; // skip -1\r\n
      return;
    }

    const length = this.#decodeUnsingedNumber(0, chunk);
    return typeof length === 'function' ?
      this.#continueSkipBlobStringLength.bind(this, length) :
      this.#skipBytes(length + 2, chunk); // payload + \r\n
  }

  #continueSkipBlobStringLength(lengthCb, chunk) {
    const length = lengthCb(chunk);
    return typeof length === 'function' ?
      this.#continueSkipBlobStringLength.bind(this, length) :
      this.#skipBytes(length + 2, chunk);
  }

  #skipVerbatimString(chunk) {
    const length = this.#decodeUnsingedNumber(0, chunk);
    return typeof length === 'function' ?
      this.#continueSkipVerbatimStringLength.bind(this, length) :
      this.#skipBytes(length + 2, chunk); // <format>:<payload> + \r\n
  }

  #continueSkipVerbatimStringLength(lengthCb, chunk) {
    const length = lengthCb(chunk);
    return typeof length === 'function' ?
      this.#continueSkipVerbatimStringLength.bind(this, length) :
      this.#skipBytes(length + 2, chunk);
  }

  #skipBytes(bytes, chunk) {
    const end = this.#cursor + bytes;
    if (end <= chunk.length) {
      this.#cursor = end;
      return;
    }

    this.#cursor = chunk.length;
    return this.#continueSkipBytes.bind(this, end - chunk.length);
  }

  #continueSkipBytes(remaining, chunk) {
    const end = this.#cursor + remaining;
    if (end <= chunk.length) {
      this.#cursor = end;
      return;
    }

    this.#cursor = chunk.length;
    return this.#continueSkipBytes.bind(this, end - chunk.length);
  }

  #skipArray(chunk) {
    // RESP2 null array
    if (chunk[this.#cursor] === ASCII['-']) {
      this.#cursor += 4; // skip -1\r\n
      return;
    }

    const length = this.#decodeUnsingedNumber(0, chunk);
    return typeof length === 'function' ?
      this.#continueSkipArrayLength.bind(this, length) :
      this.#skipItems(length, chunk);
  }

  #continueSkipArrayLength(lengthCb, chunk) {
    const length = lengthCb(chunk);
    return typeof length === 'function' ?
      this.#continueSkipArrayLength.bind(this, length) :
      this.#skipItems(length, chunk);
  }

  #skipSet(chunk) {
    const length = this.#decodeUnsingedNumber(0, chunk);
    return typeof length === 'function' ?
      this.#continueSkipSetLength.bind(this, length) :
      this.#skipItems(length, chunk);
  }

  #continueSkipSetLength(lengthCb, chunk) {
    const length = lengthCb(chunk);
    return typeof length === 'function' ?
      this.#continueSkipSetLength.bind(this, length) :
      this.#skipItems(length, chunk);
  }

  #skipMap(chunk) {
    const length = this.#decodeUnsingedNumber(0, chunk);
    return typeof length === 'function' ?
      this.#continueSkipMapLength.bind(this, length) :
      this.#skipItems(length * 2, chunk);
  }

  #continueSkipMapLength(lengthCb, chunk) {
    const length = lengthCb(chunk);
    return typeof length === 'function' ?
      this.#continueSkipMapLength.bind(this, length) :
      this.#skipItems(length * 2, chunk);
  }

  #skipItems(remaining, chunk) {
    while (remaining > 0) {
      if (this.#cursor >= chunk.length) {
        return this.#skipItems.bind(this, remaining);
      }

      const item = this.#skipNestedType(chunk);
      if (typeof item === 'function') {
        return this.#continueSkipItems.bind(this, remaining, item);
      }

      --remaining;
    }
  }

  #continueSkipItems(remaining, itemCb, chunk) {
    const item = itemCb(chunk);
    if (typeof item === 'function') {
      return this.#continueSkipItems.bind(this, remaining, item);
    }

    return this.#skipItems(remaining - 1, chunk);
  }

  #skipNestedType(chunk) {
    const type = chunk[this.#cursor];
    return ++this.#cursor === chunk.length ?
      this.#skipNestedTypeValue.bind(this, type) :
      this.#skipNestedTypeValue(type, chunk);
  }

  #skipNestedTypeValue(type, chunk) {
    switch (type) {
      case RESP_TYPES.NULL:
      case RESP_TYPES.BOOLEAN:
      case RESP_TYPES.NUMBER:
      case RESP_TYPES.BIG_NUMBER:
      case RESP_TYPES.DOUBLE:
      case RESP_TYPES.SIMPLE_STRING:
      case RESP_TYPES.BLOB_STRING:
      case RESP_TYPES.VERBATIM_STRING:
      case RESP_TYPES.SIMPLE_ERROR:
      case RESP_TYPES.BLOB_ERROR:
      case RESP_TYPES.ARRAY:
      case RESP_TYPES.SET:
      case RESP_TYPES.MAP:
      case RESP_TYPES.PUSH:
        return this.#skipReplyTypeValue(type, chunk);

      default:
        throw new Error(`Unknown RESP type ${type} "${String.fromCharCode(type)}"`);
    }
  }

  #ensureCurrentChunkInWindow() {
    if (!this.#currentChunk) {
      return;
    }

    const last = this.#chunkWindow[this.#chunkWindow.length - 1];
    if (
      last &&
      last.start === this.#currentChunkStart &&
      last.end === this.#currentChunkEnd
    ) {
      return;
    }

    this.#chunkWindow.push({
      start: this.#currentChunkStart,
      end: this.#currentChunkEnd,
      chunk: this.#currentChunk
    });
  }

  #startRawCapture(start: number) {
    if (this.#rawCapture) {
      return;
    }

    this.#ensureCurrentChunkInWindow();
    this.#rawCapture = { start };
  }

  #handleDecodedRawValue(value) {
    if (typeof value === 'function') {
      this.#next = this.#continueDecodeRawValue.bind(this, value);
      return true;
    }

    return this.#emitRawOrContinue();
  }

  #continueDecodeRawValue(next, chunk) {
    this.#next = undefined;
    return this.#handleDecodedRawValue(next(chunk));
  }

  #emitRawOrContinue() {
    const end = this.#currentChunkStart + this.#cursor;
    if (end > this.#currentChunkEnd) {
      this.#deferredRawEnd = end;
      this.#next = this.#continueDeferredRawReply.bind(this);
      return true;
    }

    this.onReply(this.#finishRawCapture(end));
    return false;
  }

  #continueDeferredRawReply(chunk) {
    this.#next = undefined;
    if (
      this.#deferredRawEnd !== undefined &&
      this.#currentChunkStart + this.#cursor < this.#deferredRawEnd
    ) {
      this.#next = this.#continueDeferredRawReply.bind(this);
      return true;
    }

    this.#flushDeferredRawReply();
    return false;
  }

  #flushDeferredRawReply() {
    if (this.#deferredRawEnd === undefined) {
      return;
    }

    const end = this.#deferredRawEnd;
    this.#deferredRawEnd = undefined;
    this.#next = undefined;
    this.onReply(this.#finishRawCapture(end));
  }

  #finishRawCapture(end) {
    if (!this.#rawCapture) {
      throw new Error('Missing raw capture state');
    }

    const start = this.#rawCapture.start;
    this.#rawCapture = undefined;
    const raw = this.#sliceChunkWindow(start, end);
    this.#chunkWindow = [];
    return raw;
  }

  #sliceChunkWindow(start, end) {
    const slices = [];
    let covered = 0;
    for (const entry of this.#chunkWindow) {
      if (entry.end <= start || entry.start >= end) {
        continue;
      }

      const from = Math.max(start, entry.start) - entry.start,
        to = Math.min(end, entry.end) - entry.start,
        slice = entry.chunk.subarray(from, to);
      slices.push(slice);
      covered += slice.length;
    }

    if (covered !== end - start) {
      throw new Error('Failed to capture raw frame');
    }

    return slices.length === 1 ?
      slices[0] :
      Buffer.concat(slices);
  }

  #pruneChunkWindow() {
    if (!this.#rawCapture) {
      this.#chunkWindow = [];
      return;
    }

    const start = this.#rawCapture.start;
    let i = 0;
    while (i < this.#chunkWindow.length && this.#chunkWindow[i].end <= start) {
      ++i;
    }

    if (i > 0) {
      this.#chunkWindow = this.#chunkWindow.slice(i);
    }
  }

  #handleDecodedValue(cb, value) {
    if (typeof value === 'function') {
      this.#next = this.#continueDecodeValue.bind(this, cb, value);
      return true;
    }

    cb(value);
    return false;
  }

  #continueDecodeValue(cb, next, chunk) {
    this.#next = undefined;
    return this.#handleDecodedValue(cb, next(chunk));
  }

  #decodeNull() {
    this.#cursor += 2; // skip \r\n
    return null;
  }

  #decodeBoolean(chunk) {
    const boolean = chunk[this.#cursor] === ASCII.t;
    this.#cursor += 3; // skip {t | f}\r\n
    return boolean;
  }

  #decodeNumber(type, chunk) {
    if (type === String) {
      return this.#decodeSimpleString(String, chunk);
    }

    switch (chunk[this.#cursor]) {
      case ASCII['+']:
        return this.#maybeDecodeNumberValue(false, chunk);

      case ASCII['-']:
        return this.#maybeDecodeNumberValue(true, chunk);

      default:
        return this.#decodeNumberValue(
          false,
          this.#decodeUnsingedNumber.bind(this, 0),
          chunk
        );
    }
  }

  #maybeDecodeNumberValue(isNegative, chunk) {
    const cb = this.#decodeUnsingedNumber.bind(this, 0);
    return ++this.#cursor === chunk.length ?
      this.#decodeNumberValue.bind(this, isNegative, cb) :
      this.#decodeNumberValue(isNegative, cb, chunk);
  }

  #decodeNumberValue(isNegative, numberCb, chunk) {
    const number = numberCb(chunk);
    return typeof number === 'function' ?
      this.#decodeNumberValue.bind(this, isNegative, number) :
      isNegative ? -number : number;
  }

  #decodeUnsingedNumber(number, chunk) {
    let cursor = this.#cursor;
    do {
      const byte = chunk[cursor];
      if (byte === ASCII['\r']) {
        this.#cursor = cursor + 2; // skip \r\n
        return number;
      }
      number = number * 10 + byte - ASCII['0'];
    } while (++cursor < chunk.length);

    this.#cursor = cursor;
    return this.#decodeUnsingedNumber.bind(this, number);
  }

  #decodeBigNumber(type, chunk) {
    if (type === String) {
      return this.#decodeSimpleString(String, chunk);
    }

    switch (chunk[this.#cursor]) {
      case ASCII['+']:
        return this.#maybeDecodeBigNumberValue(false, chunk);

      case ASCII['-']:
        return this.#maybeDecodeBigNumberValue(true, chunk);

      default:
        return this.#decodeBigNumberValue(
          false,
          this.#decodeUnsingedBigNumber.bind(this, 0n),
          chunk
        );
    }
  }

  #maybeDecodeBigNumberValue(isNegative, chunk) {
    const cb = this.#decodeUnsingedBigNumber.bind(this, 0n);
    return ++this.#cursor === chunk.length ?
      this.#decodeBigNumberValue.bind(this, isNegative, cb) :
      this.#decodeBigNumberValue(isNegative, cb, chunk);
  }

  #decodeBigNumberValue(isNegative, bigNumberCb, chunk) {
    const bigNumber = bigNumberCb(chunk);
    return typeof bigNumber === 'function' ?
      this.#decodeBigNumberValue.bind(this, isNegative, bigNumber) :
      isNegative ? -bigNumber : bigNumber;
  }

  #decodeUnsingedBigNumber(bigNumber, chunk) {
    let cursor = this.#cursor;
    do {
      const byte = chunk[cursor];
      if (byte === ASCII['\r']) {
        this.#cursor = cursor + 2; // skip \r\n
        return bigNumber;
      }
      bigNumber = bigNumber * 10n + BigInt(byte - ASCII['0']);
    } while (++cursor < chunk.length);

    this.#cursor = cursor;
    return this.#decodeUnsingedBigNumber.bind(this, bigNumber);
  }

  #decodeDouble(type, chunk) {
    if (type === String) {
      return this.#decodeSimpleString(String, chunk);
    }

    switch (chunk[this.#cursor]) {
      case ASCII.n:
        this.#cursor += 5; // skip nan\r\n
        return NaN;

      case ASCII['+']:
        return this.#maybeDecodeDoubleInteger(false, chunk);

      case ASCII['-']:
        return this.#maybeDecodeDoubleInteger(true, chunk);

      default:
        return this.#decodeDoubleInteger(false, 0, chunk);
    }
  }

  #maybeDecodeDoubleInteger(isNegative, chunk) {
    return ++this.#cursor === chunk.length ?
      this.#decodeDoubleInteger.bind(this, isNegative, 0) :
      this.#decodeDoubleInteger(isNegative, 0, chunk);
  }

  #decodeDoubleInteger(isNegative, integer, chunk) {
    if (chunk[this.#cursor] === ASCII.i) {
      this.#cursor += 5; // skip inf\r\n
      return isNegative ? -Infinity : Infinity;
    }

    return this.#continueDecodeDoubleInteger(isNegative, integer, chunk);
  }

  #continueDecodeDoubleInteger(isNegative, integer, chunk) {
    let cursor = this.#cursor;
    do {
      const byte = chunk[cursor];
      switch (byte) {
        case ASCII['.']:
          this.#cursor = cursor + 1; // skip .
          return this.#cursor < chunk.length ?
            this.#decodeDoubleDecimal(isNegative, 0, integer, chunk) :
            this.#decodeDoubleDecimal.bind(this, isNegative, 0, integer);

        case ASCII.E:
        case ASCII.e:
          this.#cursor = cursor + 1; // skip E/e
          const i = isNegative ? -integer : integer;
          return this.#cursor < chunk.length ?
            this.#decodeDoubleExponent(i, chunk) :
            this.#decodeDoubleExponent.bind(this, i);

        case ASCII['\r']:
          this.#cursor = cursor + 2; // skip \r\n
          return isNegative ? -integer : integer;

        default:
          integer = integer * 10 + byte - ASCII['0'];
      }
    } while (++cursor < chunk.length);

    this.#cursor = cursor;
    return this.#continueDecodeDoubleInteger.bind(this, isNegative, integer);
  }

  // Precalculated multipliers for decimal points to improve performance
  // "... about 15 to 17 decimal places ..."
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number#:~:text=about%2015%20to%2017%20decimal%20places
  static #DOUBLE_DECIMAL_MULTIPLIERS = [
    1e-1, 1e-2, 1e-3, 1e-4, 1e-5, 1e-6,
    1e-7, 1e-8, 1e-9, 1e-10, 1e-11, 1e-12,
    1e-13, 1e-14, 1e-15, 1e-16, 1e-17
  ];

  #decodeDoubleDecimal(isNegative, decimalIndex, double, chunk) {
    let cursor = this.#cursor;
    do {
      const byte = chunk[cursor];
      switch (byte) {
        case ASCII.E:
        case ASCII.e:
          this.#cursor = cursor + 1; // skip E/e
          const d = isNegative ? -double : double;
          return this.#cursor === chunk.length ?
            this.#decodeDoubleExponent.bind(this, d) :
            this.#decodeDoubleExponent(d, chunk);

        case ASCII['\r']:
          this.#cursor = cursor + 2; // skip \r\n
          return isNegative ? -double : double;
      }

      if (decimalIndex < Decoder.#DOUBLE_DECIMAL_MULTIPLIERS.length) {
        double += (byte - ASCII['0']) * Decoder.#DOUBLE_DECIMAL_MULTIPLIERS[decimalIndex++];
      }
    } while (++cursor < chunk.length);

    this.#cursor = cursor;
    return this.#decodeDoubleDecimal.bind(this, isNegative, decimalIndex, double);
  }

  #decodeDoubleExponent(double, chunk) {
    switch (chunk[this.#cursor]) {
      case ASCII['+']:
        return ++this.#cursor === chunk.length ?
          this.#continueDecodeDoubleExponent.bind(this, false, double, 0) :
          this.#continueDecodeDoubleExponent(false, double, 0, chunk);

      case ASCII['-']:
        return ++this.#cursor === chunk.length ?
          this.#continueDecodeDoubleExponent.bind(this, true, double, 0) :
          this.#continueDecodeDoubleExponent(true, double, 0, chunk);
    }

    return this.#continueDecodeDoubleExponent(false, double, 0, chunk);
  }

  #continueDecodeDoubleExponent(isNegative, double, exponent, chunk) {
    let cursor = this.#cursor;
    do {
      const byte = chunk[cursor];
      if (byte === ASCII['\r']) {
        this.#cursor = cursor + 2; // skip \r\n
        return double * 10 ** (isNegative ? -exponent : exponent);
      }

      exponent = exponent * 10 + byte - ASCII['0'];
    } while (++cursor < chunk.length);

    this.#cursor = cursor;
    return this.#continueDecodeDoubleExponent.bind(this, isNegative, double, exponent);
  }

  #findCRLF(chunk, cursor) {
    while (chunk[cursor] !== ASCII['\r']) {
      if (++cursor === chunk.length) {
        this.#cursor = chunk.length;
        return -1;
      }
    }

    this.#cursor = cursor + 2; // skip \r\n
    return cursor;
  }

  #decodeSimpleString(type, chunk) {
    const start = this.#cursor,
      crlfIndex = this.#findCRLF(chunk, start);
    if (crlfIndex === -1) {
      return this.#continueDecodeSimpleString.bind(
        this,
        [chunk.subarray(start)],
        type
      );
    }

    const slice = chunk.subarray(start, crlfIndex);
    return type === Buffer ?
      slice :
      slice.toString();
  }

  #continueDecodeSimpleString(chunks, type, chunk) {
    const start = this.#cursor,
      crlfIndex = this.#findCRLF(chunk, start);
    if (crlfIndex === -1) {
      chunks.push(chunk.subarray(start));
      return this.#continueDecodeSimpleString.bind(this, chunks, type);
    }

    chunks.push(chunk.subarray(start, crlfIndex));
    const buffer = Buffer.concat(chunks);
    return type === Buffer ? buffer : buffer.toString();
  }

  #decodeBlobString(type, chunk) {
    // RESP 2 bulk string null
    // https://github.com/redis/redis-specifications/blob/master/protocol/RESP2.md#resp-bulk-strings
    if (chunk[this.#cursor] === ASCII['-']) {
      this.#cursor += 4; // skip -1\r\n
      return null;
    }

    const length = this.#decodeUnsingedNumber(0, chunk);
    if (typeof length === 'function') {
      return this.#continueDecodeBlobStringLength.bind(this, length, type);
    } else if (this.#cursor >= chunk.length) {
      return this.#decodeBlobStringWithLength.bind(this, length, type);
    }

    return this.#decodeBlobStringWithLength(length, type, chunk);
  }

  #continueDecodeBlobStringLength(lengthCb, type, chunk) {
    const length = lengthCb(chunk);
    if (typeof length === 'function') {
      return this.#continueDecodeBlobStringLength.bind(this, length, type);
    } else if (this.#cursor >= chunk.length) {
      return this.#decodeBlobStringWithLength.bind(this, length, type);
    }

    return this.#decodeBlobStringWithLength(length, type, chunk);
  }

  #decodeStringWithLength(length, skip, type, chunk) {
    const end = this.#cursor + length;
    if (end >= chunk.length) {
      const slice = chunk.subarray(this.#cursor);
      this.#cursor = chunk.length;
      return this.#continueDecodeStringWithLength.bind(
        this,
        length - slice.length,
        [slice],
        skip,
        type
      );
    }

    const slice = chunk.subarray(this.#cursor, end);
    this.#cursor = end + skip;
    return type === Buffer ?
      slice :
      slice.toString();
  }

  #continueDecodeStringWithLength(length, chunks, skip, type, chunk) {
    const end = this.#cursor + length;
    if (end >= chunk.length) {
      const slice = chunk.subarray(this.#cursor);
      chunks.push(slice);
      this.#cursor = chunk.length;
      return this.#continueDecodeStringWithLength.bind(
        this,
        length - slice.length,
        chunks,
        skip,
        type
      );
    }

    chunks.push(chunk.subarray(this.#cursor, end));
    this.#cursor = end + skip;
    const buffer = Buffer.concat(chunks);
    return type === Buffer ? buffer : buffer.toString();
  }

  #decodeBlobStringWithLength(length, type, chunk) {
    return this.#decodeStringWithLength(length, 2, type, chunk);
  }

  #decodeVerbatimString(type, chunk) {
    return this.#continueDecodeVerbatimStringLength(
      this.#decodeUnsingedNumber.bind(this, 0),
      type,
      chunk
    );
  }

  #continueDecodeVerbatimStringLength(lengthCb, type, chunk) {
    const length = lengthCb(chunk);
    return typeof length === 'function' ?
      this.#continueDecodeVerbatimStringLength.bind(this, length, type) :
      this.#decodeVerbatimStringWithLength(length, type, chunk);
  }

  #decodeVerbatimStringWithLength(length, type, chunk) {
    const stringLength = length - 4; // skip <format>:
    if (type === VerbatimString) {
      return this.#decodeVerbatimStringFormat(stringLength, chunk);
    }

    this.#cursor += 4; // skip <format>:
    return this.#cursor >= chunk.length ?
      this.#decodeBlobStringWithLength.bind(this, stringLength, type) :
      this.#decodeBlobStringWithLength(stringLength, type, chunk);
  }

  #decodeVerbatimStringFormat(stringLength, chunk) {
    const formatCb = this.#decodeStringWithLength.bind(this, 3, 1, String);
    return this.#cursor >= chunk.length ?
      this.#continueDecodeVerbatimStringFormat.bind(this, stringLength, formatCb) :
      this.#continueDecodeVerbatimStringFormat(stringLength, formatCb, chunk);
  }

  #continueDecodeVerbatimStringFormat(stringLength, formatCb, chunk) {
    const format = formatCb(chunk);
    return typeof format === 'function' ?
      this.#continueDecodeVerbatimStringFormat.bind(this, stringLength, format) :
      this.#decodeVerbatimStringWithFormat(stringLength, format, chunk);
  }

  #decodeVerbatimStringWithFormat(stringLength, format, chunk) {
    return this.#continueDecodeVerbatimStringWithFormat(
      format,
      this.#decodeBlobStringWithLength.bind(this, stringLength, String),
      chunk
    );
  }

  #continueDecodeVerbatimStringWithFormat(format, stringCb, chunk) {
    const string = stringCb(chunk);
    return typeof string === 'function' ?
      this.#continueDecodeVerbatimStringWithFormat.bind(this, format, string) :
      new VerbatimString(format, string);
  }

  #decodeSimpleError(chunk) {
    const string = this.#decodeSimpleString(String, chunk);
    return typeof string === 'function' ?
      this.#continueDecodeSimpleError.bind(this, string) :
      new SimpleError(string);
  }

  #continueDecodeSimpleError(stringCb, chunk) {
    const string = stringCb(chunk);
    return typeof string === 'function' ?
      this.#continueDecodeSimpleError.bind(this, string) :
      new SimpleError(string);
  }

  #decodeBlobError(chunk) {
    const string = this.#decodeBlobString(String, chunk);
    return typeof string === 'function' ?
      this.#continueDecodeBlobError.bind(this, string) :
      new BlobError(string);
  }

  #continueDecodeBlobError(stringCb, chunk) {
    const string = stringCb(chunk);
    return typeof string === 'function' ?
      this.#continueDecodeBlobError.bind(this, string) :
      new BlobError(string);
  }

  #decodeNestedType(typeMapping, chunk) {
    const type = chunk[this.#cursor];
    return ++this.#cursor === chunk.length ?
      this.#decodeNestedTypeValue.bind(this, type, typeMapping) :
      this.#decodeNestedTypeValue(type, typeMapping, chunk);
  }

  #decodeNestedTypeValue(type, typeMapping, chunk) {
    switch (type) {
      case RESP_TYPES.NULL:
        return this.#decodeNull();

      case RESP_TYPES.BOOLEAN:
        return this.#decodeBoolean(chunk);

      case RESP_TYPES.NUMBER:
        return this.#decodeNumber(typeMapping[RESP_TYPES.NUMBER], chunk);

      case RESP_TYPES.BIG_NUMBER:
        return this.#decodeBigNumber(typeMapping[RESP_TYPES.BIG_NUMBER], chunk);

      case RESP_TYPES.DOUBLE:
        return this.#decodeDouble(typeMapping[RESP_TYPES.DOUBLE], chunk);

      case RESP_TYPES.SIMPLE_STRING:
        return this.#decodeSimpleString(typeMapping[RESP_TYPES.SIMPLE_STRING], chunk);

      case RESP_TYPES.BLOB_STRING:
        return this.#decodeBlobString(typeMapping[RESP_TYPES.BLOB_STRING], chunk);

      case RESP_TYPES.VERBATIM_STRING:
        return this.#decodeVerbatimString(typeMapping[RESP_TYPES.VERBATIM_STRING], chunk);

      case RESP_TYPES.SIMPLE_ERROR:
        return this.#decodeSimpleError(chunk);

      case RESP_TYPES.BLOB_ERROR:
        return this.#decodeBlobError(chunk);

      case RESP_TYPES.ARRAY:
        return this.#decodeArray(typeMapping, chunk);

      case RESP_TYPES.SET:
        return this.#decodeSet(typeMapping, chunk);

      case RESP_TYPES.MAP:
        return this.#decodeMap(typeMapping, chunk);

      default:
        throw new Error(`Unknown RESP type ${type} "${String.fromCharCode(type)}"`);
    }
  }

  #decodeArray(typeMapping, chunk) {
    // RESP 2 null
    // https://github.com/redis/redis-specifications/blob/master/protocol/RESP2.md#resp-arrays
    if (chunk[this.#cursor] === ASCII['-']) {
      this.#cursor += 4; // skip -1\r\n
      return null;
    }

    return this.#decodeArrayWithLength(
      this.#decodeUnsingedNumber(0, chunk),
      typeMapping,
      chunk
    );
  }

  #decodeArrayWithLength(length, typeMapping, chunk) {
    return typeof length === 'function' ?
      this.#continueDecodeArrayLength.bind(this, length, typeMapping) :
      this.#decodeArrayItems(
        new Array(length),
        0,
        typeMapping,
        chunk
      );
  }

  #continueDecodeArrayLength(lengthCb, typeMapping, chunk) {
    return this.#decodeArrayWithLength(
      lengthCb(chunk),
      typeMapping,
      chunk
    );
  }

  #decodeArrayItems(array, filled, typeMapping, chunk) {
    for (let i = filled; i < array.length; i++) {
      if (this.#cursor >= chunk.length) {
        return this.#decodeArrayItems.bind(
          this,
          array,
          i,
          typeMapping
        );
      }

      const item = this.#decodeNestedType(typeMapping, chunk);
      if (typeof item === 'function') {
        return this.#continueDecodeArrayItems.bind(
          this,
          array,
          i,
          item,
          typeMapping
        );
      }

      array[i] = item;
    }

    return array;
  }

  #continueDecodeArrayItems(array, filled, itemCb, typeMapping, chunk) {
    const item = itemCb(chunk);
    if (typeof item === 'function') {
      return this.#continueDecodeArrayItems.bind(
        this,
        array,
        filled,
        item,
        typeMapping
      );
    }

    array[filled++] = item;

    return this.#decodeArrayItems(array, filled, typeMapping, chunk);
  }

  #decodeSet(typeMapping, chunk) {
    const length = this.#decodeUnsingedNumber(0, chunk);
    if (typeof length === 'function') {
      return this.#continueDecodeSetLength.bind(this, length, typeMapping);
    }

    return this.#decodeSetItems(
      length,
      typeMapping,
      chunk
    );
  }

  #continueDecodeSetLength(lengthCb, typeMapping, chunk) {
    const length = lengthCb(chunk);
    return typeof length === 'function' ?
      this.#continueDecodeSetLength.bind(this, length, typeMapping) :
      this.#decodeSetItems(length, typeMapping, chunk);
  }

  #decodeSetItems(length, typeMapping, chunk) {
    return typeMapping[RESP_TYPES.SET] === Set ?
      this.#decodeSetAsSet(
        new Set(),
        length,
        typeMapping,
        chunk
      ) :
      this.#decodeArrayItems(
        new Array(length),
        0,
        typeMapping,
        chunk
      );
  }

  #decodeSetAsSet(set, remaining, typeMapping, chunk) {
    // using `remaining` instead of `length` & `set.size` to make it work even if the set contains duplicates
    while (remaining > 0) {
      if (this.#cursor >= chunk.length) {
        return this.#decodeSetAsSet.bind(
          this,
          set,
          remaining,
          typeMapping
        );
      }

      const item = this.#decodeNestedType(typeMapping, chunk);
      if (typeof item === 'function') {
        return this.#continueDecodeSetAsSet.bind(
          this,
          set,
          remaining,
          item,
          typeMapping
        );
      }

      set.add(item);
      --remaining;
    }

    return set;
  }

  #continueDecodeSetAsSet(set, remaining, itemCb, typeMapping, chunk) {
    const item = itemCb(chunk);
    if (typeof item === 'function') {
      return this.#continueDecodeSetAsSet.bind(
        this,
        set,
        remaining,
        item,
        typeMapping
      );
    }

    set.add(item);

    return this.#decodeSetAsSet(set, remaining - 1, typeMapping, chunk);
  }

  #decodeMap(typeMapping, chunk) {
    const length = this.#decodeUnsingedNumber(0, chunk);
    if (typeof length === 'function') {
      return this.#continueDecodeMapLength.bind(this, length, typeMapping);
    }

    return this.#decodeMapItems(
      length,
      typeMapping,
      chunk
    );
  }

  #continueDecodeMapLength(lengthCb, typeMapping, chunk) {
    const length = lengthCb(chunk);
    return typeof length === 'function' ?
      this.#continueDecodeMapLength.bind(this, length, typeMapping) :
      this.#decodeMapItems(length, typeMapping, chunk);
  }

  #decodeMapItems(length, typeMapping, chunk) {
    switch (typeMapping[RESP_TYPES.MAP]) {
      case Map:
        return this.#decodeMapAsMap(
          new Map(),
          length,
          typeMapping,
          chunk
        );

      case Array:
        return this.#decodeArrayItems(
          new Array(length * 2),
          0,
          typeMapping,
          chunk
        );

      default:
        return this.#decodeMapAsObject(
          Object.create(null),
          length,
          typeMapping,
          chunk
        );
    }
  }

  #decodeMapAsMap(map, remaining, typeMapping, chunk) {
    // using `remaining` instead of `length` & `map.size` to make it work even if the map contains duplicate keys
    while (remaining > 0) {
      if (this.#cursor >= chunk.length) {
        return this.#decodeMapAsMap.bind(
          this,
          map,
          remaining,
          typeMapping
        );
      }

      const key = this.#decodeMapKey(typeMapping, chunk);
      if (typeof key === 'function') {
        return this.#continueDecodeMapKey.bind(
          this,
          map,
          remaining,
          key,
          typeMapping
        );
      }

      if (this.#cursor >= chunk.length) {
        return this.#continueDecodeMapValue.bind(
          this,
          map,
          remaining,
          key,
          this.#decodeNestedType.bind(this, typeMapping),
          typeMapping
        );
      }

      const value = this.#decodeNestedType(typeMapping, chunk);
      if (typeof value === 'function') {
        return this.#continueDecodeMapValue.bind(
          this,
          map,
          remaining,
          key,
          value,
          typeMapping
        );
      }

      map.set(key, value);
      --remaining;
    }

    return map;
  }

  #decodeMapKey(typeMapping, chunk) {
    const type = chunk[this.#cursor];
    return ++this.#cursor === chunk.length ?
      this.#decodeMapKeyValue.bind(this, type, typeMapping) :
      this.#decodeMapKeyValue(type, typeMapping, chunk);
  }

  #decodeMapKeyValue(type, typeMapping, chunk) {
    switch (type) {
      // decode simple string map key as string (and not as buffer)
      case RESP_TYPES.SIMPLE_STRING:
        return this.#decodeSimpleString(String, chunk);

      // decode blob string map key as string (and not as buffer)
      case RESP_TYPES.BLOB_STRING:
        return this.#decodeBlobString(String, chunk);

      default:
        return this.#decodeNestedTypeValue(type, typeMapping, chunk);
    }
  }

  #continueDecodeMapKey(map, remaining, keyCb, typeMapping, chunk) {
    const key = keyCb(chunk);
    if (typeof key === 'function') {
      return this.#continueDecodeMapKey.bind(
        this,
        map,
        remaining,
        key,
        typeMapping
      );
    }

    if (this.#cursor >= chunk.length) {
      return this.#continueDecodeMapValue.bind(
        this,
        map,
        remaining,
        key,
        this.#decodeNestedType.bind(this, typeMapping),
        typeMapping
      );
    }

    const value = this.#decodeNestedType(typeMapping, chunk);
    if (typeof value === 'function') {
      return this.#continueDecodeMapValue.bind(
        this,
        map,
        remaining,
        key,
        value,
        typeMapping
      );
    }

    map.set(key, value);
    return this.#decodeMapAsMap(map, remaining - 1, typeMapping, chunk);
  }

  #continueDecodeMapValue(map, remaining, key, valueCb, typeMapping, chunk) {
    const value = valueCb(chunk);
    if (typeof value === 'function') {
      return this.#continueDecodeMapValue.bind(
        this,
        map,
        remaining,
        key,
        value,
        typeMapping
      );
    }

    map.set(key, value);

    return this.#decodeMapAsMap(map, remaining - 1, typeMapping, chunk);
  }

  #decodeMapAsObject(object, remaining, typeMapping, chunk) {
    while (remaining > 0) {
      if (this.#cursor >= chunk.length) {
        return this.#decodeMapAsObject.bind(
          this,
          object,
          remaining,
          typeMapping
        );
      }

      const key = this.#decodeMapKey(typeMapping, chunk);
      if (typeof key === 'function') {
        return this.#continueDecodeMapAsObjectKey.bind(
          this,
          object,
          remaining,
          key,
          typeMapping
        );
      }

      if (this.#cursor >= chunk.length) {
        return this.#continueDecodeMapAsObjectValue.bind(
          this,
          object,
          remaining,
          key,
          this.#decodeNestedType.bind(this, typeMapping),
          typeMapping
        );
      }

      const value = this.#decodeNestedType(typeMapping, chunk);
      if (typeof value === 'function') {
        return this.#continueDecodeMapAsObjectValue.bind(
          this,
          object,
          remaining,
          key,
          value,
          typeMapping
        );
      }

      object[key] = value;
      --remaining;
    }

    return object;
  }

  #continueDecodeMapAsObjectKey(object, remaining, keyCb, typeMapping, chunk) {
    const key = keyCb(chunk);
    if (typeof key === 'function') {
      return this.#continueDecodeMapAsObjectKey.bind(
        this,
        object,
        remaining,
        key,
        typeMapping
      );
    }

    if (this.#cursor >= chunk.length) {
      return this.#continueDecodeMapAsObjectValue.bind(
        this,
        object,
        remaining,
        key,
        this.#decodeNestedType.bind(this, typeMapping),
        typeMapping
      );
    }

    const value = this.#decodeNestedType(typeMapping, chunk);
    if (typeof value === 'function') {
      return this.#continueDecodeMapAsObjectValue.bind(
        this,
        object,
        remaining,
        key,
        value,
        typeMapping
      );
    }

    object[key] = value;

    return this.#decodeMapAsObject(object, remaining - 1, typeMapping, chunk);
  }

  #continueDecodeMapAsObjectValue(object, remaining, key, valueCb, typeMapping, chunk) {
    const value = valueCb(chunk);
    if (typeof value === 'function') {
      return this.#continueDecodeMapAsObjectValue.bind(
        this,
        object,
        remaining,
        key,
        value,
        typeMapping
      );
    }

    object[key] = value;

    return this.#decodeMapAsObject(object, remaining - 1, typeMapping, chunk);
  }

  #createRespNullNode() {
    return {
      type: RESP_TYPE_NAMES[RESP_TYPES.NULL],
      value: Buffer.alloc(0)
    };
  }

  #createRespNode(type, value) {
    return {
      type: RESP_TYPE_NAMES[type],
      value
    };
  }

  #decodeRespNull() {
    this.#decodeNull();
    return this.#createRespNullNode();
  }

  #wrapRespDecodedValue(type, value) {
    if (value === null) {
      return this.#createRespNullNode();
    }

    return this.#createRespNode(type, value);
  }

  #decodeRespWrappedValue(type, value) {
    return typeof value === 'function' ?
      this.#continueDecodeRespWrappedValue.bind(this, type, value) :
      this.#wrapRespDecodedValue(type, value);
  }

  #continueDecodeRespWrappedValue(type, valueCb, chunk) {
    const value = valueCb(chunk);
    return typeof value === 'function' ?
      this.#continueDecodeRespWrappedValue.bind(this, type, value) :
      this.#wrapRespDecodedValue(type, value);
  }

  #decodeRespTypeValue(type, chunk) {
    switch (type) {
      case RESP_TYPES.NULL:
        return this.#decodeRespNull();

      case RESP_TYPES.BOOLEAN:
      case RESP_TYPES.NUMBER:
      case RESP_TYPES.BIG_NUMBER:
      case RESP_TYPES.DOUBLE:
      case RESP_TYPES.SIMPLE_STRING:
      case RESP_TYPES.SIMPLE_ERROR:
        return this.#decodeRespWrappedValue(
          type,
          this.#decodeSimpleString(Buffer, chunk)
        );

      case RESP_TYPES.BLOB_STRING:
      case RESP_TYPES.BLOB_ERROR:
        return this.#decodeRespWrappedValue(
          type,
          this.#decodeBlobString(Buffer, chunk)
        );

      case RESP_TYPES.VERBATIM_STRING:
        return this.#decodeRespWrappedValue(
          type,
          this.#decodeVerbatimString(Buffer, chunk)
        );

      case RESP_TYPES.ARRAY:
        return this.#decodeRespArray(chunk);

      case RESP_TYPES.SET:
        return this.#decodeRespSet(chunk);

      case RESP_TYPES.MAP:
        return this.#decodeRespMap(chunk);

      default:
        throw new Error(`Unknown RESP type ${type} "${String.fromCharCode(type)}"`);
    }
  }

  #decodeNestedRespType(chunk) {
    const type = chunk[this.#cursor];
    return ++this.#cursor === chunk.length ?
      this.#decodeNestedRespTypeValue.bind(this, type) :
      this.#decodeNestedRespTypeValue(type, chunk);
  }

  #decodeNestedRespTypeValue(type, chunk) {
    switch (type) {
      case RESP_TYPES.NULL:
      case RESP_TYPES.BOOLEAN:
      case RESP_TYPES.NUMBER:
      case RESP_TYPES.BIG_NUMBER:
      case RESP_TYPES.DOUBLE:
      case RESP_TYPES.SIMPLE_STRING:
      case RESP_TYPES.BLOB_STRING:
      case RESP_TYPES.VERBATIM_STRING:
      case RESP_TYPES.SIMPLE_ERROR:
      case RESP_TYPES.BLOB_ERROR:
      case RESP_TYPES.ARRAY:
      case RESP_TYPES.SET:
      case RESP_TYPES.MAP:
        return this.#decodeRespTypeValue(type, chunk);

      default:
        throw new Error(`Unknown RESP type ${type} "${String.fromCharCode(type)}"`);
    }
  }

  #decodeRespArray(chunk) {
    // RESP2 null array
    if (chunk[this.#cursor] === ASCII['-']) {
      this.#cursor += 4; // skip -1\r\n
      return this.#createRespNullNode();
    }

    return this.#decodeRespArrayWithLength(
      this.#decodeUnsingedNumber(0, chunk),
      chunk
    );
  }

  #decodeRespArrayWithLength(length, chunk) {
    return typeof length === 'function' ?
      this.#continueDecodeRespArrayLength.bind(this, length) :
      this.#decodeRespArrayItems(
        new Array(length),
        0,
        chunk
      );
  }

  #continueDecodeRespArrayLength(lengthCb, chunk) {
    return this.#decodeRespArrayWithLength(
      lengthCb(chunk),
      chunk
    );
  }

  #decodeRespArrayItems(array, filled, chunk) {
    for (let i = filled; i < array.length; i++) {
      if (this.#cursor >= chunk.length) {
        return this.#decodeRespArrayItems.bind(
          this,
          array,
          i
        );
      }

      const item = this.#decodeNestedRespType(chunk);
      if (typeof item === 'function') {
        return this.#continueDecodeRespArrayItems.bind(
          this,
          array,
          i,
          item
        );
      }

      array[i] = item;
    }

    return array;
  }

  #continueDecodeRespArrayItems(array, filled, itemCb, chunk) {
    const item = itemCb(chunk);
    if (typeof item === 'function') {
      return this.#continueDecodeRespArrayItems.bind(
        this,
        array,
        filled,
        item
      );
    }

    array[filled++] = item;
    return this.#decodeRespArrayItems(array, filled, chunk);
  }

  #decodeRespSet(chunk) {
    const length = this.#decodeUnsingedNumber(0, chunk);
    if (typeof length === 'function') {
      return this.#continueDecodeRespSetLength.bind(this, length);
    }

    return this.#decodeRespArrayItems(
      new Array(length),
      0,
      chunk
    );
  }

  #continueDecodeRespSetLength(lengthCb, chunk) {
    const length = lengthCb(chunk);
    return typeof length === 'function' ?
      this.#continueDecodeRespSetLength.bind(this, length) :
      this.#decodeRespArrayItems(
        new Array(length),
        0,
        chunk
      );
  }

  #decodeRespMap(chunk) {
    const length = this.#decodeUnsingedNumber(0, chunk);
    if (typeof length === 'function') {
      return this.#continueDecodeRespMapLength.bind(this, length);
    }

    return this.#decodeRespMapItems(
      new Map(),
      length,
      chunk
    );
  }

  #continueDecodeRespMapLength(lengthCb, chunk) {
    const length = lengthCb(chunk);
    return typeof length === 'function' ?
      this.#continueDecodeRespMapLength.bind(this, length) :
      this.#decodeRespMapItems(
        new Map(),
        length,
        chunk
      );
  }

  #decodeRespMapItems(map, remaining, chunk) {
    while (remaining > 0) {
      if (this.#cursor >= chunk.length) {
        return this.#decodeRespMapItems.bind(
          this,
          map,
          remaining
        );
      }

      const key = this.#decodeNestedRespType(chunk);
      if (typeof key === 'function') {
        return this.#continueDecodeRespMapKey.bind(
          this,
          map,
          remaining,
          key
        );
      }

      if (this.#cursor >= chunk.length) {
        return this.#continueDecodeRespMapValue.bind(
          this,
          map,
          remaining,
          key,
          this.#decodeNestedRespType.bind(this)
        );
      }

      const value = this.#decodeNestedRespType(chunk);
      if (typeof value === 'function') {
        return this.#continueDecodeRespMapValue.bind(
          this,
          map,
          remaining,
          key,
          value
        );
      }

      map.set(key, value);
      --remaining;
    }

    return map;
  }

  #continueDecodeRespMapKey(map, remaining, keyCb, chunk) {
    const key = keyCb(chunk);
    if (typeof key === 'function') {
      return this.#continueDecodeRespMapKey.bind(
        this,
        map,
        remaining,
        key
      );
    }

    if (this.#cursor >= chunk.length) {
      return this.#continueDecodeRespMapValue.bind(
        this,
        map,
        remaining,
        key,
        this.#decodeNestedRespType.bind(this)
      );
    }

    const value = this.#decodeNestedRespType(chunk);
    if (typeof value === 'function') {
      return this.#continueDecodeRespMapValue.bind(
        this,
        map,
        remaining,
        key,
        value
      );
    }

    map.set(key, value);
    return this.#decodeRespMapItems(map, remaining - 1, chunk);
  }

  #continueDecodeRespMapValue(map, remaining, key, valueCb, chunk) {
    const value = valueCb(chunk);
    if (typeof value === 'function') {
      return this.#continueDecodeRespMapValue.bind(
        this,
        map,
        remaining,
        key,
        value
      );
    }

    map.set(key, value);
    return this.#decodeRespMapItems(map, remaining - 1, chunk);
  }
}
