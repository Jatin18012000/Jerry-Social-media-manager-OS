/**
 * Publisher registry — §25, §35.
 *
 * V1 resolves everything to the manual publisher. When LinkedIn and Instagram
 * access clears, their publishers are registered here and selected by
 * PUBLISHER_MODE; no caller changes (§64).
 */

import type { Platform } from '@/domain/content';
import type { Publisher } from '@/ports';
import { createManualPublisher } from './manual-publisher';

export interface PublisherRegistry {
  for(platform: Platform): Publisher;
}

export function createPublisherRegistry(
  mode: 'MANUAL' | 'LIVE' = 'MANUAL',
): PublisherRegistry {
  const manual = createManualPublisher();

  return {
    for(platform: Platform): Publisher {
      if (mode === 'MANUAL') return manual;

      // LIVE publishers arrive in M6+. Until one exists for a platform,
      // falling back to manual is correct — and far better than throwing
      // mid-publish or, worse, silently doing nothing.
      switch (platform) {
        case 'LINKEDIN':
        case 'INSTAGRAM':
        default:
          return manual;
      }
    },
  };
}

export { createManualPublisher, manualInstructions } from './manual-publisher';
