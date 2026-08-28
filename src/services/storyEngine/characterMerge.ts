import { Character } from '../../types';
import { StoryControl } from './types';
import { getCharacterAccess } from './storyAccess';

function key(value: string): string {
  return value.toLocaleLowerCase('vi-VN').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\W+/g, ' ').trim();
}

function validCharacter(value: Character | undefined): value is Character {
  return Boolean(value && typeof value.name === 'string' && value.name.trim()
    && typeof value.id === 'string' && value.id.trim());
}

export function mergeExtractedCharacters(
  existing: Character[] | undefined,
  incoming: Character[] | undefined,
  control?: StoryControl,
  chapter = 1
): Character[] {
  const result = (existing || []).filter(validCharacter).map(character => ({ ...character }));
  const identities = new Set(result.flatMap(character => [key(character.id), key(character.name)]));
  const registryAliases = new Map<string, { id: string; active: boolean }>();
  for (const character of Object.values(control?.characterRegistry || {})) {
    const active = getCharacterAccess(control!, character, chapter).canMention;
    for (const identity of [character.id, character.name, ...(character.aliasSet || []), ...(character.aliases || [])]) {
      registryAliases.set(key(identity), { id: character.id, active });
    }
  }
  for (const character of incoming || []) {
    if (!validCharacter(character)) continue;
    const incomingKeys = [key(character.id), key(character.name)];
    if (incomingKeys.some(identity => identities.has(identity))) continue;
    const canonical = incomingKeys.map(identity => registryAliases.get(identity)).find(Boolean);
    if (canonical) {
      // Registry profiles are authoritative. Locked future entries do not become active UI characters.
      if (!canonical.active || identities.has(key(canonical.id))) continue;
      continue;
    }
    result.push({ ...character });
    incomingKeys.forEach(identity => identities.add(identity));
  }
  return result;
}
