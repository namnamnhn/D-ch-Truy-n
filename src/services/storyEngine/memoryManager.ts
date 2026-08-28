import { ChapterMemory, MEMORY_SCHEMA_VERSION, StoryControl, StoryState } from './types';

export interface MemoryQuery {
  currentChapter: number;
  currentArcId?: string;
  characterIds?: string[];
  characterNames?: string[];
  locations?: string[];
  threadIds?: string[];
  factIds?: string[];
  seedIds?: string[];
  injuryIds?: string[];
  relationshipIds?: string[];
  consequenceIds?: string[];
  text?: string;
}

function normalized(value: string): string {
  return value.toLocaleLowerCase('vi-VN').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\W+/g, ' ').trim();
}

function set(values: string[] | undefined): Set<string> {
  return new Set((values || []).map(normalized).filter(Boolean));
}

function countMatches(left: string[] | undefined, right: Set<string>): number {
  return (left || []).reduce((count, item) => count + (right.has(normalized(item)) ? 1 : 0), 0);
}

function asQuery(activeOrQuery: string[] | MemoryQuery, currentChapter?: number): MemoryQuery {
  return Array.isArray(activeOrQuery)
    ? { characterNames: activeOrQuery, currentChapter: currentChapter || 1 }
    : activeOrQuery;
}

export function scoreMemoryRelevance(
  mem: ChapterMemory,
  activeOrQuery: string[] | MemoryQuery,
  currentChapter?: number
): number {
  const query = asQuery(activeOrQuery, currentChapter);
  let score = 0;
  const threads = set(query.threadIds);
  const seeds = set(query.seedIds);
  const facts = set(query.factIds);
  const injuries = set(query.injuryIds);
  const relationships = set(query.relationshipIds);
  const consequences = set(query.consequenceIds);
  const characters = set([...(query.characterIds || []), ...(query.characterNames || [])]);
  const locations = set(query.locations);

  // Priority order intentionally outweighs recency: unresolved thread > seed/clue > arc > relationship > location > injury > canon > recency.
  score += countMatches(mem.threadIds, threads) * (mem.resolved ? 80 : 1000);
  score += countMatches(mem.seedIds, seeds) * (mem.resolved ? 70 : 850);
  score += countMatches(mem.factIds, facts) * 700;
  if (query.currentArcId && mem.arcId === query.currentArcId) score += 500;
  score += countMatches(mem.relationshipIds, relationships) * 420;
  score += countMatches([...(mem.characterIds || []), ...(mem.charactersInvolved || [])], characters) * 250;
  score += countMatches(mem.locations, locations) * 300;
  score += countMatches(mem.injuryIds, injuries) * (mem.resolved ? 90 : 380);
  score += countMatches(mem.consequenceIds, consequences) * 350;
  if (mem.irreversible) score += 300;
  if ((mem.importance || 0) >= 80) score += 180;
  if (!mem.resolved && ((mem.threadIds?.length || 0) + (mem.seedIds?.length || 0) + (mem.injuryIds?.length || 0) > 0)) score += 160;

  const textTokens = set((query.text || '').split(/\s+/));
  if (textTokens.size) {
    const memoryTokens = set(`${mem.title} ${mem.summary}`.split(/\s+/));
    score += Array.from(textTokens).filter(token => token.length > 2 && memoryTokens.has(token)).length * 25;
  }
  const distance = Math.max(0, query.currentChapter - (mem.chapterEnd || mem.chapterNumber));
  score += distance <= 5 ? 100 : distance <= 15 ? 60 : distance <= 30 ? 30 : Math.max(0, 20 - Math.floor(distance / 25));
  return score;
}

export function retrieveRelevantMemories(
  memoryIndex: ChapterMemory[] | undefined,
  activeOrQuery: string[] | MemoryQuery,
  currentChapterOrMax: number = 1,
  legacyMaxMemories: number = 6
): ChapterMemory[] {
  if (!memoryIndex?.length) return [];
  const query = Array.isArray(activeOrQuery) ? asQuery(activeOrQuery, currentChapterOrMax) : activeOrQuery;
  const maxMemories = Array.isArray(activeOrQuery) ? legacyMaxMemories : currentChapterOrMax;
  return memoryIndex.map(mem => ({ mem, score: scoreMemoryRelevance(mem, query) }))
    .sort((a, b) => b.score - a.score || (b.mem.chapterNumber - a.mem.chapterNumber))
    .slice(0, Math.max(1, maxMemories))
    .map(item => item.mem);
}

function collectSecrets(value: unknown, result = new Set<string>()): Set<string> {
  if (typeof value === 'string' && value.trim().length >= 4) result.add(value.trim());
  else if (Array.isArray(value)) value.forEach(item => collectSecrets(item, result));
  else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(item => collectSecrets(item, result));
  return result;
}

