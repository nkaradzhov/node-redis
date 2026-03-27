# Type Mapping Today and the 3 Prototype Alternatives

This note summarizes where we are with type mapping in the current client, what costs it introduces, and what we learned from the three prototype clients.

## How type mapping works today

At a high level, current behavior is:

1. The RESP decoder parses replies in `idiomatic` mode.
2. A command-specific `transformReply` then shapes the final JS value.
3. `typeMapping` is threaded into those transforms to choose JS representations.

So we have two layers:

- Decoder-level mapping (RESP type to runtime value shape).
- Command-level transforms (command-specific post-processing).

### Example 1: Blob strings as `Buffer`

This is the common binary-safe case:

```ts
const binaryClient = client.withTypeMapping({
  [RESP_TYPES.BLOB_STRING]: Buffer
});

await binaryClient.set("k", Buffer.from("value"));
const raw = await binaryClient.get("k"); // Buffer
```

This works well and is one of the strongest parts of the current model.

### Example 2: Map replies as object vs `Map` vs flat array

For tuple-like replies (for example `HGETALL`-style transforms), `RESP_TYPES.MAP` can drive container shape:

```ts
const asMap = client.withTypeMapping({
  [RESP_TYPES.MAP]: Map
});

const hash = await asMap.hGetAll("user:1"); // Map-like shape
```

The same reply can be emitted as object or array depending on mapping, which is flexible for consumers.

### Example 3 (more complex): `multi().execTyped()` combines command metadata + type mapping

In typed transactions, tuple inference is built from command metadata and then adjusted via `ReplyWithTypeMapping`:

```ts
const tx = client
  .withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer })
  .multi()
  .get("k1")
  .hGetAll("h1");

const replies = await tx.execTyped();
// tuple element types come from command transformReply + type mapping
```

This is powerful, but it also means our type system has to compose deep command types, transaction tuple types, and mapped reply types at once.

## Costs and limits of the current model

### Maintenance cost

Type mapping logic is distributed across many command transforms, not centralized in one layer. That leads to drift and local exceptions:

- Some module transforms still contain TODOs to honor mapping more fully.
- Some paths manually coerce values (`Number(value)`) instead of consistently deferring to mapping rules.
- Transform signatures are broad (`TransformReply = ... => any`), which makes type-level guarantees harder to enforce across commands.

Net effect: adding or changing behavior often requires touching command-specific code and re-validating many edge paths.

### Compilation/type-checking cost

`ReplyWithTypeMapping` is recursive and is applied through large generic surfaces, especially in typed multi:

- Per-command signatures feed tuple accumulation in `RedisClientMultiCommand`.
- `execTyped()` returns tuples that encode command transforms and mapping selections.
- Long fluent chains amplify type instantiation depth.

Even when runtime behavior is correct, this style puts pressure on TypeScript compile time and editor responsiveness.

### Flexibility limits and corner cases

Current mapping is useful but not fully orthogonal:

- Map keys and Set members can be decoded as `string` for lookup ergonomics, which can ignore expected blob-string mapping in those positions.
- `sendCommand()` inside multi breaks typed tuple inference.
- Mapping is mostly coarse-grained by RESP type, not by field-level intent within complex command replies.
- Command APIs that already accept trailing objects can become ambiguous when command options are also trailing objects (prototypes had to add `makeOptions(...)` branding to disambiguate at runtime).

## The 3 prototype alternatives

### 1) `NewClient` (`newClient.get(...).get()/getRaw()/getResp()`)

Shape:

```ts
const command = client.newClient.get("k");
await command.get();     // idiomatic
await command.getRaw();  // Buffer
await command.getResp(); // RESP node
```

Pros:

- Very explicit call-site semantics.
- Easy to understand per-invocation output mode.
- Good for debugging and protocol-level inspection.

Cons:

- Awkward for fluent chaining ergonomics.
- Mode is chosen after the command object is built, which does not fit existing multi chain semantics.
- Harder to preserve strong per-command tuple inference in transaction chains.

### 2) `NewClient1` (per-command `parseMode`)

Shape:

```ts
await client.newClient1.get("k", makeOptions({ parseMode: "resp" }));
await client.newClient1.set("k", "v", undefined, makeOptions({ parseMode: "raw" }));
```

Pros:

- Familiar command API with a clear, per-command override.
- Integrates naturally with direct command execution.
- Keeps idiomatic transform as default while allowing raw/RESP escape hatches.

Cons:

- Requires disambiguation helpers (`makeOptions`) for commands with trailing object args.
- For transactions, per-command mode selection is not directly compatible with `EXEC` nesting.
- `raw` on sub-replies is not available without deeper decoder/runtime support.

### 3) `NewClient2` (per-command custom parser)

Shape:

```ts
await client.newClient2.get("k", makeOptions({ parser: raw => raw.length }));
await client.newClient2.get("k", makeOptions({ parser: rawParser }));
await client.newClient2.get("k", makeOptions({ parser: respParser }));
```

Pros:

- Most flexible and expressive.
- Strong inference potential (`parser: (Buffer) => T` yields exact `T`).
- Lets callers build domain-specific parsing once and reuse it.

Cons:

- Same trailing-options ambiguity issue as `NewClient1` (hence branding helper).
- Requires raw reply bytes when parser is used; that is straightforward for standalone commands but problematic in `MULTI/EXEC`.
- Soundness depends on runtime actually being able to provide parser input in every execution mode.

## Open state: `multi` compatibility across all 3

This is still the central unresolved area.

- `execAsPipeline()` is comparatively workable for `NewClient1` and `NewClient2`.
- True `MULTI/EXEC` is harder because command replies are nested inside one `EXEC` payload.
- None of the three alternatives is a drop-in transaction replacement as-is.

To make any of them production-ready for transactions, we still need explicit multi semantics, for example:

- parser/parse mode at whole-`EXEC` level,
- restrictions on per-command parsing inside transaction mode,
- or decoder/runtime support that can expose nested raw slices safely.

Until that is decided, multi behavior remains open for all three variants.

## Reference pointers

- Current mapping model and recursive types: `packages/client/lib/RESP/types.ts`
- Multi typed tuple composition: `packages/client/lib/client/multi-command.ts`
- Runtime multi transform path: `packages/client/lib/multi-command.ts`
- Transaction behavior docs: `docs/transactions.md`
- RESP mapping behavior and caveats: `docs/RESP.md`
- Prototype implementation (`NewClient`): `packages/client/lib/client/new-client.ts`
- Prototype implementation (`NewClient1`): `packages/client/lib/client/new-client1.ts`
- Prototype implementation (`NewClient2`): `packages/client/lib/client/new-client2.ts`
- Existing multi compatibility note: `MULTI_NEW_CLIENT_COMPARISON.md`
