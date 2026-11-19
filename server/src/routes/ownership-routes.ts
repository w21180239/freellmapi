import type { Request, Response, Router } from 'express';
import { getDb } from '../db/index.js';
import type { OwnedModelKind } from '../services/catalog-sync.js';
import { claimModel, OwnershipError, releaseModel } from '../services/model-ownership.js';

/** Run `fn`, mapping OwnershipError to its status. Returns false on error. */
export function withOwnership(res: Response, fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch (err) {
    if (err instanceof OwnershipError) {
      res.status(err.status).json({ error: { message: err.message } });
      return false;
    }
    throw err;
  }
}

export function parseRowId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return null;
  }
  return id;
}

/** POST /:id/claim and /:id/release for one model table. */
export function addOwnershipRoutes(router: Router, kind: OwnedModelKind): void {
  for (const [action, fn] of [['claim', claimModel], ['release', releaseModel]] as const) {
    router.post(`/:id/${action}`, (req: Request, res: Response) => {
      const id = parseRowId(req, res);
      if (id == null) return;
      if (withOwnership(res, () => fn(getDb(), kind, id))) {
        res.json({ success: true, id, source: action === 'claim' ? 'user' : 'catalog' });
      }
    });
  }
}

/** Validation message naming each offending field. */
export function issuesMessage(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map(e => (e.path.length ? `${e.path.map(String).join('.')}: ${e.message}` : e.message)).join(', ');
}
