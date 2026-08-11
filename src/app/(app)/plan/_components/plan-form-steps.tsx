"use client";

import { Input } from "@/components/ui/input";

import type { PlanFormField } from "../_lib/actions";
import { formatCivilDay } from "../_lib/format-plan";
import {
  GOAL_TYPE_CHOICES,
  LEVEL_CHOICES,
  LONG_RUN_DAY_CHOICES,
  SESSIONS_PER_WEEK_CHOICES,
  WEEK_CHOICES,
} from "../_lib/form-options";
import { planRecapEntries } from "../_lib/plan-recap";
import type { PlanFormValues, PlanStep } from "../_lib/plan-steps";

import { Field, RadioCards, Select, describedBy } from "./plan-form-fields";

/**
 * Le contenu de chaque étape de la modale de création.
 *
 * Aucune de ces étapes ne tient d'état : elles reçoivent les réponses, les
 * erreurs du serveur qui les concernent, et rendent la main. Les champs des
 * étapes qu'on ne regarde pas restent montés (masqués par la modale), sans quoi
 * le `FormData` partirait incomplet.
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

/** Bornes calendaires que les champs date proposent (cf. `_lib/plan-window.ts`). */
export type PlanDateBounds = {
  /** Date civile la plus proche qu'une course puisse porter. */
  minRaceDate: string;
  /** Date civile la plus lointaine qu'une course puisse porter. */
  maxRaceDate: string;
  /**
   * Premier jour où le programme peut démarrer, c'est-à-dire aujourd'hui — à la
   * fois la borne basse du champ, sa valeur pré-remplie, et le défaut que le
   * service appliquera si l'athlète efface le champ.
   */
  defaultStartDate: string;
  /** Dernier jour proposé au démarrage. */
  maxStartDate: string;
};

export type PlanStepFieldsProps = {
  step: PlanStep;
  values: PlanFormValues;
  /** Une réponse change — la modale garde l'état, les étapes n'en tiennent aucun. */
  onChange: <K extends keyof PlanFormValues>(field: K, value: PlanFormValues[K]) => void;
  /** Erreurs rendues par la Server Action, toutes étapes confondues. */
  errors: Partial<Record<PlanFormField, string>> | undefined;
  /** Fabrique d'`id` de champ, tirée d'un `useId` unique pour toute la modale. */
  fieldId: (name: string) => string;
  bounds: PlanDateBounds;
};

/** Le contenu de l'étape demandée. */
export function PlanStepFields(props: PlanStepFieldsProps) {
  switch (props.step.id) {
    case "goal":
      return <GoalFields {...props} />;
    case "profile":
      return <ProfileFields {...props} />;
    case "constraints":
      return <ConstraintsFields {...props} />;
    case "summary":
      return <SummaryFields values={props.values} />;
  }
}

