import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

// Google's documented reCAPTCHA v2 test keys: the widget shows a warning and every verification passes.
export const TEST_SITE_KEY = '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI';
export const TEST_SECRET_KEY = '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe';

export const PASS_COOKIE = 'shop_pass';
export const PASS_TTL_SECONDS = 10 * 60;

const SITEVERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';
const SITEVERIFY_TIMEOUT_MS = 10_000;
const siteverifySchema = z.object({ success: z.boolean() });

function getSignature(expiresAtMs: number, cookieSecret: string): string {
  return createHmac('sha256', cookieSecret).update(String(expiresAtMs)).digest('base64url');
}

/** Creates the `shop_pass` cookie value: its expiry time and an HMAC of it. */
export function createPassValue(cookieSecret: string, now: Date): string {
  const expiresAtMs = now.getTime() + PASS_TTL_SECONDS * 1000;
  return `${expiresAtMs}.${getSignature(expiresAtMs, cookieSecret)}`;
}

export function isPassValid(value: string | undefined, cookieSecret: string, now: Date): boolean {
  const [expiresAt, signature] = value?.split('.') ?? [];
  const expiresAtMs = Number(expiresAt);
  if (!signature || !Number.isInteger(expiresAtMs) || expiresAtMs <= now.getTime()) {
    return false;
  }
  const expected = Buffer.from(getSignature(expiresAtMs, cookieSecret));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Asks Google's siteverify whether a reCAPTCHA token is valid. Any failure counts as not valid. */
export async function verifyRecaptchaToken(secretKey: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      body: new URLSearchParams({ secret: secretKey, response: token }),
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
    const parsed = siteverifySchema.safeParse(await response.json());
    return parsed.success && parsed.data.success;
  } catch (error) {
    console.error(`reCAPTCHA siteverify failed: ${String(error)}`);
    return false;
  }
}
