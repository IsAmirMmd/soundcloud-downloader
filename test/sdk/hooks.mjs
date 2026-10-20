// Module resolve hook: `sdk` and `sdk/db` resolve to the local stand-ins.
const MAP = {
  sdk: new URL('./sdk.mjs', import.meta.url).href,
  'sdk/db': new URL('./db.mjs', import.meta.url).href,
  'sdk/api': new URL('./sdk.mjs', import.meta.url).href,
  'sdk/fetch': new URL('./sdk.mjs', import.meta.url).href,
};

export async function resolve(specifier, context, next) {
  return MAP[specifier] ? { url: MAP[specifier], shortCircuit: true } : next(specifier, context);
}
