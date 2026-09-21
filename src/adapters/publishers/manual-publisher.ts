/**
 * Manual publisher — PRD §25, §40, decision D1.
 *
 * V1's publisher. Instagram needs Meta App Review and LinkedIn needs a
 * developer app, neither of which exists yet, so publishing is a human action
 * for now.
 *
 * This is a first-class implementation of the Publisher port, not a stopgap.
 * It prepares everything needed to post, hands it to a human, and returns
 * AWAITING_HUMAN — it never reports PUBLISHED, because it has no way to know
 * that anything was published. §40 is explicit: no evidence, no published
 * state. Confirmation arrives later, from the person who actually posted.
 */

import type { Publisher, PublishRequest, PublishResult } from '@/ports';
import type { Platform } from '@/domain/content';

/** What the operator needs in front of them to post by hand. */
export function manualInstructions(request: PublishRequest): string {
  const lines = [
    `Post to ${request.platform} (${request.format}).`,
    '',
    'Caption:',
    request.caption,
  ];

  if (request.mediaPaths.length > 0) {
    lines.push('', 'Media:');
    for (const path of request.mediaPaths) lines.push(`  ${path}`);
  }

  lines.push(
    '',
    'Once posted, paste the post URL back here to confirm. Nothing is ' +
      'recorded as published until you do (§40).',
  );

  return lines.join('\n');
}

export function createManualPublisher(): Publisher {
  return {
    name: 'manual',
    kind: 'MANUAL',
    supports(_platform: Platform) {
      // A human can post anywhere; that is the point of the fallback.
      return true;
    },
    async publish(request: PublishRequest): Promise<PublishResult> {
      return {
        outcome: 'AWAITING_HUMAN',
        instructions: manualInstructions(request),
      };
    },
  };
}
