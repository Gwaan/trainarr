"use client";

import { useActionState, useId, useState, type ComponentProps, type ReactNode } from "react";
import { ChevronDown, Loader2, Wand } from "lucide-react";

import { Banner } from "@/components/banner";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { createPlanAction, type PlanFormState } from "../_lib/actions";
import { formatCivilDay } from "../_lib/format-plan";
import {
  DEFAULT_LEVEL,
  DEFAULT_LONG_RUN_DAY,
  DEFAULT_SESSIONS_PER_WEEK,
  DEFAULT_WEEKS,
  GOAL_TYPE_CHOICES,
  LEVEL_CHOICES,
  LONG_RUN_DAY_CHOICES,
  SESSIONS_PER_WEEK_CHOICES,
  WEEK_CHOICES,
  type GoalType,
  type Level,
} from "../_lib/form-options";

/**
 * Formulaire de création d'un plan.
 *
 * Les champs sont contrôlés : React réinitialise un formulaire non contrôlé une
 * fois l'action terminée, et une génération qui échoue après plusieurs minutes
 * d'attente ne doit pas effacer la saisie.
 *
 * Le temps d'attente est le point sensible de cet écran : sur un modèle local,
 * la génération se compte en minutes. Le bouton se désactive et **dit** ce qui
 * se passe — jamais de rotative muette.
 */

const HINTS = {
  goalText:
    "Ce que tu veux atteindre, en une phrase : c'est ce que le coach cherchera à préparer.",
  raceDate: "Le plan court jusqu'au jour de la course, affûtage compris.",
  weeks: "La durée du bloc d'entraînement, sans échéance particulière.",
  sessionsPerWeek: "Le nombre de sorties que tu peux tenir chaque semaine, durablement.",
  weeklyTimeHours:
    "Le temps que tu peux consacrer à courir sur une semaine. Sans réponse, le coach reste prudent.",
  longRunDay: "Le jour où tu peux courir le plus longtemps.",
} as const;

const PENDING_MESSAGE =
  "Le coach construit ton plan — jusqu'à quelques minutes avec un modèle local.";

const INITIAL_STATE: PlanFormState = { status: "idle" };

const GENERIC_FAILURE = "Le plan n'a pas été généré.";

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
        {optional ? (
          <span className="text-[0.72rem] font-normal text-fg-faint">facultatif</span>
        ) : null}
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
 * Choix exclusif présenté en cartes : libellé, pastille et phrase d'aide.
 *
 * Deux groupes s'en servent (type d'objectif, niveau) et ils doivent rester
 * visuellement identiques — d'où un composant plutôt qu'un second bloc recopié,
 * qui divergerait à la première retouche.
 */
function RadioCards<T extends string>({
  name,
  legend,
  choices,
  value,
  onChange,
  error,
  errorId,
  columns,
}: {
  name: string;
  legend: string;
  choices: readonly { value: T; label: string; hint: string }[];
  value: T;
  onChange: (value: T) => void;
  error?: string;
  /** Identifiant du message d'erreur, référencé par le `fieldset`. */
  errorId: string;
  /** Classe de grille appliquée à partir de `sm` — deux ou trois colonnes. */
  columns: string;
}) {
  return (
    <fieldset className="min-w-0" aria-describedby={describedBy(Boolean(error) && errorId)}>
      <legend className="text-[0.85rem] font-medium text-fg">{legend}</legend>

      <div className={cn("mt-2 grid gap-2", columns)}>
        {choices.map((choice) => {
          const checked = value === choice.value;

          return (
            <label
              key={choice.value}
              className={cn(
                "cursor-pointer rounded-button border px-3 py-2.5",
                "transition-colors duration-150 ease-out",
                // Le radio natif est masqué : le focus clavier est reporté
                // sur l'étiquette entière, sans quoi il disparaîtrait.
                "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
                checked
                  ? "border-accent bg-accent-soft"
                  : "border-border bg-surface-2 hover:border-fg-faint/35",
              )}
            >
              <span className="flex items-center gap-2.5">
                <input
                  type="radio"
                  name={name}
                  value={choice.value}
                  checked={checked}
                  onChange={() => onChange(choice.value)}
                  className="sr-only"
                />
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-[1.05rem] shrink-0 items-center justify-center rounded-full border",
                    checked ? "border-accent" : "border-fg-faint",
                  )}
                >
                  {checked ? <span className="size-2 rounded-full bg-accent" /> : null}
                </span>
                <span
                  className={cn("text-[0.85rem]", checked ? "font-medium text-fg" : "text-fg-muted")}
                >
                  {choice.label}
                </span>
              </span>
              <span className="mt-1.5 block text-[0.74rem] leading-snug text-fg-faint">
                {choice.hint}
              </span>
            </label>
          );
        })}
      </div>

      {error ? <FieldError id={errorId} message={error} /> : null}
    </fieldset>
  );
}

/**
 * Liste déroulante native, habillée aux tokens du champ de saisie : sur mobile
 * elle ouvre le sélecteur du système, qu'aucun composant maison n'égale.
 */