export function sanitizeMemoriesForReader(memories: ChapterMemory[], control: StoryControl): ChapterMemory[] {
  const secrets = collectSecrets(control.authorOnlySecrets);
  for (const thread of control.mysteryThreads || []) {
    if (thread && typeof thread === 'object') collectSecrets((thread as Record<string, unknown>).actualTruth, secrets);
  }
  for (const fact of control.worldFacts || []) {
    if (fact.visibility === 'author_only' || fact.scope === 'hidden_truth') {
      collectSecrets(fact.fact, secrets);
      collectSecrets(fact.secretTruth, secrets);
    }
  }
  const redact = (text: string) => Array.from(secrets).reduce((safe, secret) => safe.split(secret).join('[REDACTED]'), text);
  const lockedFactIds = new Set((control.worldFacts || []).filter(fact =>
    fact.visibility === 'author_only' || fact.scope === 'hidden_truth').map(fact => fact.id));
  const safeArray = (values: string[] | undefined) => values?.slice(0, 20).map(value => redact(value).slice(0, 500));
  return memories.map(memory => ({
    ...memory,
    summary: redact(memory.summary).slice(0, 2000),
    charactersInvolved: safeArray(memory.charactersInvolved) || [],
    locations: safeArray(memory.locations) || [],
    clues: safeArray(memory.clues),
    injuries: safeArray(memory.injuries),
    relationshipChanges: safeArray(memory.relationshipChanges),
    resources: safeArray(memory.resources),
    longTermSeeds: safeArray(memory.longTermSeeds),
    factIds: memory.factIds?.filter(id => !lockedFactIds.has(id)).slice(0, 20),
    threadIds: memory.threadIds?.slice(0, 20),
    seedIds: memory.seedIds?.slice(0, 20),
    injuryIds: memory.injuryIds?.slice(0, 20),
    relationshipIds: memory.relationshipIds?.slice(0, 20)
  }));
}

function protectedMemory(memory: ChapterMemory, state?: StoryState): boolean {
  if (memory.irreversible || !memory.resolved && ((memory.threadIds?.length || 0) + (memory.seedIds?.length || 0)
    + (memory.injuryIds?.length || 0) + (memory.relationshipIds?.length || 0) + (memory.consequenceIds?.length || 0) > 0)) return true;
  if (!state) return false;
  const activeInjuries = new Set(Object.values(state.characterStates || {}).flatMap(character => character.injuries || [])
    .filter(injury => injury.status !== 'recovered').map(injury => injury.id || injury.type));
  return (memory.injuryIds || []).some(id => activeInjuries.has(id));
}

export function compactMemoryIndex(memoryIndex: ChapterMemory[], maxEntries = 240, state?: StoryState): ChapterMemory[] {
  if (memoryIndex.length <= maxEntries) return memoryIndex;
  const protectedEntries = memoryIndex.filter(memory => protectedMemory(memory, state));
  const removable = memoryIndex.filter(memory => !protectedMemory(memory, state))
    .sort((a, b) => (b.importance || 0) - (a.importance || 0) || b.chapterNumber - a.chapterNumber);
  const kept = [...protectedEntries, ...removable.slice(0, Math.max(0, maxEntries - protectedEntries.length))];
  return kept.sort((a, b) => a.chapterNumber - b.chapterNumber);
}

export async function compactMemoryIndexSafely(
  memoryIndex: ChapterMemory[],
  maxEntries = 240,
  state?: StoryState,
  compactor?: (memories: ChapterMemory[]) => Promise<ChapterMemory[]>
): Promise<ChapterMemory[]> {
  const deterministic = compactMemoryIndex(memoryIndex, maxEntries, state);
  if (!compactor) return deterministic;
  try {
    const compacted = await compactor(deterministic);
    if (!Array.isArray(compacted) || compacted.some(memory => !memory || typeof memory.summary !== 'string')) return memoryIndex;
    const protectedIds = new Set(deterministic.filter(memory => protectedMemory(memory, state)).map(memory => memory.id || `chapter_${memory.chapterNumber}`));
    const returnedIds = new Set(compacted.map(memory => memory.id || `chapter_${memory.chapterNumber}`));
    if (Array.from(protectedIds).some(id => !returnedIds.has(id))) return memoryIndex;
    return compacted.map(memory => ({ ...memory, schemaVersion: MEMORY_SCHEMA_VERSION }));
  } catch {
    return memoryIndex;
  }
}

export function formatMemoriesForContext(memories: ChapterMemory[], maxCharacters = 12000): string {
  if (!memories.length) return 'No prior relevant memory.';
  const text = [...memories].sort((a, b) => a.chapterNumber - b.chapterNumber).map(memory => {
    const items = [memory.summary];
    if (memory.charactersInvolved?.length) items.push(`Characters: ${memory.charactersInvolved.join(', ')}`);
    if (memory.locations?.length) items.push(`Locations: ${memory.locations.join(', ')}`);
    if (memory.injuries?.length) items.push(`Injuries: ${memory.injuries.join('; ')}`);
    if (memory.relationshipChanges?.length) items.push(`Relationships: ${memory.relationshipChanges.join('; ')}`);
    if (memory.clues?.length) items.push(`Clues: ${memory.clues.join('; ')}`);
    if (memory.longTermSeeds?.length) items.push(`Seeds: ${memory.longTermSeeds.join('; ')}`);
    return `[Chapter ${memory.chapterStart || memory.chapterNumber}-${memory.chapterEnd || memory.chapterNumber}: ${memory.title}]\n${items.join('\n')}`;
  }).join('\n\n');
  return text.slice(0, maxCharacters);
}
