import { Router, type Response } from 'express';
import { Database, FolderError } from '../db/database';

/**
 * The folders workflows live in.
 *
 * A folder is addressed by its path, and the path travels in the query or
 * the body rather than the URL — `?path=Clients/Acme` — so a folder can be
 * called whatever the name rules allow without an encoding round-trip, and
 * so nothing a folder is called can shadow a route.
 */
const router = Router();

/** The status a folder error reads as, and its body. */
function sendFolderError(res: Response, error: unknown): boolean {
  if (!(error instanceof FolderError)) return false;
  const status =
    error.code === 'not_found' ? 404 : error.code === 'exists' || error.code === 'not_empty' ? 409 : 400;
  res.status(status).json({ error: error.message, code: error.code, ...(error.contents && { contents: error.contents }) });
  return true;
}

/** `?path=` — one level of the tree; the root when no path is given. */
router.get('/', (req, res) => {
  const db = (req as any).db as Database;
  try {
    const listing = db.folderListing(req.query.path);
    if (!listing) return res.status(404).json({ error: `No folder at "${req.query.path}"`, code: 'not_found' });
    res.json(listing);
  } catch (error) {
    if (!sendFolderError(res, error)) throw error;
  }
});

/** Every folder there is, in path order — what a "move to" list is built from. */
router.get('/all', (req, res) => {
  const db = (req as any).db as Database;
  res.json(db.listFolders());
});

/** `{ path }` — makes the folder and any missing folder above it. 201 when it is new, 200 when it was there. */
router.post('/', (req, res) => {
  const db = (req as any).db as Database;
  try {
    const { folder, created } = db.createFolder(req.body?.path);
    res.status(created ? 201 : 200).json({ ...folder, created });
  } catch (error) {
    if (!sendFolderError(res, error)) throw error;
  }
});

/** `{ path, newPath }` — renames the folder, or moves it, with everything under it. */
router.patch('/', (req, res) => {
  const db = (req as any).db as Database;
  try {
    res.json(db.renameFolder(req.body?.path, req.body?.newPath));
  } catch (error) {
    if (!sendFolderError(res, error)) throw error;
  }
});

/**
 * `?path=` — removes an empty folder. `&recursive=true` removes one that is
 * not empty, along with every folder under it and every workflow in any of
 * them (runs included); without it, a folder with contents answers 409 and
 * says what it holds.
 */
router.delete('/', (req, res) => {
  const db = (req as any).db as Database;
  const recursive = req.query.recursive === 'true' || req.query.recursive === '1';
  try {
    res.json({ deleted: db.deleteFolder(req.query.path, { recursive }) });
  } catch (error) {
    if (!sendFolderError(res, error)) throw error;
  }
});

export { router as folderRoutes };
