"use client";

import { useActionState, useId, useState } from "react";
import { Check, Copy, Loader2, MailPlus, X } from "lucide-react";

import { Banner } from "@/components/banner";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  createInvitationAction,
  revokeInvitationAction,
} from "../_lib/invitation-actions";
import {
  INVITATION_FORM_IDLE,
  REVOKE_FORM_IDLE,
} from "../_lib/invitation-state";
import type { InvitationRow } from "../_lib/invitation-values";

/**
 * Section « Inviter quelqu'un » — réservée au premier compte.
 *
 * Elle n'est **pas rendue du tout** pour les autres : c'est l'appelant qui
 * décide (`data.invitations.canInvite`), et le DAL qui refuserait de toute
 * façon. Une section grisée dirait à un compte invité qu'il existe une
 * administration dont il est écarté ; il n'y a rien à lui dire.
 *
 * **Aucun bouton accent ici**, comme dans les autres sections des réglages :
 * l'accent de cet écran est l'enregistrement du profil. Émettre un lien est une
 * action d'administration occasionnelle, pas le geste principal de la modale.
 */

/**
 * Le lien complet, construit **côté navigateur** : le serveur ne rend que le
 * chemin, et n'a donc pas à deviner sous quel nom de domaine il est joint.
 *
 * Le repli sur le chemin nu ne sert qu'au rendu serveur, où `window` n'existe
 * pas — et où cet état ne peut de toute façon pas exister, puisqu'il naît d'une
 * action déclenchée dans le navigateur.
 */
function absoluteLink(path: string): string {
  if (typeof window === "undefined") return path;
  return new URL(path, window.location.origin).toString();
}

/**
 * Le lien fraîchement émis, montré **une seule fois**.
 *
 * Il vit dans l'état du formulaire, jamais en base : refermer la modale ou
 * recharger la page le perd définitivement — c'est le propre d'un secret dont
 * seule l'empreinte est conservée. D'où le champ en lecture seule, sélectionnable
 * au doigt, à côté du bouton de copie : si le presse-papiers est refusé
 * (contexte non sécurisé, permission), il reste la sélection manuelle.
 */
function IssuedLink({ path, expiresLabel }: { path: string; expiresLabel: string }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const link = absoluteLink(path);
  const uid = useId();

  const copy = () => {
    navigator.clipboard.writeText(link).then(
      () => {
        setCopied(true);
        setCopyFailed(false);
      },
      () => {
        setCopied(false);
        setCopyFailed(true);
      },
    );
  };

  return (
    <div className="mt-4 rounded-card border border-border bg-surface-2 p-3">
      <label
        htmlFor={`${uid}-link`}
        className="block text-[0.85rem] font-medium text-fg"
      >
        Lien à transmettre
      </label>
      <p id={`${uid}-hint`} className="mt-1 text-[0.76rem] leading-snug text-fg-faint">
        Il n&apos;est affiché qu&apos;ici et qu&apos;une fois : ferme cette vue et
        il est perdu. Valable jusqu&apos;au {expiresLabel}, une seule création de
        compte.
      </p>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        {/* `text-base` : en dessous de 16 px, iOS zoome à la prise de focus. */}
        <Input
          id={`${uid}-link`}
          readOnly
          value={link}
          aria-describedby={`${uid}-hint`}
          onFocus={(event) => event.currentTarget.select()}
          className="font-mono text-base"
        />
        <Button
          type="button"
          variant="secondary"
          onClick={copy}
          className="shrink-0 sm:w-auto"
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? "Copié" : "Copier"}
        </Button>
      </div>
      <p aria-live="polite" className="sr-only">
        {copied ? "Lien copié dans le presse-papiers." : ""}
      </p>
      {copyFailed ? (
        <p className="mt-2 text-[0.76rem] leading-snug text-fg-muted">
          La copie automatique a été refusée par le navigateur — sélectionne le
          lien ci-dessus pour le copier à la main.
        </p>
      ) : null}
    </div>
  );
}

/** Révoque un lien en cours. Un succès fait disparaître la ligne, il n'a rien à annoncer. */
function RevokeForm({ invitation }: { invitation: InvitationRow }) {
  const [state, formAction, isPending] = useActionState(
    revokeInvitationAction,
    REVOKE_FORM_IDLE,
  );

  return (
    <form action={formAction} className="shrink-0">
      <input type="hidden" name="invitationId" value={invitation.id} />
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        disabled={isPending}
        aria-busy={isPending}
        aria-label={`Révoquer le lien valable jusqu'au ${invitation.expiresLabel}`}
      >
        {isPending ? (
          <Loader2 aria-hidden="true" className="animate-spin" />
        ) : (
          <X aria-hidden="true" />
        )}
        Révoquer
      </Button>
      <p aria-live="polite" className={state.status === "error" ? "mt-1" : "sr-only"}>
        {state.status === "error" ? (
          <span className="text-[0.74rem] leading-snug text-negative">
            {state.message}
          </span>
        ) : null}
      </p>
    </form>
  );
}

/** Les liens encore ouverts, du plus proche au plus lointain. */
function PendingList({ invitations }: { invitations: InvitationRow[] }) {
  if (invitations.length === 0) {
    return (
      <div className="mt-5 flex flex-col items-start gap-2 border-t border-border pt-5">
        <MailPlus aria-hidden="true" strokeWidth={1.6} className="size-5 text-fg-faint" />
        <p className="text-[0.8rem] leading-relaxed text-fg-muted">
          Aucun lien en cours. Le bouton ci-dessus en crée un.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-5 border-t border-border pt-5">
      <h3 className="text-[0.9rem] font-semibold text-fg">Liens en cours</h3>
      <ul className="mt-3 flex flex-col gap-2">
        {invitations.map((invitation) => (
          <li
            key={invitation.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-button border border-border bg-surface-2 px-3 py-2"
          >
            <span className="text-[0.8rem] text-fg-muted">
              Valable jusqu&apos;au{" "}
              <span className="font-mono text-fg tabular-nums">
                {invitation.expiresLabel}
              </span>
            </span>
            <RevokeForm invitation={invitation} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export type InvitationsPanelProps = {
  invitations: InvitationRow[];
};

export function InvitationsPanel({ invitations }: InvitationsPanelProps) {
  const [state, formAction, isPending] = useActionState(
    createInvitationAction,
    INVITATION_FORM_IDLE,
  );

  return (
    <Panel title="Inviter quelqu'un">
      <p className="text-[0.85rem] leading-relaxed text-fg-muted">
        Les inscriptions sont fermées : un lien temporaire est le seul moyen de
        créer un compte sur cette installation. Chaque lien ne sert qu&apos;une
        fois et expire de lui-même.
      </p>

      <div
        aria-live="polite"
        className={state.status === "error" ? "mt-4" : "sr-only"}
      >
        {state.status === "error" ? (
          <Banner tone="negative" title={state.message} />
        ) : null}
      </div>

      <form action={formAction} className="mt-4">
        <Button
          type="submit"
          variant="secondary"
          disabled={isPending}
          aria-busy={isPending}
          className="w-full sm:w-auto"
        >
          {isPending ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <MailPlus aria-hidden="true" />
          )}
          {isPending ? "Création…" : "Créer un lien d'invitation"}
        </Button>
      </form>

      {state.status === "created" ? (
        <IssuedLink path={state.path} expiresLabel={state.expiresLabel} />
      ) : null}

      <PendingList invitations={invitations} />
    </Panel>
  );
}
