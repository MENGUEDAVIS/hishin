import { verify } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { touchUser } from '../state/ownership.js';

/**
 * Verifies the JWT the Application Load Balancer attaches to every request
 * after a successful Cognito login (the listener's `authenticate-cognito`
 * action, configured in infra/, runs before any request reaches this
 * container). This is defense in depth, not the primary gate: the ALB
 * already refuses to forward an unauthenticated request, but the app must
 * never blindly trust a header it has not verified itself — a
 * misconfigured security group or a direct task IP would otherwise bypass
 * auth entirely.
 *
 * Verification follows AWS's documented steps: read the `kid` from the
 * token header, fetch the corresponding public key from the regional
 * ALB endpoint (cached — the same key is reused across requests), then
 * verify the ES256 signature.
 *
 * Local development has no ALB in front, so AUTH_MODE=disabled runs every
 * request as a fixed local user instead.
 */

export interface AuthedRequest extends Request {
  user?: { id: string; email?: string };
}

const region = process.env.AWS_REGION || 'us-east-1';
const keyCache = new Map<string, string>();

async function fetchAlbPublicKey(kid: string): Promise<string> {
  const cached = keyCache.get(kid);
  if (cached) return cached;
  const response = await fetch(`https://public-keys.auth.elb.${region}.amazonaws.com/${kid}`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    throw new Error(`Failed to fetch ALB public key for kid ${kid}: HTTP ${response.status}`);
  }
  const pem = await response.text();
  if (keyCache.size > 20) keyCache.clear();
  keyCache.set(kid, pem);
  return pem;
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  if (process.env.AUTH_MODE === 'disabled' && process.env.NODE_ENV !== 'production') {
    req.user = { id: 'local-dev', email: 'local-dev@example.com' };
    next();
    return;
  }

  const token = req.header('x-amzn-oidc-data');
  if (!token) {
    res.status(401).json({ error: 'Missing authentication data. This app must be accessed through the load balancer.' });
    return;
  }

  try {
    const [headerB64] = token.split('.');
    if (!headerB64) throw new Error('malformed token');
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as {
      kid?: string;
      alg?: string; signer?: string; client?: string; exp?: number;
    };
    if (!header.kid || !/^[a-zA-Z0-9-]{1,128}$/.test(header.kid)) throw new Error('invalid kid');
    if (header.alg !== 'ES256' || !process.env.ALB_ARN || header.signer !== process.env.ALB_ARN) throw new Error('invalid signer');
    if (!process.env.COGNITO_CLIENT_ID || header.client !== process.env.COGNITO_CLIENT_ID) throw new Error('invalid client');
    if (typeof header.exp !== 'number' || header.exp <= Date.now() / 1000) throw new Error('expired token');

    const publicKey = await fetchAlbPublicKey(header.kid);
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('malformed token');
    const [encodedHeader, encodedPayload, signature] = parts as [string, string, string];
    if (!verify('sha256', Buffer.from(`${encodedHeader}.${encodedPayload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))) throw new Error('invalid signature');
    // ALB tokens may contain base64url padding; verify the original signing input.
    const claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as { sub?: string; email?: string };

    const id = claims.sub;
    if (!id || typeof id !== 'string') throw new Error('token is missing sub claim');
    const email = typeof claims.email === 'string' ? claims.email : undefined;

    req.user = email ? { id, email } : { id };
    await touchUser(req.user);
    next();
  } catch (error) {
    res.status(401).json({
      error: 'Session invalide ou expirée. Reconnectez-vous.',
    });
  }
}
