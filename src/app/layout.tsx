import type { Metadata, Viewport } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";

import "./globals.css";

/** Display + UI. Variable (400–800), auto-hébergée au build par next/font. */
const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-archivo",
  display: "swap",
});

/** Toutes les valeurs chiffrées (allures, distances, FC, KPIs). */
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Trainarr",
    template: "%s · Trainarr",
  },
  description:
    "Plans d'entraînement, analytics de course à pied et coach IA — le tout auto-hébergé.",
  applicationName: "Trainarr",
};

export const viewport: Viewport = {
  themeColor: "#0A0E16",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="fr"
      className={`${archivo.variable} ${jetbrainsMono.variable} h-full`}
    >
      <body className="min-h-full bg-bg text-fg antialiased">{children}</body>
    </html>
  );
}
