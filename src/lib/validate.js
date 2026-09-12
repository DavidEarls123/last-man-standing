import { z } from 'zod';
import { badRequest } from './errors.js';

export const emailSchema = z.string().trim().toLowerCase().email().max(200);

/** Accepts UK-style and international input, stores E.164. */
export const phoneSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s()-]/g, ''))
  .refine((value) => /^\+?\d{7,15}$/.test(value), 'Enter a valid phone number')
  .transform((value) => {
    if (value.startsWith('+')) return value;
    if (value.startsWith('0')) return `+44${value.slice(1)}`;
    return `+${value}`;
  });

export function parse(schema, payload) {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(body)',
      message: issue.message,
    }));
    throw badRequest(details[0] ? `${details[0].field}: ${details[0].message}` : 'Invalid request', details);
  }
  return result.data;
}

/** Wraps an async route handler so rejections reach the error middleware. */
export const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
