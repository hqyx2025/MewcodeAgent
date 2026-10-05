import { stripVTControlCharacters } from 'node:util';

export function terminalText(value: string): string {
  return stripVTControlCharacters(value).replace(/\p{Cc}/gu, (character) =>
    character === '\n' || character === '\t' ? character : '',
  );
}
