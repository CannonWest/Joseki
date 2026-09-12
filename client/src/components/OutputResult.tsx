import { useEffect, useState } from 'react';
import type { OutputFormat } from '@joseki/shared';
import { Markdown } from './chat/Markdown';
import { OUTPUT_FORMATS, outputFilename, resolveFormat, serializeOutput } from '../output/format';

interface OutputResultProps {
  value: unknown;
  format: OutputFormat | undefined;
  onFormatChange: (format: OutputFormat) => void;
  workflowName: string;
  label: string;
}

/**
 * The result an output node produced on the last run: rendered by format,
 * with the ways to take it — copy it, or download it as a file.
 */
export function OutputResult({ value, format, onFormatChange, workflowName, label }: OutputResultProps) {
  const resolved = resolveFormat(value, format);
  const serialized = serializeOutput(value, resolved);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    await navigator.clipboard.writeText(serialized.text);
    setCopied(true);
  };

  // Same mechanism as the workflow Export button.
  const download = () => {
    const blob = new Blob([serialized.text], { type: serialized.mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = outputFilename(workflowName, label, serialized.extension);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3" data-testid="output-result">
      <div className="flex items-center gap-2">
        <select
          value={format ?? 'auto'}
          onChange={(e) => onFormatChange(e.target.value as OutputFormat)}
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
          title={OUTPUT_FORMATS.find((f) => f.value === (format ?? 'auto'))?.hint}
        >
          {OUTPUT_FORMATS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}{f.value === 'auto' ? ` (${resolved})` : ''}
            </option>
          ))}
        </select>
        <span className="text-xs text-slate-500">{serialized.text.length.toLocaleString()} chars</span>
        <div className="flex-1" />
        <button
          onClick={copy}
          className="px-2 py-1 text-xs bg-slate-800 text-slate-300 hover:bg-slate-700 rounded transition-colors"
          title="Copy the result to the clipboard"
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
        <button
          onClick={download}
          className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
          title={`Download as .${serialized.extension}`}
        >
          ⇩ Download .{serialized.extension}
        </button>
      </div>

      <div className="bg-slate-800/60 border border-slate-700 rounded p-3 max-h-[60vh] overflow-auto text-sm text-slate-200">
        {serialized.text === '' ? (
          <span className="text-slate-500 italic">The output was empty.</span>
        ) : resolved === 'markdown' ? (
          <Markdown text={serialized.text} />
        ) : (
          <pre className="whitespace-pre-wrap font-mono text-xs">{serialized.text}</pre>
        )}
      </div>
    </div>
  );
}
