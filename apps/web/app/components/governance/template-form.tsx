// The template picker + parameter form (M7.4 §2.3, app-spec §8.7).
//
// PROPOSAL CREATION IS TEMPLATE-SCOPED, not free-form. §8.7 and the boundary
// doc are explicit: the rich proposal workflow is the App's and free-form
// message building stays a Console strength. So this form offers the program's
// own admin actions and their declared parameters — there is no field here in
// which to type a type URL or a JSON payload, by design.
//
// NUMERIC ENTRY IS REJECT-NEVER-CLAMP, the repo-standard rule. A value outside
// a contract bound is shown as an error the proposer must fix; nothing is
// quietly moved into range, because a clamped bps would submit a governance
// proposal for a number nobody chose.

import { Button } from "~/components/ui/button";
import {
  defaultWireValues,
  MAX_PAUSE_REASON_LEN,
  PROPOSAL_TEMPLATES,
  templateById,
  type ProposalTemplate,
  type TemplateParam,
  type WireTemplateValues,
} from "~/governance/templates";
import { t, type Locale } from "~/i18n";

export interface TemplateFormProps {
  locale: Locale;
  templateId: string;
  onTemplateChange: (id: string) => void;
  /** Wire-shaped values (`string | boolean`), the form's own state. */
  values: WireTemplateValues;
  onValuesChange: (values: WireTemplateValues) => void;
  /** Per-field error text, keyed by parameter. Localized by the caller. */
  errors: Readonly<Record<string, string>>;
}

/** Which optional parameters the proposer has chosen to change. Derived from
 * the values themselves — a key present IS the choice, which keeps the form's
 * state and the message's shape from being two different facts. */
function isSupplied(values: WireTemplateValues, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(values, key);
}

function ParamField({
  locale,
  template,
  param,
  values,
  onValuesChange,
  error,
}: {
  locale: Locale;
  template: ProposalTemplate;
  param: TemplateParam;
  values: WireTemplateValues;
  onValuesChange: (values: WireTemplateValues) => void;
  error: string | undefined;
}) {
  const supplied = isSupplied(values, param.key);
  const setValue = (value: string | boolean) => onValuesChange({ ...values, [param.key]: value });
  const remove = () => {
    const next = { ...values };
    delete next[param.key];
    onValuesChange(next);
  };

  return (
    <div className="flex flex-col gap-1 border-t pt-3">
      {template.optionalParams ? (
        // The include toggle IS the "only supplied fields change" semantics
        // made visible: an unchecked field is absent from the message, not
        // present with its current value.
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={supplied}
            onChange={(event) =>
              event.target.checked ? setValue(param.kind === "bool" ? false : "") : remove()
            }
          />
          <span>
            {t(locale, param.labelKey)}{" "}
            <span className="text-xs text-muted-foreground">
              ({t(locale, "governance.param-include")})
            </span>
          </span>
        </label>
      ) : (
        <span className="text-sm">{t(locale, param.labelKey)}</span>
      )}

      {supplied || !template.optionalParams ? (
        <>
          {param.kind === "bool" ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={values[param.key] === true}
                onChange={(event) => setValue(event.target.checked)}
              />
              <span>{t(locale, param.labelKey)}</span>
            </label>
          ) : param.kind === "text" ? (
            <input
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              maxLength={param.maxLength}
              value={typeof values[param.key] === "string" ? (values[param.key] as string) : ""}
              onChange={(event) => setValue(event.target.value)}
              aria-label={t(locale, param.labelKey)}
            />
          ) : (
            <input
              className="w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
              inputMode="numeric"
              value={typeof values[param.key] === "string" ? (values[param.key] as string) : ""}
              onChange={(event) => setValue(event.target.value)}
              aria-label={t(locale, param.labelKey)}
            />
          )}
          <span className="text-xs text-muted-foreground">
            {param.kind === "uint"
              ? t(locale, "governance.param-range", {
                  min: param.min.toString(),
                  max: param.max.toString(),
                })
              : param.kind === "text"
                ? t(locale, "governance.param-length-range", {
                    min: String(param.minLength),
                    max: String(param.maxLength),
                  })
                : ""}
          </span>
          {error === undefined ? null : (
            <span className="text-xs" style={{ color: "var(--status-critical)" }} role="alert">
              {error}
            </span>
          )}
        </>
      ) : null}
    </div>
  );
}

export function TemplateForm({
  locale,
  templateId,
  onTemplateChange,
  values,
  onValuesChange,
  errors,
}: TemplateFormProps) {
  const template = templateById(templateId);

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{t(locale, "governance.template-picker-label")}</span>
        <div className="flex flex-wrap gap-2">
          {PROPOSAL_TEMPLATES.map((entry) => (
            <Button
              key={entry.id}
              variant={entry.id === templateId ? "default" : "ghost"}
              onClick={() => {
                onTemplateChange(entry.id);
                // Values do not survive a template change: a parameter of one
                // action is meaningless on another, and carrying it over would
                // silently build a message the proposer did not compose. The
                // new template's REQUIRED parameters are seeded; its optional
                // ones are not, because absent is their meaningful default.
                onValuesChange(defaultWireValues(entry.id));
              }}
            >
              {t(locale, entry.labelKey)}
            </Button>
          ))}
        </div>
        {/* An ABSENT template is stated, not stubbed as a disabled control
            (§7 Q1): a disabled entry invites "when", and §14.3 has no answer. */}
        <p className="text-xs text-muted-foreground">
          {t(locale, "governance.template-no-bridge-note")}
        </p>
      </div>

      {template === null ? null : (
        <div className="flex flex-col gap-2">
          {template.params.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {template.summaryKeys.map((key) => t(locale, key)).join(" ")}
            </p>
          ) : (
            template.params.map((param) => (
              <ParamField
                key={param.key}
                locale={locale}
                template={template}
                param={param}
                values={values}
                onValuesChange={onValuesChange}
                error={errors[param.key]}
              />
            ))
          )}
          {template.id === "pause_vault" ? (
            <p className="text-xs text-muted-foreground">
              {t(locale, "governance.param-length-range", {
                min: "1",
                max: String(MAX_PAUSE_REASON_LEN),
              })}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
