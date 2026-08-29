import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePdf } from '../src/utils/file/parsers';
import {
  createSecurePdfDocumentOptions,
  PDFJS_LOCAL_ASSET_BASE,
  PDFJS_WORKER_URL,
} from '../src/utils/file/pdfRuntime';
import { useFileImport } from '../src/hooks/fileHandler/fileImport';
import * as fileHelpers from '../src/utils/fileHelpers';
import { FileStatus, type FileItem } from '../src/types';

vi.mock('../src/utils/fileHelpers', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/utils/fileHelpers')>()),
  parsePdf: vi.fn(),
}));

const fixture = (name: string): File => new File(
  [new Uint8Array(readFileSync(join(process.cwd(), 'tests', 'fixtures', name)))],
  name,
  { type: 'application/pdf' },
);

describe('WP-FIN-01 PDF runtime containment', () => {
  beforeAll(async () => {
    if (!('toHex' in Uint8Array.prototype)) {
      Object.defineProperty(Uint8Array.prototype, 'toHex', {
        value(this: Uint8Array) {
          return Array.from(this, byte => byte.toString(16).padStart(2, '0')).join('');
        },
      });
    }
    const canvas = await import('@napi-rs/canvas');
    vi.stubGlobal('DOMMatrix', canvas.DOMMatrix);
    vi.stubGlobal('ImageData', canvas.ImageData);
    vi.stubGlobal('Path2D', canvas.Path2D);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('imports an ordinary synthetic PDF with the supported runtime', async () => {
    const result = await parsePdf(fixture('ordinary.pdf'));
    expect(result.files).toEqual([]);
    expect(result.content).toContain('Ordinary PDF import works safely');
  });

  it('rejects a safe truncated/adversarial fixture without executing content', async () => {
    await expect(parsePdf(fixture('malformed.pdf'))).rejects.toThrow(/Lỗi đọc PDF:/);
  });

  it('disables eval where supported and uses only local auxiliary assets', () => {
    const options = createSecurePdfDocumentOptions(new ArrayBuffer(8));
    expect(options.isEvalSupported).toBe(false);
    expect(options.stopAtErrors).toBe(true);
    expect(options.enableXfa).toBe(false);
    expect([
      options.cMapUrl,
      options.iccUrl,
      options.standardFontDataUrl,
      options.wasmUrl,
    ]).toEqual([
      `${PDFJS_LOCAL_ASSET_BASE}cmaps/`,
      `${PDFJS_LOCAL_ASSET_BASE}iccs/`,
      `${PDFJS_LOCAL_ASSET_BASE}standard_fonts/`,
      `${PDFJS_LOCAL_ASSET_BASE}wasm/`,
    ]);
  });

  it('resolves the worker locally and keeps CSP restrictive', () => {
    const indexHtml = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
    expect(PDFJS_WORKER_URL).not.toMatch(/^https?:/);
    expect(PDFJS_WORKER_URL).not.toMatch(/jsdelivr|unpkg/i);
    expect(indexHtml).toMatch(/worker-src 'self' blob:/);
    expect(indexHtml).not.toContain('unsafe-eval');
    expect(indexHtml).not.toMatch(/jsdelivr|unpkg/i);
  });

  it('uses a PDF.js version outside the known vulnerable range', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const version = String(packageJson.dependencies['pdfjs-dist']);
    const [major, minor, patch] = version.split('.').map(Number);
    expect([major, minor, patch]).toEqual([6, 2, 108]);
    expect(major > 4 || (major === 4 && (minor > 1 || (minor === 1 && patch > 392)))).toBe(true);
  });

  it('does not mutate an accepted workspace when PDF import fails', async () => {
    const acceptedFile: FileItem = {
      id: 'accepted',
      name: 'accepted.txt',
      content: 'accepted manuscript',
      translatedContent: 'bản dịch đã duyệt',
      status: FileStatus.COMPLETED,
      retryCount: 0,
      originalCharCount: 19,
      remainingRawCharCount: 0,
    };
    const originalSnapshot = structuredClone(acceptedFile);
    vi.mocked(fileHelpers.parsePdf).mockRejectedValue(new Error('Invalid PDF structure'));

    const core = {
      files: [acceptedFile],
      storyInfo: {},
      setFiles: vi.fn(),
      setStoryInfo: vi.fn(),
    };
    const ui = {
      setImportProgress: vi.fn(),
      addToast: vi.fn(),
    };

    await useFileImport(core as never, ui as never).processFiles([fixture('malformed.pdf')]);

    expect(core.setFiles).not.toHaveBeenCalled();
    expect(core.setStoryInfo).not.toHaveBeenCalled();
    expect(acceptedFile).toEqual(originalSnapshot);
    expect(ui.addToast).toHaveBeenCalledWith(expect.stringContaining('Lỗi PDF:'), 'error');
  });
});
