"use client";

import { Input } from "@/components/ui/input";

import type { PlanFormField } from "../_lib/actions";
import { formatCivilDay } from "../_lib/format-plan";
import {
  LEVEL_CHOICES,
  LONG_RUN_DAY_CHOICES,
  REFERENCE_DISTANCE_CHOICES,
  SESSIONS_PER_WEEK_CHOICES,
  WEEK_CHOICES,
  asReferenceDistance,
} from "../_lib/form-options";
import { INTENT_CHOICES, INTENT_HONEST_NOTES } from "../_lib/plan-intent";
import { planRecapEntries } from "../_lib/plan-recap";
import type { PlanFormValues, PlanStep } from "../_lib/plan-steps";

import { Checkbox, Field, RadioCards, Select, describedBy } from "./plan-form-fields";

/**
 * Le contenu de chaque étape de la modale de création.
 *
 * Aucune de ces étapes ne tient d'état : elles reçoivent les réponses, les
 * erreurs du serveur qui les concernent, et rendent la main. Les champs des
 * étapes qu'on ne regarde pas restent montés (masqués par la modale), sans quoi
 * le `FormData` partirait incomplet.
 */

const HINTS = {
  /**
   * Deux textes, parce que la note n'a pas le même poids selon l'intention.
   * Sous `race`, elle est la **seule** source de la distance d'objectif que lit
   * `goalDistanceKm()` : vide, un marathon reçoit un plan calé sur un format
   * 10 km. Ailleurs, elle ne fait que passer au coach. Un hint unique mentirait
   * dans un cas ou dans l'autre.
   */
  goalTextRace:
    "Écris la distance visée et ton chrono cible (« marathon en 3h45 », « 10 km sous 50 min ») : sans eux, le plan se cale sur un format 10 km — affûtage plus court, pas de bloc à allure objectif.",
  goalTextOther:
    "Une précision pour le coach, si tu veux — elle n'influence pas la structure du plan.",
  raceDate: "Le plan court jusqu'au jour de la course, affûtage compris.",
  weeks: "La durée du bloc d'entraînement, sans échéance particulière.",
  returnInjuryHistory:
    "C'est le facteur de risque le mieux établi : le plan allonge alors sa base et double la période en marche/course.",
  sessionsPerWeek: "Le nombre de sorties que tu peux tenir chaque semaine, durablement.",
  weeklyTimeHours:
    "Le temps que tu peux consacrer à courir sur une semaine. Sans réponse, le coach reste prudent.",
  longRunDay: "Le jour où tu peux courir le plus longtemps.",
  referenceDistance: "La distance sur laquelle tu as un temps récent et sérieux.",
  referenceTime:
    "C'est la donnée la plus fiable pour calibrer tes allures. Sans chrono, le coach restera prudent.",
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
    case "expectations":
      return <ExpectationsNote intent={props.values.intent} />;
    case "profile":
      return <ProfileFields {...props} />;
    case "race":
      return <RaceFields {...props} />;
    case "constraints":
      return <ConstraintsFields {...props} />;
    case "summary":
      return <SummaryFields values={props.values} />;
  }
}

/**
 * Ce que le plan peut donner, et ce qu'il ne promet pas — l'étape qui se lit,
 * avant de générer.
 *
 * Le texte vit dans `_lib/plan-intent.ts` : la page du plan en réutilise une
 * partie, et deux copies divergeraient. Aucun champ ici, rien à valider.
 */
function ExpectationsNote({ intent }: { intent: PlanFormValues["intent"] }) {
  return (
    <div className="rounded-card border border-border bg-surface-2 px-3.5 py-3">
      <p className="text-[0.85rem] leading-relaxed text-fg-muted">
        {INTENT_HONEST_NOTES[intent]}
      </p>
    </div>
  );
}

