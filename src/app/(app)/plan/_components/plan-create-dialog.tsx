"use client";

import { useActionState, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, ArrowRight, Loader2, Wand, X } from "lucide-react";

import { Banner } from "@/components/banner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { createPlanAction, type PlanFormState } from "../_lib/actions";
import { PLAN_PROPOSAL_ANCHOR_ID } from "../_lib/anchors";
import {
  PLAN_STEPS,
  SUMMARY_STEP_INDEX,
  firstStepIndexWithError,
  hasPlanFormInput,
  initialPlanFormValues,
  isStepComplete,
  type PlanFormValues,
} from "../_lib/plan-steps";

import { GenerationProgressMeter, useGenerationProgress } from "./generation-progress";
import { PlanStepFields, type PlanDateBounds } from "./plan-form-steps";

/**
 * Création d'un plan, en modale multi-étapes.
 *
 * Le formulaire posait sa dizaine de questions d'un bloc : Gwen a demandé
 * qu'elles arrivent une étape à la fois. La liste des étapes vit dans
 * `_lib/plan-steps.ts` — rien ici ne numérote une étape en dur, et l'insertion
 * de l'étape « Ton chrono » n'a touché que la liste et la phrase d'accueil.
 *
 * Quatre points tiennent tout l'écran :
 *
 * - **Un seul `<form>` englobe toutes les étapes.** Les champs des étapes qu'on
 *   ne regarde pas restent montés, simplement masqués : c'est le DOM qui
 *   fabrique le `FormData`, une étape démontée partirait vide.
 * - **La saisie survit à tout** : elle est contrôlée par cet état-ci, donc à la
 *   navigation entre étapes comme à une génération qui échoue après plusieurs
 *   minutes d'attente.
 * - **La Server Action reste l'autorité.** La validation d'étape ne fait que
 *   retenir « Suivant » sur une étape manifestement incomplète ; les erreurs qui
 *   comptent viennent du serveur, et ramènent l'athlète à l'étape du champ
 *   fautif (cf. `firstStepIndexWithError`).
 * - **Rien ne se déclenche par inadvertance.** Une génération dure des minutes :
 *   le focus repart sur le titre à chaque changement d'étape, les deux boutons
 *   de la barre d'actions portent des `key` distinctes, et `Entrée` dans un
 *   champ ne soumet pas. Corollaire de la même exigence : le retour d'une
 *   génération précédente ne s'affiche pas sur une modale rouverte
 *   (`submittedSinceOpen`).
 */

const PENDING_MESSAGE =
  "Le coach construit ton plan — jusqu'à quelques minutes avec un modèle local.";

const INITIAL_STATE: PlanFormState = { status: "idle" };

const GENERIC_FAILURE = "Le plan n'a pas été généré.";

/** Images d'attente accordées à la proposition pour apparaître, cf. `focusProposal`. */
const PROPOSAL_FOCUS_ATTEMPTS = 10;

/**
 * Pose le focus sur la proposition dès qu'elle est dans le document.
 *
 * Pourquoi pas un effet : à l'adoption du succès, la revalidation remplace le
 * panneau de création par la proposition **dans le même commit**. Ce composant
 * est démonté, aucun de ses effets ne s'exécutera plus — la seule chose qui
 * survive est une continuation planifiée. Elle réessaie tant que la cible n'a
 * pas le focus (au plus dix images, ≈ 160 ms) : ni l'ordre d'arrivée de l'arbre
 * revalidé, ni la restitution du focus que Radix opère en fermant la modale ne
 * sont garantis avant elle. Idempotent, donc sans risque à être joué deux fois.
 */
function focusProposal(attemptsLeft: number): void {
  const target = document.getElementById(PLAN_PROPOSAL_ANCHOR_ID);
  target?.focus();

  if (attemptsLeft > 0 && (target === null || document.activeElement !== target)) {
    requestAnimationFrame(() => focusProposal(attemptsLeft - 1));
  }
}

export type PlanCreateDialogProps = PlanDateBounds;

