import { isFormattingOnlyChange } from './packages/application/src/inherited-formatting-debt';

isFormattingOnlyChange('test.ts', 'const a = `foo`;', 'const a = `bar`;');
