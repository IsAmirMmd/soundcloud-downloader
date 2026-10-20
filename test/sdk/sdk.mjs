// A stand-in for `sdk` in local tests: `api` records every Bot API call
// instead of sending it, `fetch` refuses unless a test mocks it.
//
//   import { calls, take, mockApi, failNext } from './sdk/sdk.mjs';
//   take()                         → the calls since the last take(), [{ method, params }]
//   mockApi('getChatMemberCount', () => 12)   → what a method returns
//   failNext('sendMessage', 403, 'Forbidden: bot was blocked by the user')

export { db } from './db.mjs';

export class BotApiError extends Error {
  constructor(code, description, { method = null, parameters = {} } = {}) {
    super(description);
    this.name = 'BotApiError';
    Object.assign(this, { code, description, method, parameters });
  }
}

export class EndpointError extends Error {
  constructor(description, parameters = {}) {
    super(description);
    this.name = 'EndpointError';
    this.description = description;
    this.parameters = parameters;
  }
}

export class InputFile {
  constructor(data, name, { type } = {}) {
    Object.assign(this, { data, name, type });
  }
}

export const calls = [];
export const take = () => calls.splice(0);

const returns = new Map();
const failures = [];
let nextMessageId = 1000;

export const mockApi = (method, fn) => returns.set(method, fn);
export const failNext = (method, code, description, when = null) => failures.push({ method, code, description, when });

// Sensible defaults: send*/copyMessage return a message, getMe a bot.
const defaults = {
  getMe: () => ({ id: 1, is_bot: true, first_name: 'Test bot', username: 'test_bot' }),
};

export function resetApi() {
  calls.length = 0;
  failures.length = 0;
  returns.clear();
}

export const api = new Proxy({}, {
  get(_, method) {
    if (typeof method !== 'string' || method === 'then') return undefined;
    return async (params = {}) => {
      calls.push({ method, params });
      const i = failures.findIndex((f) => f.method === method && (!f.when || f.when(params)));
      if (i >= 0) {
        const [f] = failures.splice(i, 1);
        throw new BotApiError(f.code, f.description, { method });
      }
      if (returns.has(method)) return returns.get(method)(params);
      if (defaults[method]) return defaults[method](params);
      if (method.startsWith('send') || method === 'copyMessage') {
        return { message_id: nextMessageId++, chat: { id: params.chat_id }, date: Math.floor(Date.now() / 1000) };
      }
      return true;
    };
  },
});

let fetchImpl = async (url) => { throw new Error(`fetch(${url}) in a test: mock it with mockFetch()`); };
export const mockFetch = (fn) => { fetchImpl = fn; };
export const fetch = (...args) => fetchImpl(...args);
