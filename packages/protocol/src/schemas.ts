/** Wire validation, used in dev builds only (the import is dead-code-eliminated in production). */
import { z } from 'zod';

const id = z.number().int().positive();
export const wireMessage = z.union([
  z.object({ kind: z.literal('req'), id, method: z.string().min(1), params: z.unknown() }),
  z.object({ kind: z.literal('res'), id, ok: z.literal(true), result: z.unknown() }),
  z.object({ kind: z.literal('res'), id, ok: z.literal(false), error: z.object({ message: z.string(), code: z.string().optional() }) }),
  z.object({ kind: z.literal('part'), id, data: z.unknown() }),
  z.object({ kind: z.literal('cancel'), id }),
  z.object({ kind: z.literal('push'), event: z.string().min(1), data: z.unknown() }),
]);

export function validateWire(msg: unknown): void {
  const r = wireMessage.safeParse(msg);
  if (!r.success) throw new Error(`Invalid wire message: ${r.error.message}`);
}
