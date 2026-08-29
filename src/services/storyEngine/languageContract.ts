import { StoryBible, StoryControl } from './types';

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

function booleanSetting(control: StoryControl, bible: StoryBible | undefined, keys: string[]): boolean {
  return keys.some(key => control.settings?.[key] === true || bible?.storyEngineSettingsV3?.[key] === true);
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

export function createOutputLanguageContract(
  control: StoryControl,
  bible?: StoryBible
): OutputLanguageContract {
  const permitted = new Set<string>();
  collectAllowlistedTerms(control.settings, permitted);
  collectAllowlistedTerms(bible?.storyEngineSettingsV3, permitted);
  for (const character of Object.values(control.characterRegistry || {})) {
    if (character.name?.trim()) permitted.add(character.name.trim());
    for (const alias of [...(character.aliasSet || []), ...(character.aliases || [])]) {
      if (alias?.trim()) permitted.add(alias.trim());
    }
  }
  for (const character of bible?.characters || []) if (character.name?.trim()) permitted.add(character.name.trim());
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
  return {
    targetLanguage,
    strict: booleanSetting(control, bible, ['strictOutputLanguage', 'enforceOutputLanguage']),
    permittedForeignTerms: [...permitted],
    allowedScripts: [...allowedScripts]
  };
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