function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <div className={cn("relative", className)}>
      <select
        {...props}
        className={cn(
          "h-11 w-full appearance-none rounded-button border border-border bg-surface-2 pr-9 pl-3",
          "text-[0.95rem] text-fg transition-colors duration-150 ease-out",
          "hover:border-fg-faint/35 aria-invalid:border-negative/60",
        )}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-3 my-auto size-4 text-fg-faint"
      />
    </div>
  );
}

export type PlanFormProps = {
  /** Date civile la plus proche qu'une course puisse porter (cf. `_lib/plan-window.ts`). */
  minRaceDate: string;
  /** Date civile la plus lointaine qu'une course puisse porter (même source). */
  maxRaceDate: string;
  /**
   * Premier jour où le programme peut démarrer, c'est-à-dire aujourd'hui — à la
   * fois la borne basse du champ, sa valeur pré-remplie, et le défaut que le
   * service appliquera si l'athlète efface le champ.
   */
  defaultStartDate: string;
  /** Dernier jour proposé au démarrage (même source). */
  maxStartDate: string;
};

export function PlanForm({
  minRaceDate,
  maxRaceDate,
  defaultStartDate,
  maxStartDate,
}: PlanFormProps) {
  const [state, formAction, isPending] = useActionState(createPlanAction, INITIAL_STATE);
  const [goalType, setGoalType] = useState<GoalType>("race");
  const [level, setLevel] = useState<Level>(DEFAULT_LEVEL);
  const [goalText, setGoalText] = useState("");
  const [raceDate, setRaceDate] = useState("");
  // Pré-rempli à aujourd'hui : c'est le départ que l'athlète veut par défaut,
  // et le champ vide vaut de toute façon la même chose côté action.
  const [startsOn, setStartsOn] = useState(defaultStartDate);
  const [weeks, setWeeks] = useState(String(DEFAULT_WEEKS));
  const [sessionsPerWeek, setSessionsPerWeek] = useState(String(DEFAULT_SESSIONS_PER_WEEK));
  const [weeklyTimeHours, setWeeklyTimeHours] = useState("");
  const [longRunDay, setLongRunDay] = useState(String(DEFAULT_LONG_RUN_DAY));

  const uid = useId();
  const fieldId = (name: string) => `${uid}-${name}`;

  const errors = state.fieldErrors;
  const hasFeedback = isPending || state.status === "error";

  return (
    <form action={formAction} noValidate className="flex flex-col gap-4 sm:gap-5">
      {/*
        Région live permanente : elle doit exister avant la mise à jour pour que
        le retour d'action soit annoncé. Sans message, `sr-only` la sort du flux,
        donc de l'espacement de la colonne.
      */}
      <div aria-live="polite" className={hasFeedback ? undefined : "sr-only"}>
        {isPending ? <Banner tone="neutral" title={PENDING_MESSAGE} /> : null}
        {!isPending && state.status === "error" ? (
          <Banner tone="negative" title={state.message ?? GENERIC_FAILURE} />
        ) : null}
      </div>

      <Panel title="Ton objectif">
        <div className="flex flex-col gap-5">
          <RadioCards
            name="goalType"
            legend="Type d'objectif"
            choices={GOAL_TYPE_CHOICES}
            value={goalType}
            onChange={setGoalType}
            error={errors?.goalType}
            errorId={`${fieldId("goalType")}-error`}
            columns="sm:grid-cols-2"
          />

          <Field
            id={fieldId("goalText")}
            label={goalType === "race" ? "Ta course" : "Ton objectif"}
            hint={HINTS.goalText}
            error={errors?.goalText}
          >
            <Input
              id={fieldId("goalText")}
              name="goalText"
              type="text"
              maxLength={200}
              autoComplete="off"
              placeholder={
                goalType === "race" ? "10 km sous 50 min" : "Améliorer mon endurance"
              }
              aria-required="true"
              aria-invalid={errors?.goalText ? true : undefined}
              aria-describedby={describedBy(
                `${fieldId("goalText")}-hint`,
                Boolean(errors?.goalText) && `${fieldId("goalText")}-error`,
              )}
              value={goalText}
              onChange={(event) => setGoalText(event.target.value)}
            />
          </Field>

          {goalType === "race" ? (
            <Field
              id={fieldId("raceDate")}
              label="Date de la course"
              hint={HINTS.raceDate}
              error={errors?.raceDate}
            >
              <Input
                id={fieldId("raceDate")}
                name="raceDate"
                type="date"
                min={minRaceDate}
                max={maxRaceDate}
                aria-required="true"
                aria-invalid={errors?.raceDate ? true : undefined}
                aria-describedby={describedBy(
                  `${fieldId("raceDate")}-hint`,
                  Boolean(errors?.raceDate) && `${fieldId("raceDate")}-error`,
                )}
                value={raceDate}
                onChange={(event) => setRaceDate(event.target.value)}
                className="num w-full sm:w-48"
              />
            </Field>
          ) : (
            <Field
              id={fieldId("weeks")}
              label="Durée du plan"
              hint={HINTS.weeks}
              error={errors?.weeks}
            >
              <Select
                id={fieldId("weeks")}
                name="weeks"
                aria-invalid={errors?.weeks ? true : undefined}
                aria-describedby={describedBy(
                  `${fieldId("weeks")}-hint`,
                  Boolean(errors?.weeks) && `${fieldId("weeks")}-error`,
                )}
                value={weeks}
                onChange={(event) => setWeeks(event.target.value)}
                className="w-full sm:w-48"
              >
                {WEEK_CHOICES.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice} semaines
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field
            id={fieldId("startsOn")}
            label="Début du programme"
            hint={`Aujourd'hui (${formatCivilDay(defaultStartDate)}) ou plus tard — le plan démarre ce jour-là. Un départ en milieu de semaine ouvre une première semaine entamée.`}
            error={errors?.startsOn}
          >
            <Input
              id={fieldId("startsOn")}
              name="startsOn"
              type="date"
              min={defaultStartDate}
              max={maxStartDate}
              aria-invalid={errors?.startsOn ? true : undefined}
              aria-describedby={describedBy(
                `${fieldId("startsOn")}-hint`,
                Boolean(errors?.startsOn) && `${fieldId("startsOn")}-error`,
              )}
              value={startsOn}
              onChange={(event) => setStartsOn(event.target.value)}
              className="num w-full sm:w-48"
            />
          </Field>
        </div>
      </Panel>

      <Panel title="Tes contraintes">
        <div className="flex flex-col gap-5">
          {/*
            Le niveau se déclare ici, avec le reste de ce que le coach doit
            savoir pour caler le plan : il ne se modifie plus ensuite, changer de
            niveau revient à régénérer un plan.
          */}
          <RadioCards
            name="level"
            legend="Ton niveau"
            choices={LEVEL_CHOICES}
            value={level}
            onChange={setLevel}
            error={errors?.level}
            errorId={`${fieldId("level")}-error`}
            columns="sm:grid-cols-3"
          />

          <Field
            id={fieldId("sessionsPerWeek")}
            label="Séances par semaine"
            hint={HINTS.sessionsPerWeek}
            error={errors?.sessionsPerWeek}
          >
            <Select
              id={fieldId("sessionsPerWeek")}
              name="sessionsPerWeek"
              aria-invalid={errors?.sessionsPerWeek ? true : undefined}
              aria-describedby={describedBy(
                `${fieldId("sessionsPerWeek")}-hint`,
                Boolean(errors?.sessionsPerWeek) && `${fieldId("sessionsPerWeek")}-error`,
              )}
              value={sessionsPerWeek}
              onChange={(event) => setSessionsPerWeek(event.target.value)}
              className="w-full sm:w-48"
            >
              {SESSIONS_PER_WEEK_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {choice} séances
                </option>
              ))}
            </Select>
          </Field>

          <Field
            id={fieldId("longRunDay")}
            label="Jour de la sortie longue"
            hint={HINTS.longRunDay}
            error={errors?.longRunDay}
          >
            <Select
              id={fieldId("longRunDay")}
              name="longRunDay"
              aria-invalid={errors?.longRunDay ? true : undefined}
              aria-describedby={describedBy(
                `${fieldId("longRunDay")}-hint`,
                Boolean(errors?.longRunDay) && `${fieldId("longRunDay")}-error`,
              )}
              value={longRunDay}
              onChange={(event) => setLongRunDay(event.target.value)}
              className="w-full sm:w-48"
            >
              {LONG_RUN_DAY_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            id={fieldId("weeklyTimeHours")}
            label="Temps disponible par semaine"
            hint={HINTS.weeklyTimeHours}
            error={errors?.weeklyTimeHours}
            optional
          >
            <div className="relative w-32">
              <Input
                id={fieldId("weeklyTimeHours")}
                name="weeklyTimeHours"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder="4"
                aria-invalid={errors?.weeklyTimeHours ? true : undefined}
                aria-describedby={describedBy(
                  `${fieldId("weeklyTimeHours")}-unit`,
                  `${fieldId("weeklyTimeHours")}-hint`,
                  Boolean(errors?.weeklyTimeHours) && `${fieldId("weeklyTimeHours")}-error`,
                )}
                value={weeklyTimeHours}
                onChange={(event) => setWeeklyTimeHours(event.target.value)}
                className="num pr-10"
              />
              <span
                aria-hidden="true"
                className="num pointer-events-none absolute inset-y-0 right-3 flex items-center text-[0.78rem] text-fg-faint"
              >
                h
              </span>
              <span id={`${fieldId("weeklyTimeHours")}-unit`} className="sr-only">
                en heures
              </span>
            </div>
          </Field>
        </div>
      </Panel>

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
          ) : (
            <Wand aria-hidden="true" />
          )}
          {isPending ? "Génération en cours…" : "Générer mon plan"}
        </Button>
        <p className="text-[0.78rem] leading-relaxed text-fg-faint">
          {isPending
            ? "Reste sur cette page : le plan s'affichera dès qu'il sera écrit."
            : "Le plan s'appuie sur ta charge d'entraînement des dernières semaines."}
        </p>
      </div>
    </form>
  );
}
