"use client";

import { useId, type ReactNode } from "react";
import { Check } from "lucide-react";

import { Banner } from "@/components/banner";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { CLEAR_API_KEY_VALUE, type IntervalsField } from "../_lib/intervals-state";
import type {
  IntervalsApiKeyState,
  IntervalsFormValues,
} from "../_lib/intervals-values";

/**
 * Les deux champs intervals.icu, avec leur mode d'emploi.
 *
 * Un seul composant pour les deux moments — la création du profil et son
 * édition — parce que le mode d'emploi doit être le même : une installation
 * neuve n'a aucun moyen de deviner où se trouvent ces valeurs, et une
 * ressaisie six mois plus tard non plus.
 *
 * Il est **contrôlé** : c'est le formulaire parent qui tient l'état, parce que
 * lui seul sait quand vider la saisie de clé (après un enregistrement réussi).
 * React réinitialiserait de toute façon un formulaire non contrôlé à la fin de
 * l'action, et la saisie serait perdue au moindre message de validation.
 *
 * **La clé enregistrée n'arrive jamais jusqu'ici** : le composant ne reçoit que
 * son état (`apiKeyState`). Le champ de saisie part vide et le reste tant que
 * personne ne tape.
 */

/**
 * Le mode d'emploi, réduit à des repères stables.
 *
 * Volontairement sans intitulé exact de l'interface d'intervals.icu : ces
 * libellés changent, et un mode d'emploi faux est pire que pas de mode d'emploi.
 */
const HINTS = {
  athleteId:
    "Facultatif : la clé seule suffit. Sur intervals.icu, il apparaît dans l'URL de ton compte et dans tes réglages — un « i » suivi de chiffres, par exemple i671024.",
  apiKey:
    "Dans les réglages de ton compte intervals.icu, section réservée aux développeurs, tout en bas de la page.",
  clear:
    "L'identifiant reste enregistré ; seul le rapatriement automatique s'arrête.",
} as const;

/** Ce que l'écran dit d'une clé déjà en base — un état, jamais une valeur. */
const KEY_STATE_NOTICE: Record<
  Exclude<IntervalsApiKeyState, "absent">,
  { tone: "neutral" | "negative"; title: string; detail: string }
> = {
  configured: {
    tone: "neutral",
    title: "Une clé API est enregistrée.",
    detail:
      "Elle n'est jamais réaffichée, même en partie. Laisse le champ vide pour la conserver, saisis-en une nouvelle pour la remplacer.",
  },
  unreadable: {
    tone: "negative",
    title: "La clé enregistrée n'est plus lisible.",
    detail:
      "Le secret de chiffrement de l'application a changé depuis son enregistrement : la clé est définitivement illisible et l'import automatique est à l'arrêt. Ressaisis-la ci-dessous pour repartir.",
  },
};

/** Concatène les `id` de description d'un champ, en écartant ceux qui n'existent pas. */
function describedBy(...ids: (string | false)[]): string | undefined {
  const kept = ids.filter((id) => id !== false);
  return kept.length > 0 ? kept.join(" ") : undefined;
}

/**
 * Un champ : libellé, mode d'emploi, saisie, erreur.
 *
 * **`text-base` n'est pas décoratif** : en dessous de 16 px, iOS zoome à la
 * prise de focus, et en PWA `standalone` aucun geste ne ramène en arrière.
 */
