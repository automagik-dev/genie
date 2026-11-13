// A wish's copy folder: remembered by what it was when it was made (device, inode, real
// path), so that a later removal is tried only on a folder that still looks like that one.
// This narrows what a removal can hit; it is not ownership. Another local process writing
// in the wishes folder can still mislead it: a swap between the mkdir and the first look
// here (the swapped-in folder is then the one remembered), a swap of the folder itself or of
// a parent after the last check and before the removal, or an inode the file system gives
// out again. Closing those needs an OS-level handle on the directory, which Node does not
// offer for a recursive removal.
import { lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const identityOf = (path, stat) => {
  const { dev, ino } = stat(path, { bigint: true });
  return { dev, ino };
};

/**
 * Makes `<root>/<slug>` for one wish and says which directory that is. The mkdir is not
 * recursive on purpose: a path something else already holds (a folder, a file, a symlink)
 * throws EEXIST, and the caller removes nothing.
 *
 * The directory is known afterwards by its device and inode. A file system that gives no
 * usable ones (inode 0, or two looks that disagree) leaves the claim `identified: false`,
 * and such a copy is never removed: nothing would tell it from another put at its path.
 */
export function claimCopy(root, slug, { stat = lstatSync } = {}) {
  mkdirSync(root, { recursive: true });
  const folder = join(root, slug);
  mkdirSync(folder);
  const first = identityOf(folder, stat);
  const again = identityOf(folder, stat);
  const identified = first.ino !== 0n && first.ino === again.ino && first.dev === again.dev;
  return { folder, root, ...first, identified, real: realpathSync(folder), rootReal: realpathSync(root) };
}

/**
 * Whether `claim.folder` still looks like the directory the claim remembered: an identified
 * one, the same device and inode, at the same real path, inside the same real wishes folder
 * (a parent replaced by a symlink leads elsewhere). Anything that cannot be read is a no.
 */
export function stillClaimed(claim, { stat = lstatSync } = {}) {
  try {
    if (claim.identified !== true) return false;
    const now = stat(claim.folder, { bigint: true });
    if (!now.isDirectory() || now.dev !== claim.dev || now.ino !== claim.ino) return false;
    return realpathSync(claim.folder) === claim.real && realpathSync(claim.root) === claim.rootReal;
  } catch {
    return false;
  }
}

/**
 * Removes a claimed copy through the real path recorded at the claim, checked again right
 * before the removal. Never throws. Answers `removed`; `uncertain` when the folder could not
 * be shown to be the remembered one (nothing was touched); `failed` when it passed that check
 * and the removal itself failed.
 */
export function removeCopy(claim, { rm = rmSync, stat = lstatSync } = {}) {
  if (!stillClaimed(claim, { stat })) return 'uncertain';
  try {
    rm(claim.real, { recursive: true, force: true });
    return 'removed';
  } catch {
    return 'failed';
  }
}
