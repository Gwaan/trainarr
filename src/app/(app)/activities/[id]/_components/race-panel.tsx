"use client";

import { useActionState, useId, useState } from "react";
import { Flag, Loader2, Trash2 } from "lucide-react";

import { Banner } from "@/components/banner";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { formatRaceTimeInput } from "../../../_lib/race-time";
import { removeRaceResultAction, saveRaceResultAction } from "../_lib/race-actions";
import type { RaceFormValues } from "../_lib/race-model";
import {
  RACE_FORM_IDLE,
  RACE_REMOVAL_IDLE,
  type RaceFormField,
} from "../_lib/race-state";

/**
 * Section « Course officielle » : déclarer cette séance comme course, ou
 * corriger la déclaration.
 *
 * ## Pourquoi la saisie n'est pas un simple interrupteur
 *
 * Le chrono officiel n'est pas celui de la montre. Le temps de puce démarre au
 * passage de la ligne, la distance est celle du parcours homologué, et une
 * montre qui coupe un virage annonce 5,12 km sur un 5 km. Ces deux valeurs
 * **font foi pour le calcul** du facteur correctif de la VO₂max : les recopier
 * de la séance sans laisser les corriger ferait entrer une erreur de mesure
 * dans un rapport censé n'exprimer qu'un biais cardiaque.
 *
 * Elles sont donc pré-remplies depuis la séance, puis modifiables — et une fois
 * déclarées, c'est la déclaration qui se relit (cf. `../_lib/race-model`).
 *
 * ## Ce que la séance apporte quand même
 *
 * La **FC moyenne** et le **dénivelé**, qu'aucun bulletin d'arrivée ne porte et
 * que personne ne saisit à la main. Ils sont lus sur la séance liée à chaque
 * calcul, jamais copiés. Sans FC, la course reste une course mais ne calibre
 * rien : il n'y a pas de dénominateur, et rien ne s'invente.
 *
 * **Aucun bouton accent ici** : sur une page de lecture, l'accent est réservé à
 * la navigation et aux actions du coach.
 */

const INTRO =
  "Déclarer une course cale ta VO₂max estimée sur une performance réelle : Trainarr compare ce que ton chrono implique à ce que ta fréquence cardiaque laissait lire, et applique l’écart à toutes tes séances. Sans course déclarée, l’estimation reste non recalée.";

const OFFICIAL_NOTICE =
  "Saisis les valeurs officielles : temps de puce et distance homologuée. Elles sont pré-remplies depuis la séance, mais ce sont elles qui font foi — la montre, elle, ne sert plus qu’à fournir la fréquence cardiaque et le dénivelé.";

/** Repli si une action échoue sans message — elle en fournit un dans tous ses cas connus. */
const GENERIC_FAILURE = "La course n’a pas été enregistrée.";

export type RacePanelProps = {
  activityId: number;
  /** Identifiant de la course déjà déclarée, `null` s'il n'y en a pas. */
  declaredRaceId: number | null;
  values: RaceFormValues;
};

