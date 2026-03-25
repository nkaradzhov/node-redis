# Multi Compatibility: NewClient vs NewClient1 vs NewClient2

Great question. Short answer: with the current multi engine, all 3 candidates behave very differently, and none of them can be dropped in for `MULTI/EXEC` without extra design work.

## Current Multi Baseline

- Runtime today:
  - `multi()` queues commands with `args + transformReply` and applies transforms after execution in [`multi-command.ts`](/Users/nikolay.karadzhov/Projects/clients/node-redis/command-refactor/packages/client/lib/multi-command.ts#L20).
  - Transaction execution is `MULTI ... EXEC`, and real command replies come back only inside the single `EXEC` reply in [`index.ts`](/Users/nikolay.karadzhov/Projects/clients/node-redis/command-refactor/packages/client/lib/client/index.ts#L1320).
- Type level today:
  - `execTyped()` tuple types are built from command metadata (`transformReply` return type + `TYPE_MAPPING`) in [`client/multi-command.ts`](/Users/nikolay.karadzhov/Projects/clients/node-redis/command-refactor/packages/client/lib/client/multi-command.ts#L8).

## How the 3 candidates map to Multi

1. `NewClient` (`get()/getRaw()/getResp()` object style)

- Runtime:
  - Poor fit for fluent `multi().get().set().execTyped()` because mode is chosen after command call.
  - Works only with a major API redesign (or global mode per `exec`, not per command).
- Type level:
  - Hard to preserve per-command tuple inference in chain form.

2. `NewClient1` (`parseMode` parameter per command)

- Runtime:
  - Works naturally for pipeline-like per-command replies.
  - Problematic for true `MULTI/EXEC`: per-command parse mode cannot be applied directly, because sub-replies are nested inside one `EXEC` payload.
  - `raw` per sub-command is especially hard without decoder support for nested raw slices.
- Type level:
  - Can express tuple entries (`raw` -> `Buffer`, `resp` -> `RespReply`, default -> idiomatic), but runtime for transaction mode can become unsound unless constrained.

3. `NewClient2` (`parser: (Buffer) => T`)

- Runtime:
  - Best fit for standalone commands and pipelines.
  - Same transaction limitation as `NewClient1`, but stricter: parser expects per-command raw bytes, which `EXEC` does not expose per element.
- Type level:
  - Strongest inference potential (`parser` gives exact `T` per tuple slot), but only sound if runtime can actually provide per-command parser input.

## Bottom line

- For `execAsPipeline()`, `NewClient1` and `NewClient2` are workable.
- For `MULTI/EXEC`, none of the 3 is a clean replacement as-is.
- To replace type-mapping for transaction multi, you need explicit multi-specific semantics (for example: parser on whole `EXEC`, or restrict per-command parser/parseMode in transactions, or extend decoder to expose nested raw replies).
