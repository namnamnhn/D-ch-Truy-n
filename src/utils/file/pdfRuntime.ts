import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export const PDFJS_LOCAL_ASSET_BASE = '/pdfjs-assets/';

export type SecurePdfDocumentOptions = {
  data: ArrayBuffer;
  cMapUrl: string;
  cMapPacked: true;
  iccUrl: string;
  standardFontDataUrl: string;
  wasmUrl: string;
  stopAtErrors: true;
  enableXfa: false;
  enableScripting: false;
  /** Fail-closed compatibility option for PDF.js APIs that expose eval control. */
  isEvalSupported: false;
};

const localAssetUrl = (directory: string): string => {
  const relativeUrl = `${PDFJS_LOCAL_ASSET_BASE}${directory}/`;
  return typeof document === 'undefined' ? relativeUrl : new URL(relativeUrl, document.baseURI).href;
};

export const createSecurePdfDocumentOptions = (data: ArrayBuffer): SecurePdfDocumentOptions => ({
  data,
  cMapUrl: localAssetUrl('cmaps'),
  cMapPacked: true,
  iccUrl: localAssetUrl('iccs'),
  standardFontDataUrl: localAssetUrl('standard_fonts'),
  wasmUrl: localAssetUrl('wasm'),
  stopAtErrors: true,
  enableXfa: false,
  enableScripting: false,
  isEvalSupported: false,
});

type PdfJsModule = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfJsModule> | null = null;

export const loadPdfjs = (): Promise<PdfJsModule> => {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then(pdfjsLib => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = typeof document === 'undefined'
        ? new URL('../../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
        : pdfWorkerUrl;
      return pdfjsLib;
    });
  }
  return pdfjsPromise;
};

export const PDFJS_WORKER_URL = pdfWorkerUrl;
