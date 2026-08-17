"use client";

import { useActionState, useId, useState } from "react";
import { Check, Loader2, Mountain } from "lucide-react";

import { Banner } from "@/components/banner";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { saveElevationCorrectionAction } from "../_lib/elevation-correction-actions";
import {
  ELEVATION_CORRECTION_ENABLED_FIELD,
  ELEVATION_CORRECTION_FORM_IDLE,
} from "../_lib/elevation-correction-state";

/**
 * Section « Correction d'altitude ».
 *
 * ## Ce qu'elle règle
 *
 * Uniquement l'estimation de **VO₂max**. Les mètres de D+ affichés sur une
 * séance, eux, sont ceux qui ont été mesurés : rien ici ne les touche.
 *
 * Le calcul est celui de Peter Greif, tel que Runalyze l'applique par défaut :
 * un mètre monté compte comme deux mètres de plat parcourus, un mètre descendu
 * en retire un. La VO₂max d'une sortie vallonnée monte donc légèrement — d'un
 * demi-point sur un footing de 3 km à 32 m de D+, bien davantage en trail.
 *
 * ## Une case et deux nombres, dans un seul formulaire
 *
 * Les trois réglages se lisent ensemble et n'ont de sens qu'ensemble : décocher
 * la case rend les coefficients inertes, changer un coefficient sans l'autre
 * n'est pas plus fréquent que changer les deux. Un bouton « Enregistrer », donc,
 * et pas d'application au clic — c'est aussi ce qui distingue une case à cocher
 * d'un interrupteur dans ce dépôt (cf. `components/ui/switch.tsx`).
 *
 * Les champs sont **contrôlés** : React réinitialise un formulaire non contrôlé
 * à la fin de l'action, et la valeur saisie disparaîtrait au premier message.
 *
 * **Aucun bouton accent ici** : l'accent des réglages est l'enregistrement du
 * profil, et le déplacer d'une section à l'autre ferait de chacune une
 * candidate au même poids visuel.
 */

const INTRO =
  "Sur du dénivelé, ton allure ne dit pas ce que tu vaux : c'est la pente qui te ralentit. Trainarr corrige donc la distance avant d'en tirer une VO₂max — un mètre monté compte comme quelques mètres de plat en plus, un mètre descendu en retire.";

const METHOD_NOTICE =
  "Formule de Peter Greif, avec les réglages par défaut de Runalyze (+2 m par mètre monté, −1 m par mètre descendu). Sans dénivelé connu pour une séance, aucune correction n'est appliquée : sa VO₂max reste celle de sa distance réelle.";

const DISABLED_NOTICE =
  "Correction désactivée : la VO₂max de chaque séance est calculée sur sa distance réelle, dénivelé ignoré.";

/** Repli si l'action échoue sans message — elle en fournit un dans tous ses cas connus. */
const GENERIC_FAILURE = "Le réglage n'a pas été enregistré.";

export type ElevationCorrectionPanelProps = {
  enabled: boolean;
  ascentCoefM: number;
  descentCoefM: number;
};

