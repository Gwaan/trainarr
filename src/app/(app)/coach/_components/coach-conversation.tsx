"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Loader2, MessagesSquare, SendHorizontal } from "lucide-react";

import { COACH_QUESTION_LIMITS } from "@/lib/ai/coach-question";
import { AiSuspendedPanel, type SuspendedAiFeature } from "@/components/ai-suspended-panel";
import { EmptyState } from "@/components/empty-state";
import { MarkdownLite } from "@/components/markdown-lite";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import type { AiUnavailableReason } from "@/lib/ai/errors";
import { cn } from "@/lib/utils";

import { parseRefusal, scanCoachStream } from "../_lib/coach-stream";
import { COACH_THREAD_VIEWPORT_CLASS } from "./coach-thread-viewport";

/**
 * Le fil de discussion avec le coach, et la saisie qui l'alimente.
 *
 * ## Mise en page : un fil borné, une saisie dans le flux
 *
 * Le fil défile chez lui, sous un plafond de hauteur (`COACH_THREAD_VIEWPORT_CLASS`) ;
 * la saisie le suit immédiatement, **dans le flux**. Rien n'est ancré au
 * viewport, et c'est délibéré : le `<main>` de l'appli réserve déjà
 * `pb-[calc(5rem+env(safe-area-inset-bottom))]` pour la bottom-nav `fixed`, et
 * empiler un second élément fixe demanderait d'accorder à la main trois hauteurs
 * (nav, saisie, encoche) qui changent toutes les trois — mais surtout, sur iOS,
 * un élément collant en bas se cale sur le viewport de mise en page, pas sur le
 * viewport visuel, donc passe **sous** le clavier logiciel dès la prise de
 * focus. Borner le fil suffit : la page cesse de grandir d'un écran par échange,
 * et le navigateur amène lui-même la saisie à la vue quand elle prend le focus,
 * ce qu'il sait faire mieux que nous. Le prix — descendre au bas du fil pour
 * écrire — est payé une fois, au montage, par un défilement automatique du fil
 * vers le dernier échange.
 *
 * ## Un tour de parole
 *
 * La question s'affiche immédiatement, la réponse s'écrit au fil de l'eau, et le
 * tour n'entre dans le fil qu'une fois `done` reçu : tant qu'il n'est pas écrit
 * en base, il reste un état local, pas un message. En cas d'échec, il quitte
 * donc l'écran d'un bloc — mais la question revient dans la saisie, prête à être
 * renvoyée d'une touche. Rien n'est perdu, et le fil affiché continue de dire
 * exactement ce que la base contient.
 *
 * Cette dernière phrase est un invariant, tenu des deux côtés : le serveur
 * n'écrit la question qu'avec sa réponse, une fois la génération réussie — une
 * tentative ratée ne laisse donc aucune question orpheline en base — et ce qu'il
 * écrit est très exactement la suite des fragments passés par ici. Le message
 * archivé plus bas est mot pour mot celui que le prochain chargement de la page
 * relira.
 */

export type CoachConversationMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
};

export type CoachConversationProps = {
  /** Le fil déjà en base, du plus ancien au plus récent. */
  messages: readonly CoachConversationMessage[];
  /** `null` quand le coach répond ; sinon, pourquoi il ne répond pas. */
  unavailableReason: AiUnavailableReason | null;
};

/** Un message affiché. `key` est une clé de liste, pas un identifiant métier. */
type ThreadMessage = {
  key: string;
  role: "user" | "assistant";
  content: string;
};

/**
 * Messages d'échec rédigés ici, et pas dans le décodeur : celui-ci signale un
 * flux illisible, l'écran décide de ce que l'athlète en lit. Le message porté
 * par `event: error`, lui, arrive déjà rédigé du serveur et passe tel quel.
 */
const TRANSPORT_ERROR =
  "La demande n'a pas abouti. Le coach est peut-être occupé — réessaie dans un instant.";
const STREAM_ERROR = "La réponse du coach est arrivée illisible. Renvoie ta question.";
const INTERRUPTED_ERROR =
  "La réponse du coach s'est interrompue avant la fin. Renvoie ta question.";

