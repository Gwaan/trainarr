"use client";

import {
  useActionState,
  useId,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Loader2 } from "lucide-react";

import { Banner } from "@/components/banner";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { MaxHrSuggestionCard } from "../../_components/max-hr-suggestion-card";
import { RestingHrSuggestionCard } from "../../_components/resting-hr-suggestion-card";
import type { MaxHrSuggestionView } from "../../_lib/max-hr-suggestion";
import type { RestingHrSuggestionView } from "../../_lib/resting-hr-suggestion";

import { saveProfileAction, type ProfileFormState } from "../_lib/actions";
import { SEX_CHOICES, type ProfileFormValues } from "../_lib/form-values";
import { EMPTY_INTERVALS_FORM_VALUES } from "../_lib/intervals-values";

import { IntervalsFields } from "./intervals-fields";

/**
 * Formulaire de profil — le même à l'onboarding et à l'édition : les champs sont
 * identiques, seuls l'intention et le libellé de l'action changent.
 *
 * Chaque champ physiologique dit à quoi il sert : le renseigner est un choix
 * éclairé, pas une case à cocher. Les champs sont contrôlés parce que React
 * réinitialise un formulaire non contrôlé une fois l'action terminée — la
 * saisie serait perdue au moindre message de validation.
 */

const HINTS = {
  displayName: "Il sert à t'accueillir sur le tableau de bord.",
  sex: "Les coefficients du modèle de charge (Banister) diffèrent — sans cette info, la charge n'est pas calculée.",
  heartRate:
    "La FC max et la FC de repos permettent de calculer ta charge d'entraînement (TRIMP). La FC max sert aussi à prescrire tes séances d'endurance en zone cardiaque plutôt qu'en allure — indique-la mesurée, jamais estimée depuis ton âge.",
  weightKg:
    "Enregistré pour en suivre l'évolution ; aucun calcul actuel ne s'en sert.",
  birthDate:
    "Repère d'âge pour la lecture de tes séances ; aucun calcul actuel ne s'en sert.",
} as const;

/**
 * Cadrage du bloc intervals.icu à la création.
 *
 * Il dit ce qu'on perd à laisser ces champs vides — l'import automatique — et
 * qu'on peut y revenir : sans ça, une installation neuve croirait le
 * rapatriement acquis, ou se croirait engagée à le configurer tout de suite.
 */
const INTERVALS_ONBOARDING_INTRO =
  "Trainarr rapatrie tes séances depuis intervals.icu, où HealthFit les dépose. Sans clé API, l'import automatique ne démarre pas : il reste le dépôt manuel d'un fichier FIT depuis la page « Activités ». Tu peux laisser ces champs vides et les renseigner plus tard, depuis cette même page.";

/** Rien à afficher tant que le formulaire n'a pas été soumis. */
const INITIAL_STATE: ProfileFormState = { status: "idle" };

/** Repli si l'action échoue sans message — elle en fournit un dans tous ses cas connus. */
const GENERIC_FAILURE = "Le profil n'a pas été enregistré.";

/** Concatène les `id` de description d'un champ, en écartant ceux qui n'existent pas. */
function describedBy(...ids: (string | false)[]): string | undefined {
  const kept = ids.filter((id) => id !== false);
  return kept.length > 0 ? kept.join(" ") : undefined;
}

function FieldError({ id, message }: { id: string; message: string }) {
  return (
    <p id={id} className="mt-1.5 text-[0.76rem] leading-snug text-negative">
      {message}
    </p>
  );
}

function OptionalTag() {
  return (
    <span className="text-[0.72rem] font-normal text-fg-faint">facultatif</span>
  );
}

/** Trame commune d'un champ : libellé, ligne d'aide, saisie, erreur. */
function Field({
  id,
  label,
  hint,
  error,
  optional,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  error?: string;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <label
        htmlFor={id}
        className="flex flex-wrap items-baseline gap-x-2 text-[0.85rem] font-medium text-fg"
      >
        {label}
        {optional ? <OptionalTag /> : null}
      </label>
      <p id={`${id}-hint`} className="mt-1 text-[0.76rem] leading-snug text-fg-faint">
        {hint}
      </p>
      <div className="mt-2">{children}</div>
      {error ? <FieldError id={`${id}-error`} message={error} /> : null}
    </div>
  );
}