function GoalFields({ values, onChange, errors, fieldId, bounds }: PlanStepFieldsProps) {
  return (
    <div className="flex flex-col gap-5">
      <RadioCards
        name="intent"
        legend="Ce que tu viens chercher"
        choices={INTENT_CHOICES}
        value={values.intent}
        onChange={(value) => onChange("intent", value)}
        error={errors?.intent}
        errorId={`${fieldId("intent")}-error`}
        columns="sm:grid-cols-2"
      />

      {values.intent === "return" ? (
        <Checkbox
          id={fieldId("returnInjuryHistory")}
          name="returnInjuryHistory"
          label="J'ai eu une blessure ces derniers mois"
          hint={HINTS.returnInjuryHistory}
          checked={values.returnInjuryHistory}
          onChange={(checked) => onChange("returnInjuryHistory", checked)}
        />
      ) : null}

      {values.intent === "race" ? (
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

      {/*
        L'ancien objectif en texte libre, devenu une **note**. C'est le
        sélecteur qui donne au plan sa forme — sauf pour une chose, et elle
        compte : la distance visée ne se lit qu'ici (« 10 km sous 50 min »),
        d'où un hint qui, sous `race`, dit ce que coûte de laisser le champ vide.
      */}
      <Field
        id={fieldId("goalText")}
        label="Une note pour le coach"
        hint={values.intent === "race" ? HINTS.goalTextRace : HINTS.goalTextOther}
        error={errors?.goalText}
        optional
      >
        <Input
          id={fieldId("goalText")}
          name="goalText"
          type="text"
          maxLength={200}
          autoComplete="off"
          placeholder={values.intent === "race" ? "10 km sous 50 min" : "Ce que tu veux préciser"}
          aria-invalid={errors?.goalText ? true : undefined}
          aria-describedby={describedBy(
            `${fieldId("goalText")}-hint`,
            Boolean(errors?.goalText) && `${fieldId("goalText")}-error`,
          )}
          value={values.goalText}
          onChange={(event) => onChange("goalText", event.target.value)}
        />
      </Field>
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

/**
 * Le chrono de référence : une distance et un temps.
 *
 * Facultatif, et pourtant l'étape la plus utile du formulaire — c'est ce couple
 * qui **calcule** la table d'allures du plan (VDOT) au lieu de la laisser deviner
 * au coach. D'où la phrase d'aide, qui dit ce que coûte de passer son chemin.
 *
 * Le temps est un champ texte à masque libre plutôt qu'un `type="time"` : le
 * sélecteur natif est pensé pour une heure de la journée, pas pour un chrono, et
 * il n'affiche pas les secondes sur tous les navigateurs.
 */
function RaceFields({ values, onChange, errors, fieldId }: PlanStepFieldsProps) {
  const placeholder =
    REFERENCE_DISTANCE_CHOICES.find((choice) => choice.value === values.referenceDistance)
      ?.placeholder ?? "50:00";

  return (
    <div className="flex flex-col gap-5">
      <Field
        id={fieldId("referenceDistance")}
        label="Distance"
        hint={HINTS.referenceDistance}
        error={errors?.referenceDistance}
      >
        <Select
          id={fieldId("referenceDistance")}
          name="referenceDistance"
          aria-invalid={errors?.referenceDistance ? true : undefined}
          aria-describedby={describedBy(
            `${fieldId("referenceDistance")}-hint`,
            Boolean(errors?.referenceDistance) && `${fieldId("referenceDistance")}-error`,
          )}
          value={values.referenceDistance}
          onChange={(event) => {
            const distance = asReferenceDistance(event.target.value);
            if (distance !== null) onChange("referenceDistance", distance);
          }}
          className="w-full sm:w-48"
        >
          {REFERENCE_DISTANCE_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        id={fieldId("referenceTime")}
        label="Ton temps"
        hint={HINTS.referenceTime}
        error={errors?.referenceTime}
        optional
      >
        <Input
          id={fieldId("referenceTime")}
          name="referenceTime"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder={placeholder}
          aria-invalid={errors?.referenceTime ? true : undefined}
          aria-describedby={describedBy(
            `${fieldId("referenceTime")}-format`,
            `${fieldId("referenceTime")}-hint`,
            Boolean(errors?.referenceTime) && `${fieldId("referenceTime")}-error`,
          )}
          value={values.referenceTime}
          onChange={(event) => onChange("referenceTime", event.target.value)}
          className="num w-32"
        />
        <p
          id={`${fieldId("referenceTime")}-format`}
          className="mt-1.5 text-[0.76rem] leading-snug text-fg-faint"
        >
          Format <span className="num">mm:ss</span> ou <span className="num">hh:mm:ss</span>.
        </p>
      </Field>
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

/**
 * La dernière étape ne saisit rien : elle relit ce qui va partir au coach.
 *
 * Une des valeurs relues est du **texte libre** — la note de l'athlète. Ligne et
 * valeur étant des éléments de flex, leur `min-width: auto` les empêche de
 * rétrécir sous leur contenu minimal : une note écrite sans espace (une adresse
 * collée, un mot à rallonge) élargissait la ligne bien au-delà de la modale.
 * Le corps de la modale étant en `overflow-y-auto`, l'autre axe passe à `auto`
 * avec lui — la relecture se mettait donc à défiler latéralement sous le doigt,
 * en-tête et barre d'actions restant immobiles. `min-w-0` rend la valeur
 * rétrécissable, `break-words` coupe le mot qui ne tient pas.
 */
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
                  ? "num min-w-0 break-words text-[0.85rem] text-fg"
                  : "min-w-0 break-words text-[0.85rem] text-fg"
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
