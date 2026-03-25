import { strict as assert } from 'node:assert';
import testUtils, { GLOBAL } from '../test-utils';
import { makeOptions, rawParser, respParser } from './new-client2';

describe('NewClient2', () => {
  testUtils.testWithClient('get defaults to idiomatic parse and supports custom parser options', async client => {
    const key = 'new-client2:get';
    await client.set(key, 'value');

    const defaultReply = await client.newClient2.get(key);
    assert.equal(defaultReply, 'value');

    const parsedLength = await client.newClient2.get(
      key,
      makeOptions({ parser: reply => reply.length })
    );
    assert.equal(parsedLength, Buffer.from('$5\r\nvalue\r\n').length);

    const rawReply = await client.newClient2.get(
      key,
      makeOptions({ parser: rawParser })
    );
    assert.deepEqual(rawReply, Buffer.from('$5\r\nvalue\r\n'));

    const respReply = await client.newClient2.get(
      key,
      makeOptions({ parser: respParser })
    );
    if (Array.isArray(respReply) || respReply instanceof Map) {
      assert.fail('GET parser=respParser should return a scalar RESP node');
    }
    assert.deepEqual(respReply, {
      type: 'BLOB_STRING',
      value: Buffer.from('value')
    });
  }, GLOBAL.SERVERS.OPEN);

  testUtils.testWithClient('set supports command options as explicit trailing argument with parser', async client => {
    const key = 'new-client2:set';

    const defaultReply = await client.newClient2.set(key, 'value-1');
    assert.equal(defaultReply, 'OK');

    const withRawParser = await client.newClient2.set(
      key,
      'value-2',
      { GET: true },
      makeOptions({ parser: rawParser })
    );
    assert.deepEqual(withRawParser, Buffer.from('$7\r\nvalue-1\r\n'));

    const withRespParser = await client.newClient2.set(
      key,
      'value-3',
      { GET: true },
      makeOptions({ parser: respParser })
    );
    if (Array.isArray(withRespParser) || withRespParser instanceof Map) {
      assert.fail('SET GET parser=respParser should return a scalar RESP node');
    }
    assert.deepEqual(withRespParser, {
      type: 'BLOB_STRING',
      value: Buffer.from('value-2')
    });
  }, GLOBAL.SERVERS.OPEN);

  testUtils.testWithClient('hSet handles object shape and trailing parser options without ambiguity', async client => {
    const key = 'new-client2:hset';

    const objectReply = await client.newClient2.hSet(key, {
      parseMode: 'field-value'
    });
    assert.equal(objectReply, 1);

    const stored = await client.hGet(key, 'parseMode');
    assert.equal(stored, 'field-value');

    const rawReply = await client.newClient2.hSet(
      key,
      'field-1',
      'value-1',
      makeOptions({ parser: rawParser })
    );
    assert.deepEqual(rawReply, Buffer.from(':1\r\n'));

    const respReply = await client.newClient2.hSet(
      key,
      {
        'field-2': 'value-2'
      },
      makeOptions({ parser: respParser })
    );
    if (Array.isArray(respReply) || respReply instanceof Map) {
      assert.fail('HSET parser=respParser should return a scalar RESP node');
    }
    assert.deepEqual(respReply, {
      type: 'NUMBER',
      value: Buffer.from('1')
    });
  }, GLOBAL.SERVERS.OPEN);

  testUtils.testWithClient('clientInfo applies transform by default and parser when provided', async client => {
    const defaultReply = await client.newClient2.clientInfo();
    assert.equal(typeof defaultReply.id, 'number');
    assert.equal(typeof defaultReply.fd, 'number');
    assert.equal(typeof defaultReply.addr, 'string');
    assert.equal(typeof defaultReply.cmd, 'string');

    const customParserReply = await client.newClient2.clientInfo(
      makeOptions({ parser: reply => reply.includes(Buffer.from('id=')) })
    );
    assert.equal(customParserReply, true);

    const rawReply = await client.newClient2.clientInfo(
      makeOptions({ parser: rawParser })
    );
    assert.equal(Buffer.isBuffer(rawReply), true);
    assert.equal(rawReply.includes(Buffer.from('id=')), true);

    const respReply = await client.newClient2.clientInfo(
      makeOptions({ parser: respParser })
    );
    if (Array.isArray(respReply) || respReply instanceof Map) {
      assert.fail('CLIENT INFO parser=respParser should return a scalar RESP node');
    }
    assert.equal(
      respReply.type === 'VERBATIM_STRING' || respReply.type === 'BLOB_STRING',
      true
    );
    assert.equal(Buffer.isBuffer(respReply.value), true);
    assert.equal(respReply.value.includes(Buffer.from('id=')), true);
  }, GLOBAL.SERVERS.OPEN);
});
