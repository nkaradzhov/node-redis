// EXAMPLE: set_and_get
// REMOVE_START
import assert from "node:assert";
// REMOVE_END

// HIDE_START
import { createClient } from 'redis';

const client = createClient();

client.on('error', err => console.log('Redis Client Error', err));

await client.connect().catch(console.error);

// HIDE_END
await client.set('bike:1', 'Process 134');
const value = await client.get('bike:1');
console.log(value);
// returns 'Process 134'
//REMOVE_START
assert.equal(value, 'Process 134');
await client.del('bike:1');
//REMOVE_END

// HIDE_START
await client.close();
// HIDE_END
