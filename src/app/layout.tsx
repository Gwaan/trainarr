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
  /**
   * Déclare l'appli installable côté iOS : le titre de l'icône sur l'écran
   * d'accueil, et une barre d'état translucide pour que le fond de la page
   * remonte jusqu'en haut. `capable` couvre les iOS récents, qui lisent le
   * `display` du manifeste ; la balise préfixée ajoutée plus bas couvre les
   * versions antérieures à 17.4.
   */
  appleWebApp: {
    capable: true,
    title: "Trainarr",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#0B0D16",
  colorScheme: "dark",
  /**
   * Sans `viewport-fit=cover`, `env(safe-area-inset-*)` vaut 0 : tout le travail
   * de safe-area de la nav et du layout serait sans effet. En contrepartie, il
   * étend la page sous les zones système — et `black-translucent` fait passer le
   * contenu sous la barre d'état — donc c'est au header et à la bottom-nav de
   * réserver eux-mêmes ces marges (cf. `pt-[env(safe-area-inset-top)]`).
   */
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="fr"
      className={`${archivo.variable} ${jetbrainsMono.variable} h-full`}
    >
      {/* `appleWebApp.capable` n'émet plus que la forme standardisée
          `mobile-web-app-capable` (vérifié dans Next 16). Or iOS antérieur à 17.4
          ne connaît que la variante préfixée et ignore le `display` du manifeste :
          sans cette balise, ces versions ouvriraient l'appli dans Safari.
          React 19 la remonte lui-même dans le `<head>`. */}
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <body className="min-h-full bg-bg text-fg antialiased">{children}</body>
    </html>
  );
}
