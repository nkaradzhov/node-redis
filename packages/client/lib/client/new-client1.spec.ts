import { strict as assert } from 'node:assert';
import testUtils, { GLOBAL } from '../test-utils';
import { makeOptions } from './new-client1';

describe('NewClient1', () => {
  testUtils.testWithClient('get defaults to idiomatic parse and supports parseMode option', async client => {
    const key = 'new-client1:get';
    await client.set(key, 'value');

    const defaultReply = await client.newClient1.get(key);
    assert.equal(defaultReply, 'value');

    const withCommandOptionsReply = await client.newClient1.get(
      key,
      makeOptions({ timeout: 1000 })
    );
    assert.equal(withCommandOptionsReply, 'value');

    const respReply = await client.newClient1.get(
      key,
      makeOptions({ parseMode: 'resp' })
    );
    assert.deepEqual(respReply, {
      type: 'BLOB_STRING',
      value: Buffer.from('value')
    });
  }, GLOBAL.SERVERS.OPEN);

  testUtils.testWithClient('set supports command options as explicit trailing argument', async client => {
    const key = 'new-client1:set';

    const defaultReply = await client.newClient1.set(key, 'value-1');
    assert.equal(defaultReply, 'OK');

    const withSetOptions = await client.newClient1.set(
      key,
      'value-2',
      { GET: true },
      makeOptions({ parseMode: 'resp' })
    );
    assert.deepEqual(withSetOptions, {
      type: 'BLOB_STRING',
      value: Buffer.from('value-1')
    });

    const rawReply = await client.newClient1.set(
      key,
      'value-3',
      undefined,
      makeOptions({ parseMode: 'raw' })
    );
    assert.deepEqual(rawReply, Buffer.from('+OK\r\n'));
  }, GLOBAL.SERVERS.OPEN);

  testUtils.testWithClient('hSet handles object shape and trailing command options without ambiguity', async client => {
    const key = 'new-client1:hset';

    const objectReply = await client.newClient1.hSet(key, {
      parseMode: 'field-value'
    });
    assert.equal(objectReply, 1);

    const stored = await client.hGet(key, 'parseMode');
    assert.equal(stored, 'field-value');

    const singleFieldReply = await client.newClient1.hSet(key, 'field-0', 'value-0');
    assert.equal(singleFieldReply, 1);

    const rawReply = await client.newClient1.hSet(
      key,
      'field-1',
      'value-1',
      makeOptions({ parseMode: 'raw' })
    );
    assert.deepEqual(rawReply, Buffer.from(':1\r\n'));

    const respReply = await client.newClient1.hSet(
      key,
      {
        'field-2': 'value-2'
      },
      makeOptions({ parseMode: 'resp' })
    );
    assert.deepEqual(respReply, {
      type: 'NUMBER',
      value: Buffer.from('1')
    });
  }, GLOBAL.SERVERS.OPEN);

  testUtils.testWithClient('clientInfo applies transform only in idiomatic mode', async client => {
    const defaultReply = await client.newClient1.clientInfo();
    assert.equal(typeof defaultReply.id, 'number');
    assert.equal(typeof defaultReply.fd, 'number');
    assert.equal(typeof defaultReply.addr, 'string');
    assert.equal(typeof defaultReply.cmd, 'string');

    const withCommandOptionsReply = await client.newClient1.clientInfo(
      makeOptions({ timeout: 1000 })
    );
    assert.equal(typeof withCommandOptionsReply.id, 'number');
    assert.equal(typeof withCommandOptionsReply.addr, 'string');

    const respReply = await client.newClient1.clientInfo(
      makeOptions({ parseMode: 'resp' })
    );
    if (Array.isArray(respReply) || respReply instanceof Map) {
      assert.fail('CLIENT INFO parseMode=resp should return a scalar RESP node');
    }
    assert.equal(
      respReply.type === 'VERBATIM_STRING' || respReply.type === 'BLOB_STRING',
      true
    );
    assert.equal(Buffer.isBuffer(respReply.value), true);
    assert.equal(respReply.value.includes(Buffer.from('id=')), true);

    const rawReply = await client.newClient1.clientInfo(
      makeOptions({ parseMode: 'raw' })
    );
    assert.equal(Buffer.isBuffer(rawReply), true);
    assert.equal(rawReply.includes(Buffer.from('id=')), true);
  }, GLOBAL.SERVERS.OPEN);
});