/**
 * Le coach retient sa tête de réponse : les ~200 premiers caractères tombent
 * d'un seul bloc, après un silence qui peut durer. Sans cette phrase, l'écran
 * paraîtrait figé pendant tout ce temps.
 */
const WAITING_NOTE =
  "Le coach relit tes séances. La réponse peut mettre un moment à démarrer.";

/** Tolérance de « l'athlète est au bas du fil », en pixels. */
const NEAR_BOTTOM_PX = 96;

/** Hauteur maximale de la saisie avant qu'elle ne défile d'elle-même. */
const COMPOSER_MAX_HEIGHT_PX = 160;

/**
 * Le compteur de caractères n'apparaît que dans les derniers caractères
 * disponibles. Permanent, il ne dirait rien à qui écrit trois lignes — et une
 * conversation n'est pas un formulaire : la longueur n'y est une information
 * qu'au moment où elle devient une contrainte.
 */
const COUNTER_TAIL_CHARS = 200;

/** Ce que cet écran perd quand le coach ne répond pas. */
const CONVERSATION: SuspendedAiFeature = {
  subject: "Poser une question",
  inline: "la conversation",
};

export function CoachConversation({ messages, unavailableReason }: CoachConversationProps) {
  const [thread, setThread] = useState<ThreadMessage[]>(() =>
    messages.map(({ id, role, content }) => ({ key: String(id), role, content })),
  );
  const [turn, setTurn] = useState<{ question: string; answer: string } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const composerRef = useRef<HTMLTextAreaElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const atBottomRef = useRef(true);
  const wasStreamingRef = useRef(false);

  const streaming = turn !== null;
  const suspended = unavailableReason !== null;
  const empty = thread.length === 0 && !streaming;

  /* Une génération en cours n'a plus de destinataire une fois l'écran quitté. */
  useEffect(() => () => abortRef.current?.abort(), []);

  /*
   * Le fil suit la génération — sauf si l'athlète est remonté relire, auquel cas
   * on ne lui reprend pas la main. Le repère est mis à jour au défilement plutôt
   * que lu à chaque delta : la lecture forcerait un recalcul de mise en page à
   * chaque fragment reçu.
   *
   * L'écouteur est posé sur le fil lui-même, qui défile pour son compte. Il
   * n'existe pas tant que la conversation est vide (un état vide le remplace),
   * d'où la dépendance à `empty` : elle repose l'écouteur au moment où le
   * premier tour fait apparaître le conteneur.
   */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;

    const readPosition = () => {
      const remaining = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      atBottomRef.current = remaining <= NEAR_BOTTOM_PX;
    };

    viewport.addEventListener("scroll", readPosition, { passive: true });
    return () => viewport.removeEventListener("scroll", readPosition);
  }, [empty]);

  /* Au montage, on arrive au dernier échange : c'est ce qu'on vient lire. */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    viewport.scrollTop = viewport.scrollHeight;
    atBottomRef.current = true;
  }, []);

  useEffect(() => {
    if (!atBottomRef.current) return;
    const viewport = viewportRef.current;
    if (viewport === null) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [thread, turn]);

  /* La saisie épouse son contenu, jusqu'à un plafond au-delà duquel elle défile. */
  useEffect(() => {
    const composer = composerRef.current;
    if (composer === null) return;
    composer.style.height = "auto";
    composer.style.height = `${Math.min(composer.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
  }, [draft]);

  /* Fin de génération : la main revient à la saisie, sans un clic. */
  useEffect(() => {
    if (wasStreamingRef.current && !streaming) composerRef.current?.focus();
    wasStreamingRef.current = streaming;
  }, [streaming]);

  async function ask(question: string) {
    const controller = new AbortController();
    abortRef.current = controller;

    setTurn({ question, answer: "" });
    setFailure(null);
    setDraft("");

    /* L'échec rend la question à la saisie plutôt que de la laisser en l'air. */
    const abandon = (message: string) => {
      setTurn(null);
      setFailure(message);
      setDraft(question);
    };

    let response: Response;
    try {
      response = await fetch("/api/coach/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
        signal: controller.signal,
      });
    } catch {
      if (!controller.signal.aborted) abandon(TRANSPORT_ERROR);
      return;
    }

    /*
     * Refus avant ouverture du flux (question hors bornes, coach déjà occupé,
     * cadence trop soutenue) : la route explique elle-même pourquoi, en
     * français. Son message vaut mieux que le nôtre — on ne le remplace que
     * s'il manque.
     */
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      abandon(parseRefusal(payload) ?? TRANSPORT_ERROR);
      return;
    }

    if (response.body === null) {
      abandon(TRANSPORT_ERROR);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let answer = "";
    let outcome: "done" | "failed" | null = null;

    try {
      while (outcome === null) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const scan = scanCoachStream(buffer);
        buffer = scan.rest;

        for (const event of scan.events) {
          if (outcome !== null) break;

          if (event.kind === "delta") {
            answer += event.text;
            setTurn({ question, answer });
          } else if (event.kind === "done") {
            setThread((previous) => [
              ...previous,
              { key: `q-${event.messageId}`, role: "user", content: question },
              { key: String(event.messageId), role: "assistant", content: answer },
            ]);
            setTurn(null);
            outcome = "done";
          } else if (event.kind === "error") {
            abandon(event.message);
            outcome = "failed";
          } else {
            abandon(STREAM_ERROR);
            outcome = "failed";
          }
        }
      }
    } catch {
      if (controller.signal.aborted) return;
      abandon(TRANSPORT_ERROR);
      return;
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    // Flux clos sans verdict : la réponse est tronquée, on ne l'archive pas.
    if (outcome === null) abandon(INTERRUPTED_ERROR);
  }

  function send() {
    const question = draft.trim();
    if (question === "" || streaming || suspended) return;
    void ask(question);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    send();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    // Une méthode de saisie (dictée, accents) valide sa composition par Entrée :
    // ce n'est pas un envoi.
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  }

  /*
   * Confort de saisie, et rien d'autre : `maxLength` évite d'écrire une
   * question que la route refuserait en 400, le compteur dit pourquoi la frappe
   * s'arrête. La route et le service revalident, seuls à faire autorité (cf.
   * `.claude/rules/security.md`). Le compte porte sur le texte brut là où le
   * serveur mesure le texte détouré : plus strict d'un espace de fin, jamais
   * plus permissif.
   */
  const nearLimit = draft.length >= COACH_QUESTION_LIMITS.max - COUNTER_TAIL_CHARS;
  const atLimit = draft.length >= COACH_QUESTION_LIMITS.max;

  return (
    <>
      <Panel title="Conversation" padded={false}>
        {empty ? (
          /* Coach éteint : rien à inviter à écrire, la saisie n'est pas là. */
          <EmptyState
            icon={MessagesSquare}
            title={suspended ? "Pas encore de conversation" : "Pose ta première question"}
            description={
              suspended
                ? "Le fil s'ouvrira ici dès que le coach sera de nouveau joignable."
                : "Charge, forme, allure, séance du jour : le coach répond à partir de tes séances importées et de ton plan en cours."
            }
          />
        ) : (
          /*
            Région à défilement : sans `tabIndex`, Safari et Chrome n'y donnent
            aucun accès au clavier — on ne pourrait pas lire un fil long sans
            souris ni doigt. Un nom l'accompagne, comme pour tout point d'arrêt
            de tabulation.
          */
          <div
            ref={viewportRef}
            role="region"
            aria-label="Fil de la conversation"
            tabIndex={0}
            className={COACH_THREAD_VIEWPORT_CLASS}
          >
            {thread.map((message) =>
              message.role === "user" ? (
                <AthleteMessage key={message.key} content={message.content} />
              ) : (
                <CoachMessage key={message.key} content={message.content} />
              ),
            )}

            {turn === null ? null : (
              <>
                <AthleteMessage content={turn.question} />
                {/*
                  Région live montée vide au moment où la question part, donc
                  bien avant le premier fragment : c'est la condition pour
                  qu'un lecteur d'écran annonce ce qui s'y écrit ensuite.

                  Pas d'`aria-busy` ici, à dessein : posé sur une région live, il
                  demande aux technologies d'assistance de **retenir** les
                  annonces jusqu'à son passage à `false` — or cette région
                  disparaît à la fin du tour, remplacée par le message archivé.
                  La réponse ne serait donc jamais annoncée. L'état occupé se dit
                  sur ce qui reste à l'écran : le formulaire de saisie.
                */}
                <div aria-live="polite">
                  <CoachMessage content={turn.answer} busy />
                </div>
              </>
            )}
          </div>
        )}

        {suspended ? null : (
          <form
            onSubmit={handleSubmit}
            aria-busy={streaming}
            className="border-t border-border p-4 sm:p-5"
          >
            {failure === null ? null : (
              <p role="alert" className="mb-3 text-[0.78rem] leading-snug text-negative">
                {failure}
              </p>
            )}

            <label htmlFor="coach-question" className="sr-only">
              Ta question au coach
            </label>
            <textarea
              id="coach-question"
              ref={composerRef}
              rows={1}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
              disabled={streaming}
              maxLength={COACH_QUESTION_LIMITS.max}
              placeholder="Pose ta question au coach…"
              className={cn(
                "block w-full resize-none overflow-y-auto rounded-button border border-border bg-surface-2 px-3 py-2.5",
                // 16 px au minimum (`text-base`) : en dessous, iOS zoome la page
                // à la prise de focus, et en PWA `standalone` rien ne permet d'en
                // revenir — la page reste plus large que l'écran.
                "text-base leading-relaxed text-fg",
                "transition-colors duration-150 ease-out",
                "placeholder:text-fg-faint hover:border-fg-faint/35",
                "disabled:pointer-events-none disabled:opacity-55",
              )}
            />

            <div className="mt-3 flex items-center justify-end gap-3">
              {/*
                Monté en permanence, vide loin de la limite : une région live
                ajoutée à l'écran au moment où elle se remplit n'est pas
                annoncée (même raison que la région de réponse plus haut). Le
                chiffre, lui, est masqué aux technologies d'assistance — il
                changerait à chaque frappe, et la frappe est déjà annoncée ;
                seul le passage à la limite se dit, une fois.
              */}
              <p aria-live="polite" className="text-[0.72rem] leading-snug text-fg-faint">
                {nearLimit ? (
                  <span
                    aria-hidden="true"
                    className={cn("num", atLimit && "text-warning")}
                  >
                    {draft.length} / {COACH_QUESTION_LIMITS.max}
                  </span>
                ) : null}
                {atLimit ? (
                  <span className="sr-only">
                    Limite atteinte : {COACH_QUESTION_LIMITS.max} caractères.
                  </span>
                ) : null}
              </p>
              <p className="hidden text-[0.72rem] leading-snug text-fg-faint sm:block">
                Entrée envoie, Maj + Entrée passe à la ligne.
              </p>
              <Button
                type="submit"
                disabled={streaming || draft.trim() === ""}
                aria-busy={streaming}
              >
                {streaming ? (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                ) : (
                  <SendHorizontal aria-hidden="true" />
                )}
                {streaming ? "Le coach répond…" : "Envoyer"}
              </Button>
            </div>
          </form>
        )}
      </Panel>

      {unavailableReason === null ? null : (
        <AiSuspendedPanel
          reason={unavailableReason}
          panelTitle="Coach suspendu"
          feature={CONVERSATION}
        />
      )}
    </>
  );
}

/** Une question. Bulle alignée à droite : c'est la voix de l'athlète. */
function AthleteMessage({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] rounded-card border border-border bg-surface-2 px-3.5 py-2.5 text-[0.85rem] leading-relaxed break-words whitespace-pre-wrap text-fg">
        <span className="sr-only">Ta question : </span>
        {content}
      </p>
    </div>
  );
}

/**
 * Une réponse. Pleine largeur et sans bulle : le coach écrit des titres et des
 * listes, que `MarkdownLite` rend avec sa propre typographie — les enfermer dans
 * une bulle étroite les rendrait illisibles.
 */
function CoachMessage({ content, busy = false }: { content: string; busy?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="eyebrow flex items-center gap-1.5">
        Coach
        {busy ? <Loader2 aria-hidden="true" className="size-3 animate-spin text-accent" /> : null}
      </p>
      {content === "" ? (
        <p className="text-[0.85rem] leading-relaxed text-fg-muted">{WAITING_NOTE}</p>
      ) : (
        <MarkdownLite source={content} />
      )}
    </div>
  );
}
