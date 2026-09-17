/** Tiny leveled logger. Quiet by default so CLI JSON output stays clean. */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export function createLogger(level = 'info', sink = console.error) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, args) => {
    if ((LEVELS[lvl] ?? 99) <= threshold) sink(`[${lvl}]`, ...args);
  };
  return {
    level,
    error: (...a) => emit('error', a),
    warn: (...a) => emit('warn', a),
    info: (...a) => emit('info', a),
    debug: (...a) => emit('debug', a),
  };
}
