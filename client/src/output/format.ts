import type { OutputFormat } from '@joseki/shared';

/** A format with `auto` already decided. */
export type ResolvedFormat = Exclude<OutputFormat, 'auto'>;

export const OUTPUT_FORMATS: ReadonlyArray<{ value: OutputFormat; label: string; hint: string }> = [
  { value: 'auto', label: 'Auto', hint: 'JSON for objects and lists, Markdown for text' },
  { value: 'markdown', label: 'Markdown', hint: 'Rendered on screen; downloads as .md' },
  { value: 'text', label: 'Plain text', hint: 'Shown as-is; downloads as .txt' },
  { value: 'json', label: 'JSON', hint: 'Pretty-printed; downloads as .json' }
];

/** What `auto` means for this value: structure is JSON, prose is Markdown. */
export function resolveFormat(value: unknown, setting: OutputFormat | undefined): ResolvedFormat {
  if (setting && setting !== 'auto') return setting;
  return typeof value === 'string' ? 'markdown' : 'json';
}

export interface SerializedOutput {
  text: string;
  extension: 'md' | 'txt' | 'json';
  mime: string;
}

/** The result as a file body: the text to show, copy or download. */
export function serializeOutput(value: unknown, format: ResolvedFormat): SerializedOutput {
  if (format === 'json') {
    return { text: value === undefined ? '' : JSON.stringify(value, null, 2), extension: 'json', mime: 'application/json' };
  }
  const text = value === undefined || value === null
    ? ''
    : typeof value === 'string'
      ? value
      : JSON.stringify(value, null, 2);
  return format === 'markdown'
    ? { text, extension: 'md', mime: 'text/markdown' }
    : { text, extension: 'txt', mime: 'text/plain' };
}

function slug(text: string): string {
  return text.trim().replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'output';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `<workflow>-<output>-<local timestamp>.<ext>` — sortable, and two runs never collide. */
export function outputFilename(workflowName: string, label: string, extension: string, at: Date = new Date()): string {
  const stamp =
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${slug(workflowName)}-${slug(label)}-${stamp}.${extension}`;
}

/** A single-line glimpse of the value for the node card. */
export function previewOf(value: unknown, maxChars = 140): string {
  const { text } = serializeOutput(value, resolveFormat(value, 'auto'));
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1).trimEnd()}…` : flat;
}
