import { Banner } from "@/components/banner";

import { resolveStravaBanner } from "../_lib/strava-banner";

/**
 * Bandeau de retour du parcours OAuth.
 *
 * `searchParams` n'est pas awaité dans la page : sous `cacheComponents`, un
 * accès à la donnée de requête hors `<Suspense>` empêcherait le prérendu de la
 * coquille statique (cf. `.claude/rules/nextjs.md`).
 */
export async function StravaStatusBanner({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const banner = resolveStravaBanner((await searchParams).strava);
  if (!banner) return null;

  return (
    <Banner tone={banner.tone} title={banner.title}>
      {banner.description}
      {banner.envVars ? (
        <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
          {banner.envVars.map((name) => (
            <li key={name} className="num text-[0.78rem] text-fg">
              {name}
            </li>
          ))}
        </ul>
      ) : null}
      {banner.action ? (
        // `<a>` et non `next/link` : la cible est un route handler qui redirige
        // vers strava.com, pas une route de l'application.
        <a
          href={banner.action.href}
          className="mt-2 inline-flex text-[0.82rem] font-medium text-fg underline decoration-border underline-offset-4 transition-colors duration-150 ease-out hover:decoration-fg-faint"
        >
          {banner.action.label}
        </a>
      ) : null}
    </Banner>
  );
}
