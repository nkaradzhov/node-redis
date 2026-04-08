import { strict as assert } from 'node:assert';
import testUtils, { GLOBAL } from '../test-utils';

describe('NewClient1', () => {
  testUtils.testWithClient('get defaults to idiomatic parse and supports parseMode option', async client => {
    const key = 'new-client1:get';
    await client.set(key, 'value');

    const defaultReply = await client.newClient1.get(key);
    assert.equal(defaultReply, 'value');

    const withCommandOptionsReply = await client.newClient1.get(key, { timeout: 1000 });
    assert.equal(withCommandOptionsReply, 'value');

    const respReply = await client.newClient1.get(key, { parseMode: 'resp' });
    assert.deepEqual(respReply, {
      type: 'BLOB_STRING',
      value: Buffer.from('value')
    });
  }, GLOBAL.SERVERS.OPEN);
});
