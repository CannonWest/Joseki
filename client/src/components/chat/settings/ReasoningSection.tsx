import type { ChatModel, ChatParams, ChatParamsPatch, ReasoningEffort } from '@joseki/shared';
import { SettingsSection } from './SettingsSection';
import { NumberField, SelectField, Toggle, countSet } from './fields';

const ALL_EFFORTS: ReasoningEffort[] = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'];
const DEFAULT_BUDGET = 4096;

interface ReasoningSectionProps {
  /** The settings in view — a conversation's, or a prompt node's. */
  params: ChatParams;
  model: ChatModel | undefined;
  onChange: (patch: ChatParamsPatch) => void;
}

/**
 * Reasoning controls, gated by what the catalog says about the model: its
 * efforts, whether it takes a token budget, whether it can be turned off at
 * all. "Model default" sends nothing — the server fills in the advertised
 * effort per turn — so the hint derives that from the catalog record.
 */
export function ReasoningSection({ params, model, onChange }: ReasoningSectionProps) {
  const reasoning = params.reasoning ?? {};
  const capability = model?.reasoning;
  const count = countSet(reasoning);
  const reset = () => onChange({ reasoning: null });

  if (model && !capability) {
    return (
      <SettingsSection
        title="Reasoning"
        count={count}
        onReset={reset}
        note={count > 0 ? 'This model does not reason — the stored settings are ignored.' : 'This model does not reason.'}
      />
    );
  }

  const efforts = capability?.supportedEfforts?.length ? capability.supportedEfforts : ALL_EFFORTS;
  const budgetAllowed = !model || capability?.supportsMaxTokens === true;
  const mandatory = capability?.mandatory === true;
  const defaultEffort = capability?.defaultEffort;

  const mode: string =
    reasoning.enabled === false
      ? 'off'
      : (reasoning.maxTokens ?? 0) > 0
        ? 'budget'
        : (reasoning.effort ?? '');

  const options = [
    { value: '', label: defaultEffort ? `Model default (${defaultEffort})` : 'Gateway default' },
    ...efforts.map((effort) => ({ value: effort, label: effort })),
    ...(mode && mode !== 'off' && mode !== 'budget' && !efforts.includes(mode as ReasoningEffort)
      ? [{ value: mode, label: `${mode} (not listed for this model)` }]
      : []),
    ...(budgetAllowed || mode === 'budget' ? [{ value: 'budget', label: 'Token budget' }] : []),
    ...(mandatory ? [] : [{ value: 'off', label: 'Off' }])
  ];

  const setMode = (value: string) => {
    if (value === '') onChange({ reasoning: { effort: null, maxTokens: null, enabled: null } });
    else if (value === 'off') onChange({ reasoning: { enabled: false, effort: null, maxTokens: null } });
    else if (value === 'budget') {
      const budget = reasoning.maxTokens && reasoning.maxTokens > 0 ? reasoning.maxTokens : DEFAULT_BUDGET;
      onChange({ reasoning: { maxTokens: budget, effort: null, enabled: null } });
    } else onChange({ reasoning: { effort: value as ReasoningEffort, maxTokens: null, enabled: null } });
  };

  const hint =
    mode === ''
      ? mandatory
        ? 'This model always reasons.'
        : capability?.defaultEnabled === false && defaultEffort
          ? `On by default at ${defaultEffort} — without it this model does not reason.`
          : defaultEffort
            ? `On by default at ${defaultEffort}.`
            : undefined
      : mode === 'off'
        ? 'Reasoning is off.'
        : mode === 'budget'
          ? 'A budget beats an effort; max tokens grows to leave room for it.'
          : undefined;

  return (
    <SettingsSection
      title="Reasoning"
      count={count}
      onReset={reset}
      note={model ? undefined : 'Model not in the catalog — controls are ungated.'}
    >
      <SelectField label="Effort" value={mode} options={options} onChange={setMode} />
      {hint && <p className="text-xs text-slate-500 -mt-1">{hint}</p>}
      {mode === 'budget' && (
        <NumberField
          label="Thinking budget"
          hint="1024–128000 tokens"
          value={reasoning.maxTokens}
          min={1024}
          max={128000}
          step={256}
          integer
          onCommit={(value) => onChange({ reasoning: { maxTokens: value } })}
        />
      )}
      <Toggle
        label="Hide the trace"
        description="Think, but leave the reasoning out of the reply"
        checked={reasoning.exclude === true}
        onChange={(on) => onChange({ reasoning: { exclude: on ? true : null } })}
      />
    </SettingsSection>
  );
}