export function PlanCreateDialog(bounds: PlanCreateDialogProps) {
  const [state, formAction, isPending] = useActionState(createPlanAction, INITIAL_STATE);
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [values, setValues] = useState<PlanFormValues>(() =>
    initialPlanFormValues(bounds.defaultStartDate),
  );
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [handledState, setHandledState] = useState(state);
  /**
   * Un envoi a-t-il eu lieu **depuis cette ouverture-ci** ?
   *
   * `useActionState` garde son état tant que le composant vit, et il vit : la
   * modale se ferme, il reste monté. Sans ce drapeau, rouvrir après un échec
   * ressortirait la bannière rouge et les erreurs de champ d'une génération
   * précédente sur un formulaire vierge.
   */
  const [submittedSinceOpen, setSubmittedSinceOpen] = useState(false);

  const uid = useId();
  const fieldId = (name: string) => `${uid}-${name}`;
  const blockedHintId = `${uid}-blocked`;

  const bodyRef = useRef<HTMLDivElement>(null);
  const stepTitleRef = useRef<HTMLHeadingElement>(null);

  const { submitWithProgress, progress } = useGenerationProgress(isPending, formAction);

  // Ajustement pendant le rendu (pattern React, pas d'effet) : chaque retour
  // d'action est un objet neuf, la comparaison d'identité repère donc aussi deux
  // échecs consécutifs.
  if (state !== handledState) {
    setHandledState(state);
    if (state.status === "success") {
      // La proposition prend la place du formulaire : la modale n'a plus lieu
      // d'être. La saisie, elle, reste — la page va de toute façon se recharger.
      setOpen(false);
      setConfirmingClose(false);
      // Le déclencheur disparaît avec le panneau de création : sans ce
      // déplacement, le focus retombe sur `<body>` et rien n'annonce le plan.
      focusProposal(PROPOSAL_FOCUS_ATTEMPTS);
    } else if (state.status === "error") {
      // Un champ fautif ramène à son étape ; un échec qui n'en désigne aucun
      // (coach injoignable, sortie inexploitable) laisse au récapitulatif, où la
      // bannière explique. Ce retour ne joue que sur un retour d'action neuf,
      // donc jamais sur l'échec d'une session de modale précédente.
      setStepIndex(firstStepIndexWithError(state.fieldErrors) ?? SUMMARY_STEP_INDEX);
    }
  }

  /*
   * Changement d'étape : deux corrections d'un coup.
   *
   * - Sur mobile, une étape longue laisse le corps défilé : la suivante
   *   commencerait à mi-hauteur.
   * - Le focus suit l'étape. Sans cela il reste sur le bouton d'avancement,
   *   qui devient « Générer mon plan » en arrivant au récapitulatif : une
   *   seconde `Entrée` lancerait une génération de plusieurs minutes sans que
   *   rien n'ait été relu. Un lecteur d'écran y gagne aussi le titre de l'étape
   *   où il vient d'arriver.
   *
   * Le titre visé n'existe que modale ouverte : fermée, la référence est nulle
   * et l'appel ne fait rien — c'est ce qui évite de voler le focus à Radix, qui
   * place le sien à l'ouverture.
   */
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
    stepTitleRef.current?.focus();
  }, [stepIndex]);

  const pristine = initialPlanFormValues(bounds.defaultStartDate);
  const activeStep = PLAN_STEPS[stepIndex];
  const isSummary = stepIndex === SUMMARY_STEP_INDEX;
  const canContinue = isStepComplete(activeStep, values);
  // Rien de ce que le serveur a répondu ne s'affiche tant que rien n'a été
  // envoyé depuis l'ouverture : ni bannière, ni erreur de champ.
  const showsFailure = submittedSinceOpen && !isPending && state.status === "error";
  const errors = submittedSinceOpen ? state.fieldErrors : undefined;

  function setValue<K extends keyof PlanFormValues>(field: K, value: PlanFormValues[K]) {
    setValues((previous) => ({ ...previous, [field]: value }));
  }

  function closeAndReset() {
    setOpen(false);
    setConfirmingClose(false);
    setStepIndex(0);
    setValues(initialPlanFormValues(bounds.defaultStartDate));
  }

  /**
   * Toute demande de fermeture passe par ici : croix, `Esc`, clic sur le voile.
   * Une génération en cours ne se ferme pas, et une saisie entamée demande
   * confirmation — plusieurs étapes de réponses ne se perdent pas sur une fausse
   * touche.
   */
  function requestClose() {
    if (isPending) return;
    if (hasPlanFormInput(values, pristine)) {
      setConfirmingClose(true);
      return;
    }
    closeAndReset();
  }

  function handleOpenChange(next: boolean) {
    if (next) {
      setConfirmingClose(false);
      // Nouvelle session de modale : le retour de la dernière génération ne la
      // concerne pas.
      setSubmittedSinceOpen(false);
      setOpen(true);
      return;
    }
    requestClose();
  }

  /** L'envoi passe par ici pour dater la session : le retour du serveur devient affichable. */
  function submit(formData: FormData) {
    setSubmittedSinceOpen(true);
    submitWithProgress(formData);
  }

  function goToStep(next: number) {
    if (next < 0 || next > SUMMARY_STEP_INDEX) return;
    setStepIndex(next);
  }

  /**
   * `Entrée` dans un champ vaut soumission pour le navigateur. Ici, ce serait
   * lancer une génération de plusieurs minutes depuis la première étape : seul le
   * bouton du récapitulatif soumet. Les boutons, eux, gardent leur `Entrée` —
   * c'est ainsi qu'on avance au clavier.
   */
  function blockImplicitSubmit(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key !== "Enter") return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
      event.preventDefault();
    }
  }

  // L'action passe par le hook de progression : il ajoute au `FormData` un
  // identifiant de suivi neuf, tiré par le navigateur, qui ne désigne que
  // l'avancement de cette génération-là (cf. la route `/api/plan-progress`).
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="lg">
          <Wand aria-hidden="true" />
          Créer mon plan
        </Button>
      </DialogTrigger>

      <DialogContent>
        <form
          action={submit}
          noValidate
          onKeyDown={blockImplicitSubmit}
          className="flex min-h-0 flex-1 flex-col"
        >
          <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5">
            <div className="min-w-0">
              <DialogTitle>Créer mon plan</DialogTitle>
              <DialogDescription>
                Cinq étapes : ton objectif, ton profil, ton chrono, tes contraintes, puis la
                relecture.
              </DialogDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Fermer"
              onClick={requestClose}
              disabled={isPending}
              className="-mr-2 shrink-0"
            >
              <X aria-hidden="true" />
            </Button>
          </header>

          <div className="border-b border-border px-4 py-3 sm:px-5">
            {/* L'indicateur parle deux fois : en toutes lettres pour les lecteurs
                d'écran, en abrégé à l'écran. */}
            <p aria-live="polite" className="sr-only">
              Étape {stepIndex + 1} sur {PLAN_STEPS.length} — {activeStep.title}
            </p>
            <p aria-hidden="true" className="eyebrow">
              Étape{" "}
              <span className="num">
                {stepIndex + 1}/{PLAN_STEPS.length}
              </span>
            </p>
            <div aria-hidden="true" className="mt-2 flex gap-1.5">
              {PLAN_STEPS.map((step, index) => (
                <span
                  key={step.id}
                  className={cn(
                    "h-1 flex-1 rounded-full transition-colors duration-150 ease-out",
                    index <= stepIndex ? "bg-accent" : "bg-surface-2",
                  )}
                />
              ))}
            </div>
          </div>

          <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5 sm:py-5">
            {/*
              Région live permanente : elle doit exister avant la mise à jour pour
              que le retour d'action soit annoncé. Sans message, `sr-only` la sort
              du flux, donc de l'espacement de la colonne.

              Pendant l'attente, elle ne porte que la phrase — l'écran, lui,
              affiche le pourcentage juste en dessous, et l'annoncer toutes les
              deux secondes couvrirait tout le reste.
            */}
            <div aria-live="polite" className={showsFailure ? "mb-4" : "sr-only"}>
              {isPending ? <p>{PENDING_MESSAGE}</p> : null}
              {showsFailure ? (
                <Banner tone="negative" title={state.message ?? GENERIC_FAILURE} />
              ) : null}
            </div>

            {/*
              L'attente prend toute la place de l'étape : Gwen ne voyait pas
              avancer sa génération derrière une bannière de trois lignes. Le
              pourcentage est la donnée, il est donc en mono et en grand
              (signature du système), la jauge le double d'un mouvement.

              La rotative n'a pas de garde `prefers-reduced-motion` locale :
              `globals.css` neutralise déjà toutes les animations sous ce
              réglage, et l'icône immobile au-dessus du pourcentage — qui, lui,
              continue de monter — reste un état d'attente lisible.
            */}
            {isPending ? (
              <div
                aria-busy="true"
                className="flex flex-col items-center gap-4 py-6 text-center"
              >
                <Loader2 aria-hidden="true" className="size-12 animate-spin text-accent" />

                <div aria-live="off" className="w-full max-w-[16rem]">
                  {progress === null ? (
                    // Rien n'est encore mesuré : la rotative et la phrase, plutôt
                    // qu'un « 0 % » sur une génération qui n'a pas écrit un mot.
                    // `aria-hidden` parce que la région live ci-dessus porte déjà
                    // ce texte, mot pour mot : c'est elle qui l'annonce, et
                    // l'entendre deux fois de suite n'apprend rien.
                    <p
                      aria-hidden="true"
                      className="text-[0.85rem] leading-relaxed text-fg-muted"
                    >
                      {PENDING_MESSAGE}
                    </p>
                  ) : (
                    <>
                      <p className="num text-[2rem] leading-none font-semibold text-fg">
                        {progress.percent}&nbsp;%
                      </p>
                      <p className="mt-1.5 text-[0.76rem] text-fg-faint">
                        tentative{" "}
                        <span className="num">
                          {progress.attempt}/{progress.maxAttempts}
                        </span>
                      </p>
                      <div className="mt-3">
                        <GenerationProgressMeter percent={progress.percent} />
                      </div>
                    </>
                  )}
                </div>

                <p className="text-[0.8rem] leading-relaxed text-fg-faint">
                  Garde cette fenêtre ouverte : ton plan s&apos;affichera dès qu&apos;il sera écrit.
                </p>
              </div>
            ) : null}

            {confirmingClose ? (
              <Banner tone="neutral" title="Abandonner la création de ton plan ?">
                Tes réponses ne seront pas conservées.
              </Banner>
            ) : null}

            <div hidden={isPending || confirmingClose}>
              {/*
                La `key` change à chaque étape : le bloc est remonté, ce qui rejoue
                l'apparition (`@starting-style`, 150 ms `ease-out`, neutralisée par
                `prefers-reduced-motion`). Les champs sont contrôlés, ils ne
                perdent rien à être remontés.
              */}
              <div
                key={activeStep.id}
                className={cn(
                  "translate-y-0 opacity-100 transition-[opacity,translate] duration-150 ease-out",
                  "starting:translate-y-1 starting:opacity-0",
                )}
              >
                {PLAN_STEPS.map((step, index) => (
                  <section
                    key={step.id}
                    hidden={index !== stepIndex}
                    aria-labelledby={`${uid}-${step.id}-title`}
                  >
                    <h3
                      // Le titre de l'étape affichée reçoit le focus à chaque
                      // changement d'étape : `tabIndex={-1}` le rend focusable
                      // sans l'insérer dans l'ordre de tabulation, et le contour
                      // est inutile puisqu'on n'y arrive jamais au clavier.
                      ref={index === stepIndex ? stepTitleRef : null}
                      tabIndex={-1}
                      id={`${uid}-${step.id}-title`}
                      className="text-[0.95rem] font-semibold text-fg focus:outline-none"
                    >
                      {step.title}
                    </h3>
                    <p className="mt-1 mb-4 text-[0.8rem] leading-snug text-fg-muted">{step.hint}</p>
                    <PlanStepFields
                      step={step}
                      values={values}
                      onChange={setValue}
                      errors={errors}
                      fieldId={fieldId}
                      bounds={bounds}
                    />
                  </section>
                ))}
              </div>

              {canContinue ? null : (
                <p id={blockedHintId} className="mt-4 text-[0.76rem] leading-snug text-fg-faint">
                  Renseigne les champs de cette étape pour continuer.
                </p>
              )}
            </div>
          </div>

          {/* Plein écran sur mobile : la barre d'actions doit dégager l'indicateur
              d'accueil de l'iPhone, sinon « Suivant » tombe dessous. */}
          <div className="flex items-center gap-2 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5 sm:pb-3">
            {confirmingClose ? (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setConfirmingClose(false)}
                >
                  Reprendre la saisie
                </Button>
                <Button type="button" variant="ghost" className="ml-auto" onClick={closeAndReset}>
                  Abandonner
                </Button>
              </>
            ) : (
              <>
                {stepIndex > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={isPending}
                    onClick={() => goToStep(stepIndex - 1)}
                  >
                    <ArrowLeft aria-hidden="true" />
                    Précédent
                  </Button>
                ) : null}

                {/*
                  Deux `key` distinctes, et c'est tout l'objet de leur présence :
                  à la même position, React réutiliserait le nœud DOM, qui garde
                  le focus. Le bouton « Suivant » deviendrait « Générer mon
                  plan » sous le doigt — une seconde `Entrée` (ou un double-clic
                  au même endroit de l'écran) passerait au récapitulatif *puis*
                  lancerait une génération de plusieurs minutes, sans lecture.
                  Avec des clés différentes le nœud est recréé, le focus ne se
                  reporte pas, et il repart sur le titre de l'étape (cf. l'effet
                  de changement d'étape).
                */}
                {isSummary ? (
                  <Button
                    key="submit"
                    type="submit"
                    className="ml-auto"
                    disabled={isPending}
                    aria-busy={isPending}
                  >
                    {isPending ? (
                      <Loader2 aria-hidden="true" className="animate-spin" />
                    ) : (
                      <Wand aria-hidden="true" />
                    )}
                    {isPending ? "Génération en cours…" : "Générer mon plan"}
                  </Button>
                ) : (
                  <Button
                    key="next"
                    type="button"
                    className="ml-auto"
                    disabled={!canContinue}
                    aria-describedby={canContinue ? undefined : blockedHintId}
                    onClick={() => goToStep(stepIndex + 1)}
                  >
                    Suivant
                    <ArrowRight aria-hidden="true" />
                  </Button>
                )}
              </>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