export function RacePanel({ activityId, declaredRaceId, values }: RacePanelProps) {
  const uid = useId();

  const [state, formAction, isSaving] = useActionState(
    saveRaceResultAction,
    RACE_FORM_IDLE,
  );
  const [removal, removeAction, isRemoving] = useActionState(
    removeRaceResultAction,
    RACE_REMOVAL_IDLE,
  );

  // Champs **contrôlés** : React réinitialise un formulaire non contrôlé à la
  // fin de l'action, et la saisie disparaîtrait au premier message.
  const [form, setForm] = useState(values);

  // Les valeurs viennent d'être enregistrées (ou la course retirée) : les props
  // changent, la saisie doit suivre. Ajustement pendant le rendu plutôt qu'en
  // effet — la forme que React recommande pour dériver un état d'un autre.
  const [lastSaved, setLastSaved] = useState(values);
  if (
    lastSaved.racedOn !== values.racedOn ||
    lastSaved.distanceKm !== values.distanceKm ||
    lastSaved.time !== values.time ||
    lastSaved.name !== values.name
  ) {
    setLastSaved(values);
    setForm(values);
  }

  const declared = declaredRaceId !== null;

  return (
    <Panel title="Course officielle">
      <div
        aria-live="polite"
        className={
          state.status === "idle" && removal.status === "idle" ? "sr-only" : "mb-4"
        }
      >
        {state.status === "success" ? (
          <Banner tone="positive" title={state.message ?? "Course enregistrée."} />
        ) : null}
        {state.status === "error" ? (
          <Banner tone="negative" title={state.message ?? GENERIC_FAILURE} />
        ) : null}
        {removal.status === "success" ? (
          <Banner tone="positive" title={removal.message ?? "Course retirée."} />
        ) : null}
        {removal.status === "error" ? (
          <Banner tone="negative" title={removal.message ?? GENERIC_FAILURE} />
        ) : null}
      </div>

      <form action={formAction} noValidate className="flex flex-col gap-5">
        <input type="hidden" name="activityId" value={activityId} />

        <p className="text-[0.82rem] leading-relaxed text-fg-muted">{INTRO}</p>

        <Banner
          tone="neutral"
          title={declared ? "Cette séance est déclarée comme course" : "Le chrono qui fait foi"}
        >
          {OFFICIAL_NOTICE}
        </Banner>

        <RaceField
          id={`${uid}-name`}
          name="name"
          label="Nom de l’épreuve"
          hint="Facultatif — « 10 km de Bordeaux »."
          value={form.name}
          onChange={(name) => setForm((current) => ({ ...current, name }))}
          error={state.fieldErrors?.name}
          className="sm:max-w-sm"
          autoComplete="off"
        />

        <div className="flex flex-col gap-4 sm:flex-row sm:gap-5">
          <RaceField
            id={`${uid}-date`}
            name="racedOn"
            type="date"
            label="Date"
            hint="Le jour du dossard."
            value={form.racedOn}
            onChange={(racedOn) => setForm((current) => ({ ...current, racedOn }))}
            error={state.fieldErrors?.racedOn}
          />
          <RaceField
            id={`${uid}-distance`}
            name="distanceKm"
            label="Distance officielle (km)"
            hint="Celle du parcours homologué, pas celle de la montre."
            inputMode="decimal"
            value={form.distanceKm}
            onChange={(distanceKm) => setForm((current) => ({ ...current, distanceKm }))}
            error={state.fieldErrors?.distanceKm}
          />
          <RaceField
            id={`${uid}-time`}
            name="time"
            label="Chrono officiel"
            hint="mm:ss ou h:mm:ss — le temps de puce."
            inputMode="numeric"
            value={form.time}
            // Le masque écrit les deux-points tout seul : le pavé numérique
            // d'iOS n'en comporte pas (cf. `(app)/_lib/race-time`).
            onChange={(next) =>
              setForm((current) => ({
                ...current,
                time: formatRaceTimeInput(current.time, next),
              }))
            }
            error={state.fieldErrors?.time}
          />
        </div>

        <div>
          <Button
            type="submit"
            variant="secondary"
            disabled={isSaving}
            aria-busy={isSaving}
            className="w-full sm:w-auto"
          >
            {isSaving ? (
              <Loader2 aria-hidden="true" className="animate-spin" />
            ) : (
              <Flag aria-hidden="true" />
            )}
            {isSaving
              ? "Enregistrement…"
              : declared
                ? "Mettre à jour la course"
                : "Déclarer comme course"}
          </Button>
        </div>
      </form>

      {/* Un second formulaire, et non un second bouton du premier : retirer une
          course n'a rien à valider, et ne doit pas emporter la saisie en cours
          si elle est fautive. */}
      {declared ? (
        <form action={removeAction} className="mt-4 border-t border-border pt-4">
          <input type="hidden" name="raceId" value={declaredRaceId} />
          <Button
            type="submit"
            variant="ghost"
            disabled={isRemoving}
            aria-busy={isRemoving}
            className="text-negative"
          >
            {isRemoving ? (
              <Loader2 aria-hidden="true" className="animate-spin" />
            ) : (
              <Trash2 aria-hidden="true" />
            )}
            {isRemoving ? "Retrait…" : "Ce n’était pas une course"}
          </Button>
        </form>
      ) : null}
    </Panel>
  );
}

/** Un champ : libellé, aide, saisie, et l'erreur que le serveur y a placée. */
function RaceField({
  id,
  name,
  label,
  hint,
  value,
  onChange,
  error,
  type = "text",
  inputMode,
  autoComplete = "off",
  className,
}: {
  id: string;
  name: RaceFormField;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  type?: "text" | "date";
  inputMode?: "decimal" | "numeric";
  autoComplete?: string;
  className?: string;
}) {
  return (
    <div className={`min-w-0 flex-1 ${className ?? ""}`}>
      <label htmlFor={id} className="text-[0.85rem] font-medium text-fg">
        {label}
      </label>
      <p id={`${id}-hint`} className="mt-0.5 text-[0.76rem] leading-snug text-fg-faint">
        {hint}
      </p>
      <Input
        id={id}
        name={name}
        type={type}
        inputMode={inputMode}
        // 16 px : en dessous, iOS zoome à la prise de focus et la PWA n'a aucun
        // geste pour revenir en arrière.
        className="mt-1.5 w-full text-base"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        spellCheck={false}
        aria-describedby={error === undefined ? `${id}-hint` : `${id}-hint ${id}-error`}
        aria-invalid={error === undefined ? undefined : true}
      />
      {error === undefined ? null : (
        <p id={`${id}-error`} className="mt-1.5 text-[0.76rem] text-negative">
          {error}
        </p>
      )}
    </div>
  );
}
