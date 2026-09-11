import type { ChatMessage, ChatToolCall } from '@maestroai/shared';
import type { ToolActivity } from '../../stores/chatStore';
import { Markdown } from './Markdown';
import { Meta, Reasoning, assistantMeta } from './MessageBubble';
import { formatLatency, prettyJson, truncate } from './format';

interface ToolTurnCardProps {
  /** An assistant message that called tools. */
  message: ChatMessage;
  /** Stored tool results of the thread, by tool call id. */
  results: Map<string, ChatMessage>;
  /** Live status of calls whose result is not stored yet. */
  activity: ToolActivity[];
}

type Status = 'pending' | 'running' | 'ok' | 'error';

const statusStyle: Record<Status, string> = {
  pending: 'text-slate-500',
  running: 'text-blue-300 animate-pulse',
  ok: 'text-emerald-300',
  error: 'text-red-300'
};

const statusLabel: Record<Status, string> = {
  pending: 'queued',
  running: 'running…',
  ok: 'ok',
  error: 'error'
};

/** An assistant turn that called tools: its text, then one row per call with the result. */
export function ToolTurnCard({ message, results, activity }: ToolTurnCardProps) {
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[85%] min-w-0 rounded-lg px-4 py-3 border bg-slate-900 border-slate-800 space-y-2">
        {message.reasoning && <Reasoning text={message.reasoning} />}
        {message.content && <Markdown text={message.content} />}
        {(message.toolCalls ?? []).map((call) => (
          <ToolCallRow
            key={call.id}
            call={call}
            result={results.get(call.id)}
            live={activity.find((entry) => entry.callId === call.id)}
          />
        ))}
        <Meta items={assistantMeta(message)} />
      </div>
    </div>
  );
}

function ToolCallRow({ call, result, live }: { call: ChatToolCall; result?: ChatMessage; live?: ToolActivity }) {
  const status: Status = result ? (result.error ? 'error' : 'ok') : live ? live.status : 'pending';
  const durationMs = result?.latencyMs ?? live?.durationMs;

  return (
    <details className="rounded border border-slate-800 bg-slate-950/60 text-xs">
      <summary className="cursor-pointer select-none px-3 py-1.5 flex items-center gap-2 min-w-0">
        <span className="font-mono text-slate-200 shrink-0">{call.function.name}</span>
        <span className="font-mono text-slate-500 truncate">{truncate(call.function.arguments, 80)}</span>
        <span className="ml-auto flex items-center gap-2 whitespace-nowrap shrink-0">
          {durationMs !== undefined && <span className="text-slate-500">{formatLatency(durationMs)}</span>}
          <span className={statusStyle[status]}>{statusLabel[status]}</span>
        </span>
      </summary>
      <div className="border-t border-slate-800 px-3 py-2 space-y-2">
        <div>
          <div className="text-slate-500 mb-1">Arguments</div>
          <pre className="whitespace-pre-wrap break-words font-mono text-slate-300">{prettyJson(call.function.arguments)}</pre>
        </div>
        {result && (
          <div>
            <div className="text-slate-500 mb-1">{result.error ? `Result (${result.error})` : 'Result'}</div>
            <pre
              className={`whitespace-pre-wrap break-words font-mono max-h-64 overflow-y-auto ${
                result.error ? 'text-red-200' : 'text-slate-300'
              }`}
            >
              {result.content}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}