export function ElevationCorrectionPanel({
  enabled,
  ascentCoefM,
  descentCoefM,
}: ElevationCorrectionPanelProps) {
  const uid = useId();

  const [state, formAction, isSaving] = useActionState(
    saveElevationCorrectionAction,
    ELEVATION_CORRECTION_FORM_IDLE,
  );

  const [checked, setChecked] = useState(enabled);
  const [ascent, setAscent] = useState(String(ascentCoefM));
  const [descent, setDescent] = useState(String(descentCoefM));

  // Le réglage vient d'être enregistré : les props changent, la saisie doit
  // suivre. Ajustement pendant le rendu plutôt qu'en effet — la forme que React
  // recommande pour dériver un état d'un autre.
  const [lastSaved, setLastSaved] = useState({ enabled, ascentCoefM, descentCoefM });
  if (
    lastSaved.enabled !== enabled ||
    lastSaved.ascentCoefM !== ascentCoefM ||
    lastSaved.descentCoefM !== descentCoefM
  ) {
    setLastSaved({ enabled, ascentCoefM, descentCoefM });
    setChecked(enabled);
    setAscent(String(ascentCoefM));
    setDescent(String(descentCoefM));
  }

  return (
    <Panel title="Correction d’altitude">
      <div aria-live="polite" className={state.status === "idle" ? "sr-only" : "mb-4"}>
        {state.status === "success" ? (
          <Banner tone="positive" title={state.message ?? "Réglage enregistré."} />
        ) : null}
        {state.status === "error" ? (
          <Banner tone="negative" title={state.message ?? GENERIC_FAILURE} />
        ) : null}
      </div>

      <form action={formAction} noValidate className="flex flex-col gap-5">
        <p className="text-[0.82rem] leading-relaxed text-fg-muted">{INTRO}</p>

        {checked ? (
          <Banner tone="neutral" title="Comment la correction est calculée">
            {METHOD_NOTICE}
          </Banner>
        ) : (
          <Banner tone="neutral" title="Aucune correction appliquée.">
            {DISABLED_NOTICE}
          </Banner>
        )}

        {/* La case porte le nom du champ, jamais une valeur : décochée, elle
            n'apparaît pas dans le `FormData`, et c'est sa présence qui vaut
            « oui » côté serveur. */}
        <div className="min-w-0">
          <label
            htmlFor={`${uid}-enabled`}
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
              id={`${uid}-enabled`}
              type="checkbox"
              name={ELEVATION_CORRECTION_ENABLED_FIELD}
              checked={checked}
              onChange={(event) => setChecked(event.target.checked)}
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
            <span className="min-w-0">Adapter la VO₂max suivant le dénivelé</span>
          </label>
        </div>

        <div className="flex flex-col gap-4 sm:flex-row sm:gap-5">
          <CoefficientField
            id={`${uid}-ascent`}
            name="ascentCoefM"
            label="Par mètre monté"
            hint="Mètres de distance ajoutés pour chaque mètre de D+. Défaut : 2."
            value={ascent}
            onChange={setAscent}
            disabled={!checked}
            error={state.fieldErrors?.ascentCoefM}
          />
          <CoefficientField
            id={`${uid}-descent`}
            name="descentCoefM"
            label="Par mètre descendu"
            hint="Négatif : une descente raccourcit la distance équivalente. Défaut : −1."
            value={descent}
            onChange={setDescent}
            disabled={!checked}
            error={state.fieldErrors?.descentCoefM}
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
              <Mountain aria-hidden="true" />
            )}
            {isSaving ? "Enregistrement…" : "Enregistrer"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

/**
 * Un coefficient : libellé, aide, saisie.
 *
 * `disabled` grise le champ quand la correction est décochée — mais un champ
 * désactivé n'est **pas** soumis, et le serveur recevrait une valeur manquante
 * là où l'athlète n'a fait que décocher la case. La valeur part donc quand même,
 * en champ caché : elle est conservée telle quelle, prête à resservir au
 * moment où la case sera recochée.
 */
function CoefficientField({
  id,
  name,
  label,
  hint,
  value,
  onChange,
  disabled,
  error,
}: {
  id: string;
  name: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  error?: string;
}) {
  return (
    <div className="min-w-0 flex-1">
      <label htmlFor={id} className="text-[0.85rem] font-medium text-fg">
        {label}
      </label>
      <p id={`${id}-hint`} className="mt-0.5 text-[0.76rem] leading-snug text-fg-faint">
        {hint}
      </p>
      {disabled ? <input type="hidden" name={name} value={value} /> : null}
      <Input
        id={id}
        name={disabled ? undefined : name}
        type="text"
        inputMode="decimal"
        // 16 px : en dessous, iOS zoome à la prise de focus et la PWA n'a aucun
        // geste pour revenir en arrière.
        className="mt-1.5 w-full text-base"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        autoComplete="off"
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
