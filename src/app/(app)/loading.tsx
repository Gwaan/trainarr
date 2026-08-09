import { Skeleton } from "@/components/ui/skeleton";

export default function AppLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Chargement en cours"
      role="status"
      className="flex flex-col gap-5 sm:gap-6"
    >
      <div>
        <Skeleton className="h-3 w-28" />
        <Skeleton className="mt-3 h-8 w-56" />
        <Skeleton className="mt-2.5 h-4 w-72 max-w-full" />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <div className="rounded-card border border-border bg-surface p-4 sm:p-5">
          <Skeleton className="h-2.5 w-24" />
          <Skeleton className="mt-4 h-8 w-20" />
        </div>
        <div className="rounded-card border border-border bg-surface p-4 sm:p-5">
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="mt-4 h-8 w-16" />
        </div>
        <div className="col-span-2 rounded-card border border-border bg-surface p-4 sm:p-5 md:col-span-1">
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="mt-4 h-8 w-16" />
          <Skeleton className="mt-3 h-3 w-40 max-w-full" />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        <div className="rounded-card border border-border bg-surface lg:col-span-2">
          <div className="border-b border-border px-4 py-3 sm:px-5">
            <Skeleton className="h-2.5 w-28" />
          </div>
          <div className="space-y-3 p-4 sm:p-5">
            <Skeleton className="h-7 w-48 max-w-full" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        </div>

        <div className="rounded-card border border-border bg-surface lg:col-span-3">
          <div className="border-b border-border px-4 py-3 sm:px-5">
            <Skeleton className="h-2.5 w-36" />
          </div>
          <div className="p-4 sm:p-5">
            <Skeleton className="h-32 w-full sm:h-40" />
            <Skeleton className="mt-3 h-2.5 w-full" />
          </div>
        </div>
      </div>

      <div className="rounded-card border border-border bg-surface">
        <div className="border-b border-border px-4 py-3 sm:px-5">
          <Skeleton className="h-2.5 w-32" />
        </div>
        <div className="divide-y divide-border">
          {[0, 1, 2].map((row) => (
            <div
              key={row}
              className="flex items-center justify-between gap-3 px-4 py-4 sm:px-5"
            >
              <Skeleton className="h-4 w-40 max-w-[45%]" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      </div>

      <span className="sr-only">Chargement du tableau de bord…</span>
    </div>
  );
}
