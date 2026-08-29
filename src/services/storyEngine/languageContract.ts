import { StoryBible, StoryControl } from './types';
import { projectCharactersForChapter } from './storyAccess';

export interface OutputLanguageContract {
  targetLanguage: string;
  strict: boolean;
  permittedForeignTerms: string[];
  allowedScripts: Array<'LATIN' | 'CYRILLIC' | 'HAN'>;
}

export interface ScriptContaminationFinding {
  script: 'CYRILLIC' | 'HAN';
  fragment: string;
  index: number;
}

const LANGUAGE_KEYS = ['outputLanguage', 'proseLanguage', 'narrativeLanguage'];
const ALLOWLIST_KEYS = new Set([
  'allowedforeignterms',
  'permittedforeignterms',
  'canonicalpropernouns',
  'allowedterminology',
  'allowedabbreviations'
]);

function stringSetting(control: StoryControl, bible: StoryBible | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const controlValue = control.settings?.[key];
    if (typeof controlValue === 'string' && controlValue.trim()) return controlValue.trim();
    const bibleValue = bible?.storyEngineSettingsV3?.[key];
    if (typeof bibleValue === 'string' && bibleValue.trim()) return bibleValue.trim();
  }
  return undefined;
}

function explicitBooleanSetting(
  control: StoryControl,
  bible: StoryBible | undefined,
  keys: string[]
): boolean | undefined {
  for (const source of [control.settings, bible?.storyEngineSettingsV3]) {
    const values = keys.map(key => source?.[key])
      .filter((value): value is boolean => typeof value === 'boolean');
    if (values.includes(true)) return true;
    if (values.includes(false)) return false;
  }
  return undefined;
}

function isExplicitMultilingual(
  control: StoryControl,
  bible: StoryBible | undefined,
  targetLanguage: string
): boolean {
  const booleanKeys = ['multilingual', 'multilingualOutput', 'allowMultilingualOutput', 'allowCodeSwitching'];
  if (explicitBooleanSetting(control, bible, booleanKeys) === true) return true;
  const mode = stringSetting(control, bible, ['outputLanguageMode', 'languageMode']);
  const descriptor = `${targetLanguage} ${mode || ''}`.toLocaleLowerCase('en-US');
  return /\b(?:multilingual|bilingual|mixed[- ]language|đa ngôn ngữ|song ngữ)\b/u.test(descriptor);
}

function collectAllowlistedTerms(value: unknown, output: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectAllowlistedTerms(item, output);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (ALLOWLIST_KEYS.has(key.toLocaleLowerCase('en-US')) && Array.isArray(child)) {
      for (const item of child) if (typeof item === 'string' && item.trim()) output.add(item.trim());
    }
    collectAllowlistedTerms(child, output);
  }
}

function characterTerms(character: { name?: string; aliasSet?: string[]; aliases?: string[] }): string[] {
  return [character.name, ...(character.aliasSet || []), ...(character.aliases || [])]
    .filter((term): term is string => typeof term === 'string' && Boolean(term.trim()))
    .map(term => term.trim());
}

function normalizedIdentity(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/g, ' ').trim();
}

function termExposesIdentity(term: string, identity: string): boolean {
  const candidate = normalizedIdentity(term);
  const hidden = normalizedIdentity(identity);
  if (!candidate || !hidden) return false;
  if (candidate === hidden) return true;
  if (hidden.length < 2) return false;
  const escaped = hidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'u').test(candidate);
}

function buildOutputLanguageContract(
  control: StoryControl,
  bible: StoryBible | undefined,
  permitted: Set<string>
): OutputLanguageContract {
  const targetLanguage = stringSetting(control, bible, LANGUAGE_KEYS) || 'Vietnamese';
  const foldedLanguage = targetLanguage.toLocaleLowerCase('en-US');
  const allowedScripts = new Set<OutputLanguageContract['allowedScripts'][number]>(['LATIN']);
  if (/(?:chinese|mandarin|cantonese|japanese|tiếng trung|tiếng nhật|中文|日本語)/u.test(foldedLanguage)) allowedScripts.add('HAN');
  if (/(?:russian|ukrainian|belarusian|bulgarian|serbian|macedonian|tiếng nga|рус)/u.test(foldedLanguage)) allowedScripts.add('CYRILLIC');
  for (const source of [control.settings, bible?.storyEngineSettingsV3]) {
    const configured = source?.allowedScripts;
    if (Array.isArray(configured)) for (const item of configured) {
      if (item === 'LATIN' || item === 'CYRILLIC' || item === 'HAN') allowedScripts.add(item);
    }
  }
  const explicitStrict = explicitBooleanSetting(control, bible, ['strictOutputLanguage', 'enforceOutputLanguage']);
  return {
    targetLanguage,
    // V3 defaults to deterministic script protection. It is relaxed only by
    // an explicit multilingual declaration or a deliberate boolean opt-out.
    strict: explicitStrict ?? !isExplicitMultilingual(control, bible, targetLanguage),
    permittedForeignTerms: [...permitted],
    allowedScripts: [...allowedScripts]
  };
}

