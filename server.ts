import { startAiStudioPreviewServer } from './server/aiStudioPreviewServer';

void startAiStudioPreviewServer().catch(error => {
  console.error('AI_STUDIO_PREVIEW_SERVER failed to start.', error);
  process.exitCode = 1;
});
