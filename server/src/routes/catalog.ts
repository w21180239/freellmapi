import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { getCatalogOverlap } from '../services/catalog-sync.js';
import {
  blockCatalogIdentity,
  listUserRows,
  listUserTombstones,
  unblockCatalogIdentity,
} from '../services/model-ownership.js';
import { issuesMessage, withOwnership } from './ownership-routes.js';

// The owner's overlay on the signed catalog: local rows, blocks and the
// catalog entries that overlap local rows.
export const catalogRouter = Router();

// source='user' rows across chat, media and embeddings.
catalogRouter.get('/local', (_req: Request, res: Response) => {
  res.json(listUserRows(getDb()));
});

// Local rows the applied catalog also lists, with the fields that differ.
catalogRouter.get('/overlap', (_req: Request, res: Response) => {
  res.json(getCatalogOverlap());
});

catalogRouter.get('/tombstones', (_req: Request, res: Response) => {
  res.json(listUserTombstones(getDb()));
});

// Model ids contain slashes, so the identity travels in the body.
const identitySchema = z.object({
  kind: z.enum(['chat', 'media', 'embedding']),
  platform: z.string().trim().min(1),
  modelId: z.string().trim().min(1).max(200),
}).strict();

// Block a model that has no local row yet; rows are blocked by deleting them.
catalogRouter.post('/tombstones', (req: Request, res: Response) => {
  const parsed = identitySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: issuesMessage(parsed.error) } });
    return;
  }
  const { kind, platform, modelId } = parsed.data;
  if (withOwnership(res, () => blockCatalogIdentity(getDb(), kind, platform, modelId))) {
    res.status(201).json({ success: true, ...parsed.data });
  }
});

// Unblock: the next catalog apply may add the model again.
catalogRouter.delete('/tombstones', (req: Request, res: Response) => {
  const parsed = identitySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: issuesMessage(parsed.error) } });
    return;
  }
  const { kind, platform, modelId } = parsed.data;
  if (!unblockCatalogIdentity(getDb(), kind, platform, modelId)) {
    res.status(404).json({ error: { message: `No user block for ${kind} ${platform}/${modelId}` } });
    return;
  }
  res.json({ success: true });
});
