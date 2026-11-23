export class InvalidConfigError extends Error {
  constructor(code, details = {}) {
    super(`Configuración inválida: ${code}`);
    this.name = 'InvalidConfigError';
    this.code = code;
    this.details = details;
  }
}

export class SpawnGenerationError extends Error {
  constructor(code, details = {}) {
    super(`Generación de spawns fallida: ${code}`);
    this.name = 'SpawnGenerationError';
    this.code = code;
    this.details = details;
  }
}

export function invariant(condition, message, details = {}) {
  if (!condition) throw new SpawnGenerationError('INVARIANT_VIOLATION', { message, ...details });
}
