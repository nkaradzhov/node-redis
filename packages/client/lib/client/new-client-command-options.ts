import { CommandOptions } from './commands-queue';

const commandOptionsBrand = Symbol('new-client-command-options');

// Some commands accept trailing optional objects as regular command arguments
// (e.g. HSET object form), while command options are also trailing optional objects and
// have no required discriminator field.
// We add an internal brand and only treat branded objects as command options at runtime.
// Tradeoff: callers must wrap options with `makeOptions(...)`; a plain object is not treated
// as command options in ambiguous positions.
export type BrandedCommandOptions<O extends CommandOptions> =
  O & { readonly [commandOptionsBrand]: true };

export function makeOptions<O extends CommandOptions>(options: O): BrandedCommandOptions<O> {
  return Object.defineProperty(
    options,
    commandOptionsBrand,
    {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false
    }
  ) as BrandedCommandOptions<O>;
}

export function isCommandOptions(value: unknown): value is BrandedCommandOptions<CommandOptions> {
  return typeof value === 'object' &&
    value !== null &&
    (value as BrandedCommandOptions<CommandOptions>)[commandOptionsBrand] === true;
}