/**
 * Saisie chiffrée : mono, largeur ajustée au nombre de chiffres, unité suffixée.
 * L'unité affichée est décorative ; sa version lisible porte l'`id` `<id>-unit`,
 * que l'appelant ajoute à `aria-describedby`.
 *
 * **`text-base` n'est pas décoratif** : en dessous de 16 px, iOS zoome à la
 * prise de focus, et en PWA `standalone` aucun geste ne ramène en arrière. Il
 * l'emporte donc sur la taille par défaut de `Input`.
 */
function NumberInput({
  id,
  unit,
  unitLabel,
  className,
  ...props
}: Omit<ComponentProps<typeof Input>, "id"> & {
  id: string;
  unit: string;
  unitLabel: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <Input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        {...props}
        className="num pr-12 text-base"
      />
      <span
        aria-hidden="true"
        className="num pointer-events-none absolute inset-y-0 right-3 flex items-center text-[0.78rem] text-fg-faint"
      >
        {unit}
      </span>
      <span id={`${id}-unit`} className="sr-only">
        {unitLabel}
      </span>
    </div>
  );
}

export type ProfileFormProps = {
  /** `onboarding` : aucun profil en base — c'est une création. */
  mode: "onboarding" | "edit";
  values: ProfileFormValues;
  /**
   * Une FC max plus haute que celle du profil, observée sur une séance
   * importée. `null` s'il n'y a rien à proposer — et il n'y a jamais rien à
   * proposer à l'onboarding, où aucune séance n'est encore rattachée.
   */
  maxHrSuggestion?: MaxHrSuggestionView | null;
  /**
   * Une FC de repos médiane qui s'écarte de celle du profil, mesurée par la
   * montre. `null` s'il n'y a rien à proposer — et rien à l'onboarding, où aucun
   * relevé n'a encore été rapatrié. Indépendante de la précédente : les deux
   * encarts peuvent s'afficher ensemble.
   */
  restingHrSuggestion?: RestingHrSuggestionView | null;
};

