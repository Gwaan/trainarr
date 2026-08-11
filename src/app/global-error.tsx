"use client";

import { useEffect } from "react";
import { Archivo, JetBrains_Mono } from "next/font/google";
import { CircleAlert, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";

import "./globals.css";

/**
 * Dernier filet : les erreurs que `(app)/error.tsx` ne peut pas attraper parce
 * qu'elles cassent au-dessus de lui — le layout racine, ou la réponse d'une
 * Server Action dont la re-publication RSC échoue.
 *
 * C'est ce qui produisait un écran « page indisponible » brut : sans ce
 * fichier, Next sert sa page d'erreur par défaut, sans un mot de français ni
 * d'issue de secours. Le layout racine étant justement ce qui a pu échouer,
 * cette frontière le remplace : elle porte donc son propre `<html>`/`<body>`,
 * ses fontes et la feuille de tokens.
 */

const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-archivo",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html
      lang="fr"
      className={`${archivo.variable} ${jetbrainsMono.variable} h-full`}
    >
      <body className="min-h-full bg-bg text-fg antialiased">
        <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
          <span className="flex size-14 items-center justify-center rounded-full border border-border bg-surface-2">
            <CircleAlert
              aria-hidden="true"
              strokeWidth={1.6}
              className="size-6 text-negative"
            />
          </span>

          <h1 className="mt-5 text-lg font-semibold text-fg">
            Quelque chose s&apos;est mal passé
          </h1>
          <p className="mt-2 max-w-sm text-sm leading-relaxed text-balance text-fg-muted">
            Recharge la page&nbsp;: si l&apos;application vient d&apos;être mise
            à jour, l&apos;onglet ouvert parlait à la version précédente.
          </p>

          {error.digest ? (
            <p className="num mt-4 text-[0.72rem] text-fg-faint">
              Référence : {error.digest}
            </p>
          ) : null}

          {/*
            Recharger, et pas seulement remonter la frontière : quand le bundle
            de l'onglet ne correspond plus à celui du serveur, `reset()` re-rend
            le même code périmé et échoue à nouveau. Le repli `reset()` reste
            offert en second pour les erreurs passagères, qu'un rechargement
            complet ferait payer plus cher que nécessaire.
          */}
          <div className="mt-6 flex flex-col items-center gap-2 sm:flex-row">
            <Button onClick={() => window.location.reload()}>
              <RotateCw aria-hidden="true" className="size-4" />
              Recharger la page
            </Button>
            <Button variant="ghost" onClick={reset}>
              Réessayer sans recharger
            </Button>
          </div>
        </div>
      </body>
    </html>
  );
}
