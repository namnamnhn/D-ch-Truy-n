import { describe, expect, it } from 'vitest';
import { runSemanticValidation } from '../src/services/storyEngine/semanticValidator';
import { validateStoryPipelineBaseline } from '../src/services/storyEngine/pipeline';
import { createDeterministicStoryControl } from '../src/services/storyEngine/compiler';
import { extractAndMergeState } from '../src/services/storyEngine/stateExtractor';
import { isCreativeCanonBaselineCurrent, tryAcquireGenerationLock } from '../src/hooks/pages/useCreativePage';
import { validateBatchPlanSemantically } from '../src/services/storyEngine/planValidator';

describe('Story safety regressions', () => {
  it('rejects a torn canon tuple before any model call', () => {
    expect(() => validateStoryPipelineBaseline([
      { id: 'one', chapterNumber: 1 }, { id: 'three', chapterNumber: 3 },
    ] as any, undefined, [])).toThrow('preflight');
    expect(() => validateStoryPipelineBaseline([], { currentChapter: 1 } as any, [])).toThrow('currentChapter');
    expect(() => validateStoryPipelineBaseline([], { currentChapter: 0 } as any, [
      { id: 'future', chapterStart: 1, chapterEnd: 1 },
    ] as any)).toThrow('memory');
  });

  it('rejects stale compare-and-swap commits atomically', () => {
    const baseline: any = { chapters: [], storyControl: {}, storyState: {}, memoryIndex: [] };
    expect(isCreativeCanonBaselineCurrent(baseline, baseline)).toBe(true);
    expect(isCreativeCanonBaselineCurrent({ ...baseline, chapters: [] }, baseline)).toBe(false);
  });

  it('takes a synchronous re-entry mutex only once for a double invocation', () => {
    const ref = { current: false };
    expect(tryAcquireGenerationLock(ref)).toBe(true);
    expect(tryAcquireGenerationLock(ref)).toBe(false);
  });

  it('aborts a semantic attempt on timeout before bounded retry', async () => {
    let active = 0; let maxActive = 0; let calls = 0; const seen: AbortSignal[] = [];
    const result = await runSemanticValidation('x', async (_prompt, _system, signal) => {
      calls++; active++; maxActive = Math.max(maxActive, active); seen.push(signal!);
      await new Promise<void>(resolve => signal!.addEventListener('abort', () => { active--; resolve(); }, { once: true }));
      throw new Error('timed out');
    }, { timeoutMs: 5, maxAttempts: 2 });
    expect(result.status).toBe('QA_UNAVAILABLE');
    expect(calls).toBe(2); expect(maxActive).toBe(1); expect(seen.every(signal => signal.aborted)).toBe(true);
  });

  it('surfaces parent cancellation instead of converting it into QA unavailable', async () => {
    const parent = new AbortController();
    const pending = runSemanticValidation('x', async () => await new Promise<string>(() => {}), { signal: parent.signal, timeoutMs: 1_000 });
    parent.abort();
    await expect(pending)
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rethrows a deferred state-extractor abort instead of committing its fallback delta', async () => {
    const bible: any = { seedTitle: 'Test', genre: 'Mystery', seriesPremise: 'P', continuitySummary: '', worldNotes: '', charNotes: '', outline: '', characters: [], totalPlannedChapters: 2 };
    const control = createDeterministicStoryControl(bible, 'hash', 2);
    let reject!: (error: Error) => void;
    const pending = extractAndMergeState([{ id: '1', chapterNumber: 1, title: 'One', content: 'Text', status: 'completed' }], {
      schemaVersion: 3, sourceHash: 'hash', currentChapter: 0, characterStates: {}, relationships: [], resources: {}, clues: [], unresolvedThreads: [], longTermSeeds: [], recentConsequences: [], currentArcId: control.arcs[0].id, currentArcProgress: 0, unlockedCharacterIds: [], worldFactStates: {}, knowledgeLedger: [], timeline: [], continuitySummary: '', consequences: [],
    } as any, control, [], '', 1, async () => await new Promise<string>((_resolve, fail) => { reject = fail; }));
    reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects an invalid state-extractor root instead of advancing chapter state', async () => {
    const bible: any = { seedTitle: 'Test', genre: 'Mystery', seriesPremise: 'P', continuitySummary: '', worldNotes: '', charNotes: '', outline: '', characters: [], totalPlannedChapters: 2 };
    const control = createDeterministicStoryControl(bible, 'hash', 2);
    const previous: any = {
      schemaVersion: 3, sourceHash: 'hash', currentChapter: 0, characterStates: {}, relationships: [], resources: {}, clues: [], unresolvedThreads: [], longTermSeeds: [], recentConsequences: [], currentArcId: control.arcs[0].id, currentArcProgress: 0, unlockedCharacterIds: [], worldFactStates: {}, knowledgeLedger: [], timeline: [], continuitySummary: '', consequences: [],
    };
    await expect(extractAndMergeState(
      [{ id: '1', chapterNumber: 1, title: 'One', content: 'Text', status: 'completed' }],
      previous, control, [], '', 1, async () => 'not-json',
    )).rejects.toThrow('STATE_DELTA_INVALID');
    expect(previous.currentChapter).toBe(0);
  });

  it('bounds semantic plan validation and aborts the in-flight target', async () => {
    let targetSignal: AbortSignal | undefined;
    const pending = validateBatchPlanSemantically({} as any, {} as any, {} as any, async (_prompt, _system, signal) => {
      targetSignal = signal;
      return await new Promise<string>(() => {});
    }, { timeoutMs: 5 });
    await expect(pending).rejects.toThrow('SEMANTIC_PLAN_TIMEOUT');
    expect(targetSignal?.aborted).toBe(true);
  });

  it('propagates parent cancellation through semantic plan validation', async () => {
    const parent = new AbortController();
    let targetSignal: AbortSignal | undefined;
    const pending = validateBatchPlanSemantically({} as any, {} as any, {} as any, async (_prompt, _system, signal) => {
      targetSignal = signal;
      return await new Promise<string>(() => {});
    }, { signal: parent.signal, timeoutMs: 1_000 });
    parent.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(targetSignal?.aborted).toBe(true);
  });
});
