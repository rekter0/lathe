import {
  validatePayloadTransformParameters,
  type PayloadTransformDefinition
} from "@lathe/payloads";
import { Field, Input, Select } from "./forms.js";

export interface PayloadTransformParameterFieldsProps {
  definition: PayloadTransformDefinition;
  value: Readonly<Record<string, string>>;
  onChange(value: Record<string, string>): void;
  disabled?: boolean;
  compact?: boolean;
}

export function PayloadTransformParameterFields({
  definition,
  value,
  onChange,
  disabled = false,
  compact = false
}: PayloadTransformParameterFieldsProps) {
  if (definition.parameterSchema.mode === "none") return null;
  if (definition.parameterSchema.mode === "variables") {
    return <p className="payload-transform-parameter-note">Uses the workbench variable overrides as its exact parameter record.</p>;
  }

  const validation = validatePayloadTransformParameters(definition.id, value);
  const update = (name: string, nextValue: string) => onChange({ ...value, [name]: nextValue });
  return <div className={`payload-transform-parameters${compact ? " compact" : ""}`}>
    {definition.parameterSchema.fields.map((parameter) => {
      const current = value[parameter.name] ?? definition.parameterDefaults[parameter.name] ?? parameter.defaultValue ?? "";
      if (parameter.type === "enum") {
        return <Field key={parameter.name} label={parameter.label} hint={parameter.description}>
          <Select disabled={disabled} value={current} onChange={(event) => update(parameter.name, event.target.value)}>
            {parameter.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
        </Field>;
      }
      if (parameter.type === "boolean") {
        return <label className="payload-transform-boolean" key={parameter.name}>
          <input disabled={disabled} type="checkbox" checked={current === "true"} onChange={(event) => update(parameter.name, String(event.target.checked))} />
          <span><strong>{parameter.label}</strong><small>{parameter.description}</small></span>
        </label>;
      }
      return <Field key={parameter.name} label={parameter.label} hint={parameter.description}>
        <Input
          disabled={disabled}
          type={parameter.type === "integer" ? "number" : "text"}
          {...(parameter.minimum === undefined ? {} : { min: parameter.minimum })}
          {...(parameter.maximum === undefined ? {} : { max: parameter.maximum })}
          {...(parameter.type === "integer" ? { step: 1 } : {})}
          value={current}
          onChange={(event) => update(parameter.name, event.target.value)}
        />
      </Field>;
    })}
    {!validation.valid && <div className="payload-transform-parameter-errors" role="alert">{validation.errors.map((error) => <p key={error}>{error}</p>)}</div>}
  </div>;
}
