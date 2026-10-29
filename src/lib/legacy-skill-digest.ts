/**
 * The one rule the legacy skills catalog is written and read with
 * (`scripts/legacy-skills-catalog.ts` and `legacy-skills.ts`): a skill name or a frontmatter
 * `description` is recorded as the sha256 of its UTF-8 bytes, in lower-case hex.
 *
 * Nothing is normalised here. A name is the directory entry exactly as it is on disk; a
 * description is exactly the string the shared frontmatter parser returns (outer whitespace
 * trimmed, one pair of matching quotes removed). Case, inner whitespace and punctuation all
 * count, so a digest matches exactly when plain equality did, and the binary carries no
 * retired text.
 */
import { createHash } from 'node:crypto';

export function legacySkillDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