/** Full authoritative contract for Validator-side checks. Never serialize it into Writer context. */
export function createOutputLanguageContract(
  control: StoryControl,
  bible?: StoryBible
): OutputLanguageContract {
  const permitted = new Set<string>();
  collectAllowlistedTerms(control.settings, permitted);
  collectAllowlistedTerms(bible?.storyEngineSettingsV3, permitted);
  for (const character of Object.values(control.characterRegistry || {})) {
    for (const term of characterTerms(character)) permitted.add(term);
  }
  for (const character of bible?.characters || []) if (character.name?.trim()) permitted.add(character.name.trim());
  return buildOutputLanguageContract(control, bible, permitted);
}

/**
 * Writer-safe, chapter-scoped contract. Only character terms present in the
 * reader-safe projection are eligible. Explicit author allowlists are also
 * filtered against every still-hidden name/alias before serialization.
 */
export function createWriterOutputLanguageContract(
  control: StoryControl,
  bible: StoryBible | undefined,
  chapter: number
): OutputLanguageContract {
  const projected = projectCharactersForChapter(control, chapter).available;
  const visibleTerms = new Set<string>();
  for (const character of projected) {
    for (const term of characterTerms(character)) visibleTerms.add(term);
  }
  const visibleIdentities = new Set([...visibleTerms].map(normalizedIdentity));
  const hiddenTerms = new Set<string>();
  for (const character of Object.values(control.characterRegistry || {})) {
    for (const term of characterTerms(character)) {
      if (!visibleIdentities.has(normalizedIdentity(term))) hiddenTerms.add(term);
    }
  }
  for (const character of bible?.characters || []) {
    if (character.name?.trim() && !visibleIdentities.has(normalizedIdentity(character.name))) {
      hiddenTerms.add(character.name.trim());
    }
  }

  const explicitTerms = new Set<string>();
  collectAllowlistedTerms(control.settings, explicitTerms);
  collectAllowlistedTerms(bible?.storyEngineSettingsV3, explicitTerms);
  const permitted = new Set([...explicitTerms].filter(term =>
    ![...hiddenTerms].some(hidden => termExposesIdentity(term, hidden))));
  for (const term of visibleTerms) permitted.add(term);
  return buildOutputLanguageContract(control, bible, permitted);
}

function rangeIsAllowlisted(content: string, start: number, end: number, allowlist: string[]): boolean {
  const folded = content.toLocaleLowerCase('und');
  return allowlist.some(term => {
    const needle = term.toLocaleLowerCase('und');
    if (!needle) return false;
    let from = 0;
    while (from <= folded.length) {
      const found = folded.indexOf(needle, from);
      if (found < 0) return false;
      if (found <= start && found + needle.length >= end) return true;
      from = found + Math.max(1, needle.length);
    }
    return false;
  });
}

export function findUnexpectedScriptContamination(
  content: string,
  contract: OutputLanguageContract
): ScriptContaminationFinding[] {
  if (!contract.strict || !content) return [];
  const findings: ScriptContaminationFinding[] = [];
  const patterns: Array<{ script: ScriptContaminationFinding['script']; regex: RegExp }> = [
    { script: 'CYRILLIC', regex: /\p{Script=Cyrillic}+/gu },
    { script: 'HAN', regex: /\p{Script=Han}+/gu }
  ];
  for (const { script, regex } of patterns) {
    if (contract.allowedScripts.includes(script)) continue;
    for (const match of content.matchAll(regex)) {
      const index = match.index || 0;
      const fragment = match[0];
      if (!rangeIsAllowlisted(content, index, index + fragment.length, contract.permittedForeignTerms)) {
        findings.push({ script, fragment, index });
      }
    }
  }
  return findings;
}

export function formatOutputLanguageContract(contract: OutputLanguageContract): string {
  const allowed = contract.permittedForeignTerms.length
    ? contract.permittedForeignTerms.join(', ')
    : '(none explicitly supplied)';
  return `[OUTPUT LANGUAGE CONTRACT]\nProse language: ${contract.targetLanguage}.\nStrict language mode: ${contract.strict ? 'enabled' : 'disabled'}.\nAllowed scripts: ${contract.allowedScripts.join(', ')}.\nPermitted canonical foreign terms/names: ${allowed}.\nWrite narrative prose naturally in the prose language. Do not code-switch or insert foreign lexical/script fragments outside the explicit allowance. Preserve permitted canonical proper nouns, abbreviations, and terminology exactly.`;
}
