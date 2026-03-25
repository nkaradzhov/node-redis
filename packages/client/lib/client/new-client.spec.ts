import { strict as assert } from 'node:assert';
import testUtils, { GLOBAL } from '../test-utils';
import { RespReply } from './new-client';

describe('NewClient', () => {
  testUtils.testWithClient('get/getRaw/getResp over a real client', async client => {
    const key = 'foo';
    await client.set(key, 'value');

    const command = client.newClient.get(key);

    const getResponse = await command.get();
    console.log('.get() -> ', getResponse);
    assert.equal(getResponse, 'value');

    const rawResponse = await command.getRaw();
    console.log('.getRaw() -> ', rawResponse, '.toString() -> ', stringify(rawResponse));
    assert.deepEqual(rawResponse, Buffer.from('$5\r\nvalue\r\n'));

    const respResponse = await command.getResp();
    console.log('.respResponse() -> ', respResponse, '.toString() -> ', stringify(respResponse));
    assert.deepEqual(respResponse, {
      type: 'BLOB_STRING',
      value: Buffer.from('value')
    });
  }, GLOBAL.SERVERS.OPEN);
});

const stringify = (value: RespReply | Buffer): unknown => {
  if (value instanceof Buffer) {
    return value.toString().replace(/\r\n|\r|\n/g, ' ')
  } else if (Array.isArray(value)) {
    return value.map(stringify);
  } else if (value instanceof Map) {
    return Array.from(value.entries(), ([key, mapValue]) => ({
      key: stringify(key),
      value: stringify(mapValue)
    }));
  } else {
    return {
      type: value.type,
      value: value.value.toString().replace(/\r\n|\r|\n/g, ' ')
    };
  }
};
