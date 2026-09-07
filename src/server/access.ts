import type { NextFunction, Response } from 'express';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { getProjectOwner } from '../state/ownership.js';
import type { AuthedRequest } from './auth.js';

export function localMode(): boolean {
  return process.env.AUTH_MODE === 'disabled' && process.env.NODE_ENV !== 'production';
}

export async function canAccessProject(userId: string, projectId: string): Promise<boolean> {
  const owner = await getProjectOwner(projectId);
  return owner === userId || (localMode() && owner === undefined);
}

export async function projectAccess(req: AuthedRequest, res: Response, next: NextFunction) {
  const id = req.params.projectId;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) {
    res.status(400).json({ error: 'Identifiant invalide.' }); return;
  }
  if (!req.user || !await canAccessProject(req.user.id, id)) {
    res.status(404).json({ error: 'Projet introuvable.' }); return;
  }
  next();
}

export async function withinDirectory(root: string, file: string): Promise<string> {
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
  const rel = relative(realRoot, realFile);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Path outside project');
  return realFile;
}

export function checkOrigin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!localMode() && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') !== process.env.APP_ORIGIN) {
    res.status(403).json({ error: 'Origine de la requête refusée.' }); return;
  }
  next();
}