function IntervalsFieldRow({
  id,
  name,
  label,
  hint,
  error,
  type,
  value,
  onChange,
  optional,
}: {
  id: string;
  name: string;
  label: string;
  hint: string;
  error?: string;
  type: "text" | "password";
  value: string;
  onChange: (value: string) => void;
  optional?: boolean;
}) {
  return (
    <div className="min-w-0">
      <label
        htmlFor={id}
        className="flex flex-wrap items-baseline gap-x-2 text-[0.85rem] font-medium text-fg"
      >
        {label}
        {optional ? (
          <span className="text-[0.72rem] font-normal text-fg-faint">
            facultatif
          </span>
        ) : null}
      </label>
      <p id={`${id}-hint`} className="mt-1 text-[0.76rem] leading-snug text-fg-faint">
        {hint}
      </p>
      <Input
        id={id}
        name={name}
        type={type}
        // `off` sur les deux : un gestionnaire de mots de passe n'a rien à faire
        // d'une clé d'API, et il la proposerait ensuite sur d'autres formulaires.
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(
          `${id}-hint`,
          Boolean(error) && `${id}-error`,
        )}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 text-base sm:max-w-sm"
      />
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-[0.76rem] leading-snug text-negative">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Case « effacer la clé enregistrée ».
 *
 * La case native est masquée et le focus reporté sur l'étiquette entière, comme
 * les choix de sexe du formulaire de profil — sans quoi le focus clavier
 * disparaîtrait.
 */
function ClearKeyCheckbox({
  id,
  checked,
  onChange,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="min-w-0">
      <label
        htmlFor={id}
        className={cn(
          "flex cursor-pointer items-start gap-2.5 rounded-button border px-3 py-2.5 text-[0.85rem]",
          "transition-colors duration-150 ease-out",
          "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
          checked
            ? "border-accent bg-accent-soft text-fg"
            : "border-border bg-surface-2 text-fg-muted hover:border-fg-faint/35",
        )}
      >
        <input
          id={id}
          type="checkbox"
          name="clearApiKey"
          value={CLEAR_API_KEY_VALUE}
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          aria-describedby={`${id}-hint`}
          className="sr-only"
        />
        <span
          aria-hidden="true"
          className={cn(
            "mt-px flex size-[1.05rem] shrink-0 items-center justify-center rounded-[5px] border",
            checked ? "border-accent bg-accent text-bg" : "border-fg-faint",
          )}
        >
          {checked ? <Check strokeWidth={3} className="size-3" /> : null}
        </span>
        <span className="min-w-0">Effacer la clé enregistrée</span>
      </label>
      <p id={`${id}-hint`} className="mt-1.5 text-[0.76rem] leading-snug text-fg-faint">
        {HINTS.clear}
      </p>
    </div>
  );
}

export type IntervalsFieldsProps = {
  /** État de la clé en base — jamais sa valeur. */
  apiKeyState: IntervalsApiKeyState;
  values: IntervalsFormValues;
  onChange: (values: IntervalsFormValues) => void;
  errors?: Partial<Record<IntervalsField, string>>;
  /** Le cadrage du bloc, qui diffère entre la création du profil et son édition. */
  intro: ReactNode;
};

export function IntervalsFields({
  apiKeyState,
  values,
  onChange,
  errors,
  intro,
}: IntervalsFieldsProps) {
  const uid = useId();
  const notice = apiKeyState === "absent" ? null : KEY_STATE_NOTICE[apiKeyState];

  const setField = <K extends keyof IntervalsFormValues>(
    field: K,
    value: IntervalsFormValues[K],
  ) => onChange({ ...values, [field]: value });

  return (
    <div className="flex flex-col gap-5">
      <p className="text-[0.82rem] leading-relaxed text-fg-muted">{intro}</p>

      {notice ? (
        <Banner tone={notice.tone} title={notice.title}>
          {notice.detail}
        </Banner>
      ) : null}

      <IntervalsFieldRow
        id={`${uid}-athlete-id`}
        name="intervalsAthleteId"
        label="Identifiant d'athlète"
        hint={HINTS.athleteId}
        error={errors?.intervalsAthleteId}
        type="text"
        value={values.intervalsAthleteId}
        onChange={(value) => setField("intervalsAthleteId", value)}
        optional
      />

      <IntervalsFieldRow
        id={`${uid}-api-key`}
        name="apiKey"
        label={apiKeyState === "absent" ? "Clé API" : "Nouvelle clé API"}
        hint={HINTS.apiKey}
        error={errors?.apiKey}
        type="password"
        value={values.apiKey}
        onChange={(value) => setField("apiKey", value)}
        optional={apiKeyState === "absent"}
      />

      {/* Rien à effacer tant qu'aucune clé n'est enregistrée. */}
      {apiKeyState === "absent" ? null : (
        <ClearKeyCheckbox
          id={`${uid}-clear-key`}
          checked={values.clearApiKey}
          onChange={(checked) => setField("clearApiKey", checked)}
        />
      )}
    </div>
  );
}
