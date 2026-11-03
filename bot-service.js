// Runs the exact same paper engine as the browser (kraken-bot.js) inside a Node
// sandbox, so the Kraken scanner and its paper account keep working when no
// dashboard is open. Nothing here can reach an exchange account: it only calls
// Kraken's public market-data endpoints and writes simulated fills to a JSON file.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const STATE_FILENAME = 'kraken-bot-state.json';

function createLocalStorage(stateFile, logger) {
  let data = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') logger.warn('Headless bot state could not be read; starting a fresh paper account:', error.message);
  }

  function flush() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
      const temporaryFile = `${stateFile}.tmp`;
      fs.writeFileSync(temporaryFile, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(temporaryFile, stateFile);
    } catch (error) {
      // Never let a disk problem take the engine down; the next cycle retries.
      logger.error('Headless bot state could not be saved:', error.message);
    }
  }

  return {
    getItem(key) {
      const name = String(key);
      return Object.prototype.hasOwnProperty.call(data, name) ? data[name] : null;
    },
    setItem(key, value) {
      data[String(key)] = String(value);
      flush();
    },
    removeItem(key) {
      delete data[String(key)];
      flush();
    },
    clear() {
      data = {};
      flush();
    },
  };
}

// Every timer the engine schedules is wrapped so a rejected cycle is logged
// instead of becoming an unhandled rejection that would stop the host.
function guardedScheduler(scheduler, logger) {
  return (callback, delay, ...rest) => {
    if (typeof callback !== 'function') return scheduler(callback, delay, ...rest);
    return scheduler((...args) => {
      try {
        const result = callback(...args);
        if (result && typeof result.then === 'function') {
          result.catch((error) => logger.error('Headless bot cycle failed:', error?.message || error));
        }
        return result;
      } catch (error) {
        logger.error('Headless bot cycle failed:', error?.message || error);
        return undefined;
      }
    }, delay, ...rest);
  };
}

function createSandbox({ localStorage, logger }) {
  const setIntervalGuarded = guardedScheduler(setInterval, logger);
  const setTimeoutGuarded = guardedScheduler(setTimeout, logger);
  const noop = () => {};

  const windowShim = {
    setInterval: setIntervalGuarded,
    clearInterval,
    setTimeout: setTimeoutGuarded,
    clearTimeout,
    addEventListener: noop,
    removeEventListener: noop,
    location: { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:' },
    navigator: { userAgent: 'northstar-headless-bot' },
    devicePixelRatio: 1,
  };

  return {
    window: windowShim,
    document: { visibilityState: 'visible', hidden: false, addEventListener: noop, removeEventListener: noop },
    localStorage,
    fetch: (...args) => fetch(...args),
    AbortController,
    AbortSignal,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    setInterval: setIntervalGuarded,
    clearInterval,
    setTimeout: setTimeoutGuarded,
    clearTimeout,
    performance,
    Intl,
    console: {
      log: (...args) => logger.log(...args),
      info: (...args) => logger.log(...args),
      warn: (...args) => logger.warn(...args),
      error: (...args) => logger.error(...args),
    },
  };
}

// Boots kraken-bot.js outside the browser. Returns the bot's public API.
function startHeadlessBot({ dataDir, sourcePath, logger = console }) {
  const stateFile = path.join(dataDir, STATE_FILENAME);
  const storage = createLocalStorage(stateFile, logger);
  const sandbox = createSandbox({ localStorage: storage, logger });
  const context = vm.createContext(sandbox, { name: 'northstar-kraken-bot' });
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });

  const api = sandbox.window.NorthstarKrakenBot;
  if (!api || typeof api.getSnapshot !== 'function') {
    throw new Error('kraken-bot.js did not expose a bot API inside the headless runtime.');
  }
  return { api, stateFile };
}

function headlessEnabled() {
  return String(process.env.NORTHSTAR_HEADLESS_BOT || 'on').toLowerCase() !== 'off';
}

module.exports = { startHeadlessBot, headlessEnabled, STATE_FILENAME };
