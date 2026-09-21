/**
 * OCR engines — decision D4, PRD §34 (local processing), §42 (privacy).
 *
 * Everything here runs locally. A screenshot of your own analytics never
 * leaves the machine, which §42's minimisation rule asks for and §32's cost
 * target requires.
 *
 * Two engines, and the order matters:
 *
 *   PASTED   The human copies the text themselves and pastes it. macOS Live
 *            Text reads a screenshot in Preview or Photos with no setup at
 *            all, and its accuracy on UI screenshots is better than anything
 *            installable. Zero dependencies, always available.
 *
 *   TESSERACT  Shells out to the `tesseract` CLI for a fully automated path
 *            from an image file. Optional; requires `brew install tesseract`.
 *
 * Both feed the same parser, so the guarantees in metrics-parse.ts — never
 * invent a metric, confidence-gate the write — hold either way.
 *
 * NOTE: the Tesseract path has not been exercised on macOS from this
 * development environment (Linux, no tesseract installed). Its command
 * construction is straightforward, but treat the first real run as a test.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type OcrEngineKind = 'PASTED' | 'TESSERACT';

export interface OcrEngine {
  readonly kind: OcrEngineKind;
  readonly name: string;
  /** Whether this engine can run right now on this machine. */
  available(): Promise<boolean>;
  /** Extracts text from an image file. */
  read(imagePath: string): Promise<string>;
}

export class OcrUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrUnavailableError';
  }
}

/**
 * The no-op engine. The human has already done the OCR.
 *
 * It exists as an engine rather than a special case so the application layer
 * has one path regardless of where the text came from.
 */
export function createPastedEngine(): OcrEngine {
  return {
    kind: 'PASTED',
    name: 'pasted text',
    available: async () => true,
    read: async () => {
      throw new OcrUnavailableError(
        'The pasted-text engine does not read images — pass the text directly.',
      );
    },
  };
}

const TESSERACT_TIMEOUT_MS = 30_000;

export function createTesseractEngine(
  binary = process.env.TESSERACT_PATH ?? 'tesseract',
): OcrEngine {
  return {
    kind: 'TESSERACT',
    name: 'tesseract',

    async available() {
      try {
        await run(binary, ['--version'], { timeout: 5_000 });
        return true;
      } catch {
        return false;
      }
    },

    async read(imagePath: string) {
      try {
        // `stdout` as the output name writes the text to stdout rather than
        // a file. --psm 6 treats the image as a uniform block, which suits a
        // stacked panel of label/value tiles better than the default.
        const { stdout } = await run(
          binary,
          [imagePath, 'stdout', '--psm', '6'],
          { timeout: TESSERACT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        );
        return stdout;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new OcrUnavailableError(`tesseract failed: ${message}`);
      }
    },
  };
}

/**
 * Picks an engine for reading an image.
 *
 * Returns null when no image-capable engine is installed. That is a normal
 * state, not an error: the pasted-text path is the primary one and needs
 * nothing.
 */
export async function resolveImageEngine(): Promise<OcrEngine | null> {
  const tesseract = createTesseractEngine();
  if (await tesseract.available()) return tesseract;
  return null;
}
