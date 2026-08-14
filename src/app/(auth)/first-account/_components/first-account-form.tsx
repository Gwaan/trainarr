"use client";

import { useActionState, useId, useState } from "react";

import { Banner } from "@/components/banner";
import { AUTH_PASSWORD_MIN_LENGTH } from "@/lib/auth/limits";

import {
  AuthCard,
  AuthField,
  AuthHeading,
  AuthSubmit,
} from "../../_components/auth-form";
import { AUTH_FORM_IDLE, createFirstAccountAction } from "../../_lib/actions";

/**
 * Création du tout premier compte — l'écran d'une installation neuve.
 *
 * Il n'existe que tant qu'aucun compte n'a été créé : la page qui le rend
 * renvoie vers la connexion dès qu'il y en a un.
 */
export function FirstAccountForm() {
  const [state, formAction, isPending] = useActionState(
    createFirstAccountAction,
    AUTH_FORM_IDLE,
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const uid = useId();

  return (
    <AuthCard>
      <AuthHeading
        title="Créer ton compte"
        subtitle="Personne n'est encore inscrit sur cette installation : ce compte sera le tien. Les suivants se feront sur invitation."
      />

      <div
        aria-live="polite"
        className={state.status === "error" ? "mb-4" : "sr-only"}
      >
        {state.status === "error" && state.message ? (
          <Banner tone="negative" title={state.message} />
        ) : null}
      </div>

      <form action={formAction} noValidate className="flex flex-col gap-4">
        <AuthField
          id={`${uid}-name`}
          name="name"
          label="Nom"
          hint="Celui qui t'accueillera sur le tableau de bord."
          type="text"
          autoComplete="name"
          error={state.fieldErrors?.name}
          value={name}
          onChange={setName}
        />
        <AuthField
          id={`${uid}-email`}
          name="email"
          label="E-mail"
          hint="Il sert d'identifiant de connexion ; aucun message n'y sera envoyé."
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
          hint={`${AUTH_PASSWORD_MIN_LENGTH} caractères minimum. Il n'y a pas de récupération par e-mail : conserve-le.`}
          type="password"
          autoComplete="new-password"
          error={state.fieldErrors?.password}
          value={password}
          onChange={setPassword}
        />
        <AuthSubmit
          pending={isPending}
          label="Créer mon compte"
          pendingLabel="Création…"
        />
      </form>
    </AuthCard>
  );
}
