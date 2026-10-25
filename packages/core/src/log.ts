// journald сам ставит время, поэтому только префикс сервиса
export function logger(service: string) {
  return {
    info: (...a: unknown[]) => console.log(`[${service}]`, ...a),
    warn: (...a: unknown[]) => console.warn(`[${service}]`, ...a),
    error: (...a: unknown[]) => console.error(`[${service}]`, ...a),
  };
}