export function ProfileForm({
  mode,
  values,
  maxHrSuggestion = null,
  restingHrSuggestion = null,
}: ProfileFormProps) {
  const [state, formAction, isPending] = useActionState(
    saveProfileAction,
    INITIAL_STATE,
  );
  const [fields, setFields] = useState(values);
  // Les identifiants intervals.icu ne voyagent avec le profil qu'à la création :
  // en édition, ils ont leur propre panneau et leur propre action, et ce
  // formulaire ne les porte pas (il les effacerait à chaque enregistrement).
  const [intervals, setIntervals] = useState(EMPTY_INTERVALS_FORM_VALUES);
  const uid = useId();

  const fieldId = (name: keyof ProfileFormValues) => `${uid}-${name}`;
  const setField = (name: keyof ProfileFormValues, value: string) =>
    setFields((current) => ({ ...current, [name]: value }));

  const errors = state.fieldErrors;
  const hasFeedback = state.status !== "idle";

  const sexHintId = `${uid}-sex-hint`;
  const heartRateHintId = `${uid}-heart-rate-hint`;

  return (
    <form
      action={formAction}
      // La validation est celle de l'action : mêmes messages, même endroit et
      // même ton pour tous les champs, plutôt que des bulles natives.
      noValidate
      className="flex flex-col gap-4 sm:gap-5"
    >
      {/*
        Région live permanente : elle doit exister avant la mise à jour pour que
        le retour d'action soit annoncé. Sans message, `sr-only` la sort du flux
        (position absolue), donc de l'espacement de la colonne.
      */}
      <div aria-live="polite" className={hasFeedback ? undefined : "sr-only"}>
        {state.status === "success" ? (
          // Le message peut annoncer la reprise des imports en attente : il est
          // affiché tel quel, c'est l'action qui sait ce qu'elle a déclenché.
          <Banner tone="positive" title={state.message ?? "Profil enregistré."} />
        ) : null}
        {state.status === "error" ? (
          <Banner tone="negative" title={state.message ?? GENERIC_FAILURE} />
        ) : null}
      </div>

      <Panel title="Identité">
        <div className="flex flex-col gap-5">
          <Field
            id={fieldId("displayName")}
            label="Prénom"
            hint={HINTS.displayName}
            error={errors?.displayName}
          >
            <Input
              id={fieldId("displayName")}
              name="displayName"
              type="text"
              autoComplete="given-name"
              aria-required="true"
              aria-invalid={errors?.displayName ? true : undefined}
              aria-describedby={describedBy(
                `${fieldId("displayName")}-hint`,
                Boolean(errors?.displayName) && `${fieldId("displayName")}-error`,
              )}
              value={fields.displayName}
              onChange={(event) => setField("displayName", event.target.value)}
              // `text-base` : sous 16 px, iOS zoome à la prise de focus.
              className="text-base sm:max-w-xs"
            />
          </Field>

          <fieldset
            className="min-w-0"
            aria-describedby={describedBy(
              sexHintId,
              Boolean(errors?.sex) && `${fieldId("sex")}-error`,
            )}
          >
            <legend className="text-[0.85rem] font-medium text-fg">Sexe</legend>
            <p
              id={sexHintId}
              className="mt-1 text-[0.76rem] leading-snug text-fg-faint"
            >
              {HINTS.sex}
            </p>

            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {SEX_CHOICES.map((choice) => {
                const checked = fields.sex === choice.value;

                return (
                  <label
                    key={choice.label}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-button border px-3 py-2.5 text-[0.85rem]",
                      "transition-colors duration-150 ease-out",
                      // Le radio natif est masqué : le focus clavier est reporté
                      // sur l'étiquette entière, sans quoi il disparaîtrait.
                      "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
                      checked
                        ? "border-accent bg-accent-soft font-medium text-fg"
                        : "border-border bg-surface-2 text-fg-muted hover:border-fg-faint/35",
                    )}
                  >
                    <input
                      type="radio"
                      name="sex"
                      value={choice.value}
                      checked={checked}
                      onChange={() => setField("sex", choice.value)}
                      className="sr-only"
                    />
                    <span
                      aria-hidden="true"
                      className={cn(
                        "flex size-[1.05rem] shrink-0 items-center justify-center rounded-full border",
                        checked ? "border-accent" : "border-fg-faint",
                      )}
                    >
                      {checked ? (
                        <span className="size-2 rounded-full bg-accent" />
                      ) : null}
                    </span>
                    {choice.label}
                  </label>
                );
              })}
            </div>

            {errors?.sex ? (
              <FieldError id={`${fieldId("sex")}-error`} message={errors.sex} />
            ) : null}
          </fieldset>

          <Field
            id={fieldId("birthDate")}
            label="Date de naissance"
            hint={HINTS.birthDate}
            error={errors?.birthDate}
            optional
          >
            <Input
              id={fieldId("birthDate")}
              name="birthDate"
              type="date"
              autoComplete="bday"
              aria-invalid={errors?.birthDate ? true : undefined}
              aria-describedby={describedBy(
                `${fieldId("birthDate")}-hint`,
                Boolean(errors?.birthDate) && `${fieldId("birthDate")}-error`,
              )}
              value={fields.birthDate}
              onChange={(event) => setField("birthDate", event.target.value)}
              // `text-base` : sous 16 px, iOS zoome à la prise de focus.
              className="num w-full text-base sm:w-48"
            />
          </Field>
        </div>
      </Panel>

      <Panel title="Données physiologiques">
        <div className="flex flex-col gap-5">
          {/* FC max et FC de repos vont par paire : une seule ligne d'aide. */}
          <fieldset className="min-w-0">
            <legend className="flex flex-wrap items-baseline gap-x-2 text-[0.85rem] font-medium text-fg">
              Fréquence cardiaque
              <OptionalTag />
            </legend>
            <p
              id={heartRateHintId}
              className="mt-1 text-[0.76rem] leading-snug text-fg-faint"
            >
              {HINTS.heartRate}
            </p>

            {/* Au plus près du champ qu'il propose de changer : une proposition
                affichée ailleurs demanderait de retrouver le champ, et une
                proposition sans son champ ne se vérifie pas. */}
            {maxHrSuggestion === null ? null : (
              <MaxHrSuggestionCard
                suggestion={maxHrSuggestion}
                // L'accent de cet écran est déjà pris par « Enregistrer » : un
                // second aplat accent ferait deux CTA sur la même colonne.
                emphasis="secondary"
                // Le champ est contrôlé : sans ça, il garderait l'ancienne
                // valeur à l'écran alors que la base porte la nouvelle.
                onAccepted={(bpm) => setField("maxHrBpm", String(bpm))}
                className="mt-3"
              />
            )}

            {/* Sous la précédente quand les deux sont là : elles proposent deux
                champs différents de la même paire, et aucune des deux ne porte
                l'accent ici — « Enregistrer » l'a déjà. */}
            {restingHrSuggestion === null ? null : (
              <RestingHrSuggestionCard
                suggestion={restingHrSuggestion}
                emphasis="secondary"
                onAccepted={(bpm) => setField("restingHrBpm", String(bpm))}
                className="mt-3"
              />
            )}

            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-3">
              <div>
                <label
                  htmlFor={fieldId("maxHrBpm")}
                  className="block text-[0.8rem] text-fg-muted"
                >
                  FC max
                </label>
                <NumberInput
                  id={fieldId("maxHrBpm")}
                  name="maxHrBpm"
                  type="text"
                  unit="bpm"
                  unitLabel="en battements par minute"
                  aria-invalid={errors?.maxHrBpm ? true : undefined}
                  aria-describedby={describedBy(
                    `${fieldId("maxHrBpm")}-unit`,
                    heartRateHintId,
                    Boolean(errors?.maxHrBpm) && `${fieldId("maxHrBpm")}-error`,
                  )}
                  value={fields.maxHrBpm}
                  onChange={(event) => setField("maxHrBpm", event.target.value)}
                  className="mt-1.5 w-32"
                />
                {errors?.maxHrBpm ? (
                  <FieldError
                    id={`${fieldId("maxHrBpm")}-error`}
                    message={errors.maxHrBpm}
                  />
                ) : null}
              </div>

              <div>
                <label
                  htmlFor={fieldId("restingHrBpm")}
                  className="block text-[0.8rem] text-fg-muted"
                >
                  FC de repos
                </label>
                <NumberInput
                  id={fieldId("restingHrBpm")}
                  name="restingHrBpm"
                  type="text"
                  unit="bpm"
                  unitLabel="en battements par minute"
                  aria-invalid={errors?.restingHrBpm ? true : undefined}
                  aria-describedby={describedBy(
                    `${fieldId("restingHrBpm")}-unit`,
                    heartRateHintId,
                    Boolean(errors?.restingHrBpm) &&
                      `${fieldId("restingHrBpm")}-error`,
                  )}
                  value={fields.restingHrBpm}
                  onChange={(event) =>
                    setField("restingHrBpm", event.target.value)
                  }
                  className="mt-1.5 w-32"
                />
                {errors?.restingHrBpm ? (
                  <FieldError
                    id={`${fieldId("restingHrBpm")}-error`}
                    message={errors.restingHrBpm}
                  />
                ) : null}
              </div>
            </div>
          </fieldset>

          <Field
            id={fieldId("weightKg")}
            label="Poids"
            hint={HINTS.weightKg}
            error={errors?.weightKg}
            optional
          >
            <NumberInput
              id={fieldId("weightKg")}
              name="weightKg"
              type="text"
              inputMode="decimal"
              unit="kg"
              unitLabel="en kilogrammes"
              aria-invalid={errors?.weightKg ? true : undefined}
              aria-describedby={describedBy(
                `${fieldId("weightKg")}-unit`,
                `${fieldId("weightKg")}-hint`,
                Boolean(errors?.weightKg) && `${fieldId("weightKg")}-error`,
              )}
              value={fields.weightKg}
              onChange={(event) => setField("weightKg", event.target.value)}
              className="w-32"
            />
          </Field>
        </div>
      </Panel>

      {/* À la création seulement : c'est le seul moment où ces champs peuvent
          accompagner le profil, puisque l'athlète n'existe pas encore et qu'un
          second formulaire n'aurait rien à modifier. */}
      {mode === "onboarding" ? (
        <Panel title="Import automatique">
          <IntervalsFields
            apiKeyState="absent"
            values={intervals}
            onChange={setIntervals}
            errors={errors}
            intro={INTERVALS_ONBOARDING_INTRO}
          />
        </Panel>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button
          type="submit"
          size="lg"
          disabled={isPending}
          aria-busy={isPending}
          className="w-full sm:w-auto"
        >
          {isPending ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : null}
          {isPending
            ? "Enregistrement…"
            : mode === "onboarding"
              ? "Créer mon profil"
              : "Enregistrer"}
        </Button>
        <p className="text-[0.78rem] leading-relaxed text-fg-faint">
          {mode === "onboarding"
            ? "Tout reste modifiable ensuite, depuis cette même page."
            : "Les calculs repartent de ces valeurs dès l'enregistrement."}
        </p>
      </div>
    </form>
  );
}
