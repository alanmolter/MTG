/**
 * parseArgs.ts — Utilitário para parsear argumentos CLI no formato --key=value
 *
 * Uso:
 *   npx tsx script.ts --pool-offset=2000 --mutation-rate=0.35 --exploration-mode=true
 *
 * Retorna um Record<string, string> com os pares key→value.
 * Suporta tanto --key=value quanto --key value (espaço separado).
 */

export function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');

      if (eqIdx !== -1) {
        // Formato: --key=value
        const key   = arg.slice(2, eqIdx);
        const value = arg.slice(eqIdx + 1);
        result[key] = value;
      } else {
        // Formato: --key value (próximo arg é o valor)
        const key = arg.slice(2);
        const nextArg = argv[i + 1];

        if (nextArg && !nextArg.startsWith('--')) {
          result[key] = nextArg;
          i++; // pular o próximo arg
        } else {
          // Flag booleana sem valor: --exploration-mode → { 'exploration-mode': 'true' }
          result[key] = 'true';
        }
      }
    }
  }

  return result;
}

// Helpers de conversão tipada
export function getInt(args: Record<string, string>, key: string, defaultValue: number): number {
  const val = parseInt(args[key]);
  return isNaN(val) ? defaultValue : val;
}

export function getFloat(args: Record<string, string>, key: string, defaultValue: number): number {
  const val = parseFloat(args[key]);
  return isNaN(val) ? defaultValue : val;
}

export function getBool(args: Record<string, string>, key: string, defaultValue = false): boolean {
  if (!(key in args)) return defaultValue;
  return args[key] === 'true' || args[key] === '1';
}

export function getString(args: Record<string, string>, key: string, defaultValue: string): string {
  return args[key] ?? defaultValue;
}
