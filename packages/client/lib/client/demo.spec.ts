import { strict as assert } from 'node:assert';
import { RESP_TYPES } from '../RESP/decoder';
import testUtils, { GLOBAL } from '../test-utils';
import { RespReply } from './new-client';
import { makeOptions as makeParseModeOptions } from './new-client1';
import { makeOptions as makeParserOptions, rawParser, respParser } from './new-client2';

describe('Demo', () => {
  testUtils.testWithClient('GET', async client => {
    const key = 'foo';
    await client.set(key, 'bar');

    console.log('\r\n--- Existing Client ---\r\n');
    const existingDefault = await client.get(key);
    const existingMappedClient = client.withTypeMapping({
      [RESP_TYPES.BLOB_STRING]: Buffer
    });
    const existingMapped = await existingMappedClient.get(key);

    console.log('Default: ', existingDefault);
    console.log('string->Buffer:', existingMapped);

    // assert.equal(existingDefault, 'bar');
    // assert.deepEqual(existingMapped, Buffer.from('bar'));

    console.log('\r\n--- .result() Client ---\r\n');
    const resultClient = client.newClient;
    const resultCommand = resultClient.get(key);
    const resultDefault = await resultCommand.get();
    const resultRaw = await resultCommand.getRaw();
    const resultResp = await resultCommand.getResp();

    console.log('Default: ', resultDefault);
    console.log('Raw:', resultRaw);
    console.log('RESP:', resultResp);

    // assert.equal(resultDefault, 'bar');
    // assert.deepEqual(resultRaw, Buffer.from('$3\r\nbar\r\n'));
    // assert.deepEqual(resultResp, {
    //   type: 'BLOB_STRING',
    //   value: Buffer.from('bar')
    // });

    console.log('\r\n--- parseMode Client ---\r\n');
    const parseModeClient = client.newClient1;
    const parseModeDefault = await parseModeClient.get(key);
    const parseModeRaw = await parseModeClient.get(
      key,
      makeParseModeOptions({ parseMode: 'raw' })
    );
    const parseModeResp = await parseModeClient.get(
      key,
      makeParseModeOptions({ parseMode: 'resp' })
    );

    console.log('Default: ', parseModeDefault);
    console.log('Raw:', parseModeRaw);
    console.log('RESP', parseModeResp);

    // assert.equal(parseModeDefault, 'bar');
    // assert.deepEqual(parseModeRaw, Buffer.from('$3\r\nbar\r\n'));
    // assert.deepEqual(parseModeResp, {
    //   type: 'BLOB_STRING',
    //   value: Buffer.from('bar')
    // });

    console.log('\r\n--- parser Client ---\r\n');
    const parserClient = client.newClient2;
    const parserDefault = await parserClient.get(key);
    const parserRaw = await parserClient.get(
      key,
      makeParserOptions({ parser: rawParser })
    );
    const parserResp = await parserClient.get(
      key,
      makeParserOptions({ parser: respParser })
    );
    const parserLength = await parserClient.get(
      key,
      makeParserOptions({ parser: reply => reply.length })
    );

    console.log('Default: ', parserDefault);
    console.log('Raw:', parserRaw);
    console.log('RESP', parserResp);
    console.log('Custom', parserLength);

    // assert.equal(parserDefault, 'bar');
    // assert.deepEqual(parserRaw, Buffer.from('$3\r\nbar\r\n'));
    // assert.deepEqual(parserResp, {
    //   type: 'BLOB_STRING',
    //   value: Buffer.from('bar')
    // });
    // assert.equal(parserLength, Buffer.from('$3\r\nbar\r\n').length);
  }, GLOBAL.SERVERS.OPEN);
});
