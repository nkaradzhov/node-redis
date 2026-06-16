import { strict as assert } from 'node:assert';
import { BasicCommandParser } from './parser';

describe('BasicCommandParser', () => {
  describe('markRoutingKey', () => {
    it('sets firstKey without appending to redisArgs', () => {
      const parser = new BasicCommandParser();
      parser.push('MGET', 'k1', 'k2');
      parser.markRoutingKey('k1');

      // redisArgs stays an exact copy of what was pushed (the wire command).
      assert.deepEqual(parser.redisArgs, ['MGET', 'k1', 'k2']);
      // ...but the key is registered for routing.
      assert.deepEqual(parser.keys, ['k1']);
      assert.equal(parser.firstKey, 'k1');
    });

    it('leaves keys empty when never called (keyless raw command)', () => {
      const parser = new BasicCommandParser();
      parser.push('PING');

      assert.deepEqual(parser.redisArgs, ['PING']);
      assert.deepEqual(parser.keys, []);
      assert.equal(parser.firstKey, undefined);
    });

    it('keeps commandIdentifier pointing at the command name', () => {
      const parser = new BasicCommandParser();
      parser.push('GET', 'k1');
      parser.markRoutingKey('k1');

      assert.deepEqual(parser.commandIdentifier, { command: 'GET', subcommand: 'k1' });
    });
  });
});
