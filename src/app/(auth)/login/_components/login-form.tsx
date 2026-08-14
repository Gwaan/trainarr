"use client";

import { useActionState, useId, useState } from "react";
import Link from "next/link";

import { Banner } from "@/components/banner";

import {
  AuthCard,
  AuthField,
  AuthHeading,
  AuthSubmit,
} from "../../_components/auth-form";
import { AUTH_FORM_IDLE, signInAction } from "../../_lib/actions";

/**
 * Écran de connexion.
 *
 * Les champs sont contrôlés : React réinitialise un formulaire non contrôlé une
 * fois l'action terminée, et l'e-mail saisi serait perdu à chaque refus.
 *
 * Aucun message ne distingue « e-mail inconnu » de « mot de passe faux » —
 * c'est l'action qui garantit ce refus unique, l'écran se contente de
 * l'afficher.
 */
export function LoginForm({ bootstrapOpen }: { bootstrapOpen: boolean }) {
  const [state, formAction, isPending] = useActionState(
    signInAction,
    AUTH_FORM_IDLE,
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const uid = useId();

  return (
    <AuthCard>
      <AuthHeading
        title="Connexion"
        subtitle="Tes séances, ton plan et ton coach t'attendent."
      />

      {/* Région live permanente : elle doit exister avant la mise à jour pour
          que le refus soit annoncé aux lecteurs d'écran. */}
      <div
        aria-live="polite"
        className={state.status === "error" ? "mb-4" : "sr-only"}
      >
        {state.status === "error" && state.message ? (
          <Banner tone="negative" title={state.message} />
        ) : null}
      </div>

      {/* La validation est celle de l'action : mêmes messages, même endroit et
          même ton, plutôt que des bulles natives. */}
      <form action={formAction} noValidate className="flex flex-col gap-4">
        <AuthField
          id={`${uid}-email`}
          name="email"
          label="E-mail"
          type="email"
          autoComplete="email"
          error={state.fieldErrors?.email}
          value={email}
          onChange={setEmail}
        />
        <AuthField
          id={`${uid}-password`}
          name="password"
          label="Mot de passe"
          type="password"
          autoComplete="current-password"
          error={state.fieldErrors?.password}
          value={password}
          onChange={setPassword}
        />
        <AuthSubmit
          pending={isPending}
          label="Se connecter"
          pendingLabel="Connexion…"
        />
      </form>

      {bootstrapOpen ? (
        <p className="mt-5 border-t border-border pt-4 text-[0.8rem] leading-relaxed text-fg-muted">
          {"Aucun compte n'existe encore sur cette installation. "}
          <Link
            href="/first-account"
            className="rounded-button font-medium text-fg underline decoration-fg-faint underline-offset-4 transition-colors duration-150 ease-out hover:decoration-fg"
          >
            Créer le premier compte
          </Link>
          .
        </p>
      ) : null}
    </AuthCard>
  );
}