function GoalFields({ values, onChange, errors, fieldId, bounds }: PlanStepFieldsProps) {
  return (
    <div className="flex flex-col gap-5">
      <RadioCards
        name="goalType"
        legend="Type d'objectif"
        choices={GOAL_TYPE_CHOICES}
        value={values.goalType}
        onChange={(value) => onChange("goalType", value)}
        error={errors?.goalType}
        errorId={`${fieldId("goalType")}-error`}
        columns="sm:grid-cols-2"
      />

      <Field
        id={fieldId("goalText")}
        label={values.goalType === "race" ? "Ta course" : "Ton objectif"}
        hint={HINTS.goalText}
        error={errors?.goalText}
      >
        <Input
          id={fieldId("goalText")}
          name="goalText"
          type="text"
          maxLength={200}
          autoComplete="off"
          placeholder={values.goalType === "race" ? "10 km sous 50 min" : "Améliorer mon endurance"}
          aria-required="true"
          aria-invalid={errors?.goalText ? true : undefined}
          aria-describedby={describedBy(
            `${fieldId("goalText")}-hint`,
            Boolean(errors?.goalText) && `${fieldId("goalText")}-error`,
          )}
          value={values.goalText}
          onChange={(event) => onChange("goalText", event.target.value)}
        />
      </Field>

      {values.goalType === "race" ? (
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
            min={bounds.minRaceDate}
            max={bounds.maxRaceDate}
            aria-required="true"
            aria-invalid={errors?.raceDate ? true : undefined}
            aria-describedby={describedBy(
              `${fieldId("raceDate")}-hint`,
              Boolean(errors?.raceDate) && `${fieldId("raceDate")}-error`,
            )}
            value={values.raceDate}
            onChange={(event) => onChange("raceDate", event.target.value)}
            className="num w-full sm:w-48"
          />
        </Field>
      ) : (
        <Field id={fieldId("weeks")} label="Durée du plan" hint={HINTS.weeks} error={errors?.weeks}>
          <Select
            id={fieldId("weeks")}
            name="weeks"
            aria-invalid={errors?.weeks ? true : undefined}
            aria-describedby={describedBy(
              `${fieldId("weeks")}-hint`,
              Boolean(errors?.weeks) && `${fieldId("weeks")}-error`,
            )}
            value={values.weeks}
            onChange={(event) => onChange("weeks", event.target.value)}
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
    </div>
  );
}

function ProfileFields({ values, onChange, errors, fieldId }: PlanStepFieldsProps) {
  return (
    <div className="flex flex-col gap-5">
      {/*
        Le niveau se déclare ici, avec le reste de ce que le coach doit savoir
        pour caler le plan : il ne se modifie plus ensuite, changer de niveau
        revient à régénérer un plan.
      */}
      <RadioCards
        name="level"
        legend="Ton niveau"
        choices={LEVEL_CHOICES}
        value={values.level}
        onChange={(value) => onChange("level", value)}
        error={errors?.level}
        errorId={`${fieldId("level")}-error`}
        columns="sm:grid-cols-3"
      />
    </div>
  );
}

function ConstraintsFields({ values, onChange, errors, fieldId, bounds }: PlanStepFieldsProps) {
  return (
    <div className="flex flex-col gap-5">
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
          value={values.sessionsPerWeek}
          onChange={(event) => onChange("sessionsPerWeek", event.target.value)}
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
          value={values.longRunDay}
          onChange={(event) => onChange("longRunDay", event.target.value)}
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
            value={values.weeklyTimeHours}
            onChange={(event) => onChange("weeklyTimeHours", event.target.value)}
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

      <Field
        id={fieldId("startsOn")}
        label="Début du programme"
        hint={`Aujourd'hui (${formatCivilDay(bounds.defaultStartDate)}) ou plus tard — le plan démarre ce jour-là. Un départ en milieu de semaine ouvre une première semaine entamée.`}
        error={errors?.startsOn}
      >
        <Input
          id={fieldId("startsOn")}
          name="startsOn"
          type="date"
          min={bounds.defaultStartDate}
          max={bounds.maxStartDate}
          aria-invalid={errors?.startsOn ? true : undefined}
          aria-describedby={describedBy(
            `${fieldId("startsOn")}-hint`,
            Boolean(errors?.startsOn) && `${fieldId("startsOn")}-error`,
          )}
          value={values.startsOn}
          onChange={(event) => onChange("startsOn", event.target.value)}
          className="num w-full sm:w-48"
        />
      </Field>
    </div>
  );
}

/** La dernière étape ne saisit rien : elle relit ce qui va partir au coach. */
function SummaryFields({ values }: { values: PlanFormValues }) {
  return (
    <div className="rounded-card border border-border bg-surface-2">
      <dl className="divide-y divide-border">
        {planRecapEntries(values).map((entry) => (
          <div
            key={entry.label}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3.5 py-2.5"
          >
            <dt className="text-[0.78rem] text-fg-faint">{entry.label}</dt>
            <dd
              className={
                entry.numeric
                  ? "num text-[0.85rem] text-fg"
                  : "text-[0.85rem] text-fg"
              }
            >
              {entry.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
