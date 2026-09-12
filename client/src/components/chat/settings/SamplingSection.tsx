import type { ChatModel, ChatParams, ChatParamsPatch, OpenRouterSampling } from '@joseki/shared';
import { SettingsSection } from './SettingsSection';
import { NumberField, countSet } from './fields';

interface Control {
  key: keyof OpenRouterSampling;
  /** The parameter name the catalog lists under `supportedParameters`. */
  wire: string;
  label: string;
  hint: string;
  min?: number;
  max?: number;
  step: number;
  integer?: boolean;
}

const CONTROLS: Control[] = [
  { key: 'topK', wire: 'top_k', label: 'Top-k', hint: 'integer · 0 = off', min: 0, step: 1, integer: true },
  { key: 'minP', wire: 'min_p', label: 'Min-p', hint: '0–1', min: 0, max: 1, step: 0.01 },
  { key: 'topA', wire: 'top_a', label: 'Top-a', hint: '0–1', min: 0, max: 1, step: 0.01 },
  { key: 'repetitionPenalty', wire: 'repetition_penalty', label: 'Repetition penalty', hint: '1 = none', min: 0, max: 2, step: 0.01 },
  { key: 'seed', wire: 'seed', label: 'Seed', hint: 'integer', step: 1, integer: true }
];

interface SamplingSectionProps {
  /** The settings in view — a conversation's, or a prompt node's. */
  params: ChatParams;
  model: ChatModel | undefined;
  onChange: (patch: ChatParamsPatch) => void;
}

/** The sampling knobs beyond the OpenAI set, each shown only when the model lists it. */
export function SamplingSection({ params, model, onChange }: SamplingSectionProps) {
  const sampling = params.sampling ?? {};
  // An unknown model (not in the catalog) cannot be gated — show everything.
  const supported = CONTROLS.filter((control) => !model || model.supportedParameters.includes(control.wire));

  return (
    <SettingsSection
      title="Sampling"
      count={countSet(sampling)}
      onReset={() => onChange({ sampling: null })}
      note={
        supported.length === 0
          ? 'This model accepts none of the extra sampling controls.'
          : !model
            ? 'Model not in the catalog — controls are ungated.'
            : undefined
      }
    >
      {supported.map((control) => (
        <NumberField
          key={control.key}
          label={control.label}
          hint={control.hint}
          value={sampling[control.key]}
          min={control.min}
          max={control.max}
          step={control.step}
          integer={control.integer}
          onCommit={(value) => onChange({ sampling: { [control.key]: value } })}
        />
      ))}
    </SettingsSection>
  );
}
